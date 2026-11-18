// Receiver webhook untuk bot-baru — STAGING, belum auto-credit saldo.
// - Gateway: POST /webhook-gateway, format gateway (X-Webhook-Signature
//   sha256= + HMAC-SHA256 body mentah dengan WEBHOOK_SECRET).
//   Ping (event webhook.ping) dibalas 2xx agar validasi pendaftaran gateway lolos.
//   payment.success HANYA dicatat + diberitahukan ke admin, TIDAK langsung
//   menambah saldo, karena tabel deposits belum punya pemetaan reference QRIS
//   ke user. Admin tetap approve seperti deposit manual — anti salah kredit.
// - Digiflazz: POST /webhook-digiflazz, dicatat + diberitahukan ke admin.
//   Digiflazz TIDAK punya API untuk membuat webhook otomatis; URL ini hanya
//   untuk ditempel manual di member.digiflazz.com, plus whitelist IP Digiflazz.
// - Dedupe: delivery id + transaction_id, anti proses ganda saat retry.
// - Server loopback saja (127.0.0.1:WEBHOOK_PORT). URL publik baru jalan
//   setelah nginx menambahkan location /webhook-* -> port ini.
const http = require('http');
const crypto = require('crypto');

function verifySignature(secret, raw, sig) {
  if (!secret) return false; // tanpa secret, tolak (fail-closed): event pembayaran tanpa verifikasi tidak boleh lolos. Ping tanpa signature tetap ditangani terpisah di bawah.
  if (!sig || !sig.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); }
  catch { return false; }
}
// Verifikasi Digiflazz: header bisa X-Hub-Signature atau
// X-Digiflazz-Signature, nilai bisa hex polos atau sha256=hex.
// Format resmi buyer webhook tidak terkonfirmasi penuh dari dok resmi
// (dok seller berbeda); jadi: signature ada + tidak cocok = 403,
// signature tidak ada = terima dengan peringatan (agar pengiriman
// Digiflazz tidak putus hanya karena format header berbeda).
function verifyDigiflazzSignature(secret, raw, headers) {
  if (!secret) return { ok: true, checked: false };
  const sig = headers['x-hub-signature'] || headers['x-digiflazz-signature'] || headers['x-webhook-signature'] || '';
  if (!sig) return { ok: true, checked: false, missing: true };
  const hex = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const candidates = [hex, 'sha256=' + hex];
  if (candidates.includes(sig.trim())) return { ok: true, checked: true };
  return { ok: false, checked: true };
}

function createWebhookServer({ port, secret, digiflazzSecret, digiflazzActive, onNotify, onDigiflazz, onGatewayPayment, onGatewayExpired }) {
  const seen = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      const url = req.url || '';
      const isGateway = url.startsWith('/webhook-gateway');
      const isDigiflazz = url.startsWith('/webhook-digiflazz');
      if (req.method === 'GET' && (isGateway || isDigiflazz)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'pong' }));
        return;
      }
      if (req.method !== 'POST' || (!isGateway && !isDigiflazz)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not_found' }));
        return;
      }
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      if (isGateway) {
        const sig = req.headers['x-webhook-signature'];
        // Secret gateway juga dibaca sebagai getter (seperti Digiflazz),
        // supaya ganti secret lewat Admin Telegram berlaku tanpa restart.
        const secretNow = typeof secret === 'function' ? secret() : secret;
        // PERBAIKAN 2026-11-02 (screenshot halaman /webhook gateway):
        // Pendaftaran MANUAL di halaman gateway membiarkan "Kunci tanda
        // tangan" KOSONG (opsional), lalu gateway mengirim ping validasi
        // TANPA signature. Bot lama menolak ping tanpa signature dengan
        // 403, sehingga gateway menampilkan "validation failed: HTTP 403"
        // padahal receiver hidup dan URL benar. Ping hanya liveness check,
        // tidak mengubah saldo/state, jadi ping TANPA signature boleh
        // lolos (200 pong). Ping DENGAN signature yang salah tetap 403,
        // dan event pembayaran (payment.success/expired) tetap WAJIB
        // signature benar — jadi webhook palsu tetap tidak bisa kirim
        // pembayaran palsu.
        if (body.event === 'webhook.ping' && !sig) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'pong' }));
          return;
        }
        if (!verifySignature(secretNow, raw, sig)) {
          // Log tanpa nilai secret/signature, supaya 403 berikutnya bisa
          // dilacak di PM2 log: penyebabnya hampir selalu secret yang
          // dikirim pendaftar webhook tidak sama dengan WEBHOOK_SECRET bot.
          console.warn(`[webhook] 403 bad_signature gateway: sig_present=${Boolean(sig)} sig_format=${sig && sig.startsWith('sha256=') ? 'sha256=' : 'lain/tidak-ada'} event=${body.event || '-'}`);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad_signature' }));
          return;
        }
        const delivery = req.headers['x-webhook-delivery'] || '';
        const txId = body?.data?.transaction_id || body?.data?.transaction || '';
        const dedupeKey = delivery + '|' + txId + '|' + (body.event || '');
        if (delivery && seen.has(dedupeKey)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'duplicate_ignored' }));
          return;
        }
        if (delivery) { seen.add(dedupeKey); if (seen.size > 5000) seen.clear(); }
        if (body.event === 'webhook.ping') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'pong' }));
          return;
        }
        if (body.event === 'payment.success') {
          const d = body.data || {};
          // Auto-credit di app.js (cocokkan reference/qris_id -> deposit).
          // Bila tidak ada deposit yang cocok (mis. event uji, atau deposit
          // dari sistem lain), JANGAN kredit — hanya beri tahu admin.
          let handled = false;
          if (onGatewayPayment) { try { handled = await onGatewayPayment(d); } catch (e) { console.warn('[webhook] onGatewayPayment error:', e.message); } }
          if (!handled) onNotify && onNotify(`🔔 Webhook Gateway payment.success (tidak ada deposit bot yang cocok, TIDAK dikredit)\nNominal: Rp${Number(d.amount || 0).toLocaleString('id-ID')}\nReference: ${d.reference || '-'}\nQRIS: ${d.qris_id || '-'}\nTransaksi: ${d.transaction || d.transaction_id || '-'}`);
        } else if (body.event === 'payment.expired') {
          const d = body.data || {};
          let handled = false;
          if (onGatewayExpired) { try { handled = await onGatewayExpired(d); } catch (e) { console.warn('[webhook] onGatewayExpired error:', e.message); } }
          if (!handled) onNotify && onNotify(`⏰ Webhook Gateway payment.expired\nReference: ${d.reference || '-'}\nQRIS: ${d.qris_id || '-'}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'received' }));
        return;
      }
      // Digiflazz buyer webhook — form lengkap dashboard:
      // Webhook ID, Payload URL, Content type application/json, Secret, Aktif.
      // Event yang dikenal dari SDK: ping (hook_id), create, update.
      // Payload transaksi: ref_id + status (Sukses/Gagal/Pending).
      const dgSecretNow = typeof digiflazzSecret === 'function' ? digiflazzSecret() : digiflazzSecret;
      const dgCheck = verifyDigiflazzSignature(dgSecretNow, raw, req.headers);
      if (!dgCheck.ok) {
        console.warn(`[webhook] 403 bad_signature digiflazz: sig_present=${Boolean(req.headers['x-hub-signature'] || req.headers['x-digiflazz-signature'] || req.headers['x-webhook-signature'])} event=${event || '-'}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad_signature' }));
        return;
      }
      const dgActive = typeof digiflazzActive === 'function' ? digiflazzActive() : digiflazzActive;
      if (dgActive === false) {
        // Toggle bot Non Aktif: jawab 200 agar Digiflazz tidak menonaktifkan
        // hook, tapi jangan proses order.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'ignored_inactive' }));
        return;
      }
      const event = body.event || body.type || '';
      const data = body.data || body.payload || body;
      const refId = data.ref_id || data.refId || body.ref_id || '';
      const dgStatus = data.status || data.message || '';
      const hookId = data.hook_id || body.hook_id || '';
      if (event === 'ping' || event === 'webhook.ping' || hookId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'pong', hook_id: hookId || undefined }));
        onNotify && onNotify(`🔔 Ping webhook Digiflazz diterima${hookId ? ' (hook_id terisi)' : ''}. Receiver bot jalan.`);
        return;
      }
      if (refId) {
        onDigiflazz && onDigiflazz(event, { ref_id: refId, status: dgStatus, raw: body });
      } else {
        onNotify && onNotify(`🔔 Callback Digiflazz diterima (tanpa ref_id, tidak diproses ke order):\n${JSON.stringify(body).slice(0, 500)}${dgCheck.missing ? '\n⚠️ Peringatan: signature tidak ada di header — samakan secret bot dengan secret di dashboard Digiflazz.' : ''}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'received' }));
    });
  });
  return { server, listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)) };
}

module.exports = { createWebhookServer, verifySignature };
