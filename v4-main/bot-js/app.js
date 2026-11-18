// ============================================================
// 🤖 RIPZZ VPN BOT (@Notif2Ajibot)
// Bot Telegram VPN + PPOB — Node.js + Telegraf
//
// Fitur:
//  • VPN: SSH, VMess, VLess, Trojan (+ mode CloudFront)
//  • Trial / Create / Renew / Akun Saya
//  • PPOB: deposit QRIS, saldo, beli pulsa/paket (Digiflazz)
//  • Cek kuota HP (Sidompul)
//  • Admin: broadcast, tambah saldo, statistik, auto-cleanup
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { Telegraf, Markup } = require('telegraf');
const config = require('./src/config');
// Grup wajib join & grup notifikasi
const GROUP_WAJIB = ''; // Grup wajib diatur via panel admin; kosong = tidak ada grup wajib bawaan
const GROUP_NOTIF = ''; // ID grup notifikasi diatur via panel admin; kosong = notifikasi grup nonaktif
const { init: initDb } = require('./src/db');
const vpn = require('./modules/vpn');
const srvTools = require('./modules/servers');
const installServer = require('./src/install-server');
const liveServer = require('./src/live-server');
const country = require('./src/country');
const apiSettings = require('./src/api-settings');
const ppob = require('./modules/ppob');
const h2h = require('./src/h2h');
const kuota = require('./modules/kuota');
const admin = require('./modules/admin');
const cleanup = require('./modules/cleanup');
const sewa = require('./modules/sewa');
const ipregistry = require('./modules/ipregistry');
const hc = require('./modules/hc');
const settings = require('./modules/settings');
// Grup wajib join & grup notifikasi — dikonfigurasi via panel admin (tabel bot_settings).
// Fallback ke nilai lama agar tidak blokir user bila belum dikonfigurasi.
const hcCache = new Map(); // userId_proto_username -> {proto, username, uuid, password}
const exportCache = new Map(); // kunci sama -> {proto, username, uuid, password, domain, links, saveUrl, exp, method}
const prodCache = new Map(); // userId -> {pageItems: [...], page}
const digi = require('./src/digiflazz');
const { esc } = require('./src/format');
const ppobLayout = require('./src/ppob-layout');

if (!config.botToken) {
  console.error('❌ BOT_TOKEN belum diisi di .env');
  process.exit(1);
}

const bot = new Telegraf(config.botToken);
const BOT_START_TIME = Date.now(); // untuk hitung uptime di /start
const sessions = new Map(); // chatId -> { step, data }
const lastMenus = new Map();
// Persistensi menu terakhir (tahan restart): userId -> messageId.
const LAST_MENUS_FILE = path.join(__dirname, 'data', 'last-menus.json');
function saveLastMenus() {
  try { fs.writeFileSync(LAST_MENUS_FILE, JSON.stringify([...lastMenus])); } catch (_) {}
}
try {
  for (const [k, v] of JSON.parse(fs.readFileSync(LAST_MENUS_FILE, 'utf8'))) lastMenus.set(Number(k), v);
} catch (_) {}
// Helper aman untuk answerCbQuery (thrown sync oleh Telegraf bila bukan callback_query)
const safeCb = async (ctx, text) => {
  try { await ctx.answerCbQuery(text || undefined); } catch (e) { /* ignore */ }
};
// Helper tombol berwarna (Bot API 9.4+: primary=biru, success=hijau, danger=merah)
const sBtn = (text, data, style) => {
  const b = Markup.button.callback(text, data);
  if (style) b.style = style;
  return b;
};

 // userId -> messageId (menu bergambar terakhir)
const ASSETS_DIR = path.join(__dirname, 'assets');

// ---------- Helper: kirim menu bergambar (ala BotVPN2) ----------
async function sendMenuPhotoInner(ctx, imageFile, caption, keyboard) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const imgPath = path.join(ASSETS_DIR, imageFile);
  const replyMarkup = keyboard.reply_markup || keyboard;

  // hapus menu lama
  if (userId && lastMenus.has(userId)) {
    try { await ctx.telegram.deleteMessage(chatId, lastMenus.get(userId)); } catch (e) {}
    lastMenus.delete(userId);
  }
  saveLastMenus();

  // jika dari callback query, hapus pesan callback dulu
  if (ctx.updateType === 'callback_query' && ctx.callbackQuery?.message?.message_id) {
    try { await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id); } catch (e) {}
  }

  let sent = null;
  try {
    if (fs.existsSync(imgPath)) {
      sent = await ctx.replyWithPhoto(
        { source: fs.createReadStream(imgPath) },
        { caption, parse_mode: 'HTML', reply_markup: replyMarkup }
      );
    } else {
      throw new Error('gambar tidak ada');
    }
  } catch (e) {
    // fallback ke teks biasa
    sent = await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: replyMarkup });
  }
  if (userId && sent?.message_id) lastMenus.set(userId, sent.message_id);
  saveLastMenus();
  return sent;
}

const menuLocks = new Map();
// Serialisasi per user: tap ganda tidak bisa membuat dua menu sekaligus.
async function sendMenuPhoto(...args) {
  const ctx = args[0];
  const userId = ctx.from?.id;
  if (!userId) return sendMenuPhotoInner(...args);
  const prev = menuLocks.get(userId) || Promise.resolve();
  const cur = prev.then(() => sendMenuPhotoInner(...args));
  menuLocks.set(userId, cur.catch(() => {}));
  return cur;
}

// ---------- Helper ----------
const mainMenu = (isAdmin = false, isReseller = false) => {
  // Slim & rapi: 2 tombol per baris, label pendek — menu utama muat dalam
  // 4-5 baris walau ada panel reseller/admin. Callback tidak berubah.
  const rows = [
    [sBtn('🌐 VPN', 'menu_vpn_home', 'success'), sBtn('🛒 PPOB', 'menu_ppob', 'primary')],
    [sBtn('💰 Top Up', 'ppob_deposit', 'success'), sBtn('📝 Riwayat', 'menu_riwayat', 'primary')],
    [sBtn('🚀 Cek Kuota', 'menu_kuota', 'primary'), sBtn('📜 Sewa Script', 'menu_sewa', 'primary')],
    [sBtn('📊 Statistik', 'menu_stat', 'primary'), sBtn('👤 Akun Saya', 'menu_akun', 'primary')],
  ];
  const panels = [];
  if (isReseller) panels.push(sBtn('🏪 Reseller', 'menu_reseller', 'success'));
  if (isAdmin) panels.push(sBtn('🛠️ Admin', 'adm_open', 'danger'));
  if (panels.length) rows.push(panels);
  return Markup.inlineKeyboard(rows);
};

const backBtn = () => Markup.inlineKeyboard([[sBtn('🔙 Kembali', 'menu_main', 'danger')]]);

// Tombol Batal untuk sesi input — tekan -> sesi dihapus -> kembali ke menu
const cancelKb = () => ({ reply_markup: Markup.inlineKeyboard([[sBtn('❌ Batal', 'cancel_flow', 'danger')]]).reply_markup });

// ---------- Batal Sesi Input ----------
async function goMainMenu(ctx) {
  const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
  const isAdm = await admin.hasAdminAccess(ctx).catch(() => false);
  await sendMenuPhoto(ctx, 'banner-utama.webp',
    await buildWelcomeCaption(ctx),
    mainMenu(isAdm, role === 'reseller'));
}

bot.action('cancel_flow', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await safeCb(ctx, '❌ Dibatalkan');
  try {
    await ctx.editMessageText('❌ <b>Dibatalkan.</b>', { parse_mode: 'HTML' });
  } catch (_) {}
  await goMainMenu(ctx);
});

// ---------- Panel Admin ----------
const adminPanel = () => Markup.inlineKeyboard([
  [sBtn('➕ Tambah Server', 'adm_addserver', 'success'), sBtn('❌ Hapus Server', 'adm_delserver', 'danger')],
  [sBtn('🖥️ Install Server Baru', 'adm_installsrv', 'success'), sBtn('📊 Monitoring Server', 'adm_monitor', 'success')],
  [sBtn('🔄 Install Ulang Server', 'adm_reinstallsrv', 'primary'), sBtn('🗑️ Uninstall Server', 'adm_uninstallsrv', 'danger')],
  [sBtn('💲 Edit Harga', 'adm_editharga', 'primary'), sBtn('📝 Edit Nama', 'adm_editnama', 'primary')],
  [sBtn('🌍 Edit Negara', 'adm_editcountry', 'primary'), sBtn('🌐 Edit Domain', 'adm_editdomain', 'primary')],
  [sBtn('💲 Harga VPN/Role', 'adm_vpnprices', 'primary'), sBtn('👥 Kelola Role', 'adm_roles', 'primary')],
  [sBtn('📋 List Server', 'adm_listserver', 'success'), sBtn('🖥️ Live Server', 'adm_liveserver', 'success')],
  [sBtn('⚙️ Pengaturan & API Key', 'adm_api', 'primary'), sBtn('🔑 Edit API Key', 'adm_editkey', 'primary')],
  [sBtn('🔌 Edit API Base', 'adm_editapi', 'primary'), sBtn('📊 Jumlah Akun', 'adm_akun', 'primary')],
  [sBtn('💵 Tambah Saldo', 'adm_addsaldo', 'success'), sBtn('➖ Kurangi Saldo', 'adm_minsaldo', 'danger')],
  [sBtn('📊 Hasil Penjualan', 'adm_sales', 'primary'), sBtn('📑 Log Topup', 'adm_topuplog', 'primary')],
  [sBtn('📦 Backup DB', 'adm_backupdb', 'success'), sBtn('♻️ Restore DB', 'adm_restoredb', 'danger')],
  [sBtn('🎁 Bonus & Reseller', 'adm_bonus', 'success'), sBtn('🔍 Review Deposit/Sewa', 'adm_review', 'primary')],
  [sBtn('💰 Min. Deposit/Role', 'adm_mindep', 'primary'), sBtn('📈 Margin PPOB', 'adm_margin', 'success')],
  [sBtn('📢 Broadcast Grup', 'adm_bcast', 'primary'), sBtn('📣 Broadcast User', 'adm_bcastuser', 'primary')],
  [sBtn('🔔 Grup Notifikasi', 'adm_notifgrp', 'primary'), sBtn('🔒 Force Join', 'adm_forcejoin', 'primary')],
  [sBtn('🔑 Setting ePro (HC)', 'adm_epro', 'primary'), sBtn('📲 List Preset HC', 'adm_hcpresets', 'success')],
  [sBtn('🔙 Kembali', 'menu_main', 'danger')],
]);

// Teks panel admin + jumlah akun (tampil otomatis saat panel dibuka).
async function adminPanelText() {
  try {
    const c = await vpn.countAccounts();
    return '🛠️ <b>PANEL ADMIN</b>\n\n📊 <b>Jumlah Akun VPS ini:</b>\n' +
      `SSH: <b>${c.ssh}</b> | VMess: <b>${c.vmess}</b> | VLess: <b>${c.vless}</b>\n` +
      `Trojan: <b>${c.trojan}</b> | Shadowsocks: <b>${c.shadowsocks}</b> | Total: <b>${c.total}</b>\n\nPilih menu:`;
  } catch (_) {
    return '🛠️ <b>PANEL ADMIN</b>';
  }
}


// Helper: ambil daftar server
async function getServers() {
  const { all } = require('./src/db');
  return all('SELECT * FROM servers ORDER BY id');
}

const vpnMenu = (cf = false) => {
  const p = cf ? 'cf_' : '';
  // Slim: protokol dipasangkan 2 per baris, Trial + Top Up sebaris —
  // 5 baris (dari 7). Callback tidak berubah.
  return Markup.inlineKeyboard([
    [sBtn('🖥️ SSH', `${p}mk_ssh`, 'danger'), sBtn('📡 VMess', `${p}mk_vmess`, 'success')],
    [sBtn('⚡ VLess', `${p}mk_vless`, 'primary'), sBtn('🛡️ Trojan', `${p}mk_trojan`, 'success')],
    [sBtn('👻 Shadowsocks', `${p}mk_shadowsocks`, 'primary'), sBtn('⚡ Zivpn UDP', `${p}mk_zivpn`, 'success')],
    [sBtn('🎁 Trial 1 Jam', `${p}mk_trial`, 'primary'), sBtn('💰 Top Up', 'ppob_deposit', 'success')],
    [sBtn('🔙 Kembali', 'menu_main', 'danger')],
  ]);
};

// Cek apakah user sudah join channel & grup wajib (admin selalu lolos).
// Konfigurasi via panel admin (tabel bot_settings). Masing-masing bisa
// dikosongkan = tidak dicek. Return { ok, missing: [{id, url, label}] }.
async function checkForceJoin(ctx) {
  try {
    if (await admin.hasAdminAccess(ctx)) return { ok: true, missing: [] };
    const fj = await settings.getForceJoin();
    if (!fj.enabled) return { ok: true, missing: [] };
    const missing = [];
    const targets = [
      { id: fj.channelId, url: fj.channelUrl, label: 'Channel' },
      { id: fj.groupId, url: fj.groupUrl, label: 'Grup' },
    ];
    for (const t of targets) {
      if (!t.id) continue;
      try {
        const m = await ctx.telegram.getChatMember(t.id, ctx.from.id);
        if (!['member', 'administrator', 'creator'].includes(m.status)) {
          missing.push(t);
        }
      } catch (e) {
        // Bot bukan member / ID salah — lewati target ini agar tidak blokir semua user
        console.error('checkForceJoin error:', t.id, e.message);
      }
    }
    return { ok: missing.length === 0, missing };
  } catch (e) {
    console.error('checkForceJoin error:', e.message);
    return { ok: true, missing: [] };
  }
}

// Kompatibilitas: versi boolean sederhana (dipakai kode lama)
async function checkGroupMember(ctx) {
  const r = await checkForceJoin(ctx);
  return r.ok;
}

const ensureUser = async (ctx) => {
  const { run } = require('./src/db');
  await run('INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)',
    [ctx.from.id, ctx.from.username || ctx.from.first_name || '']);
};

// ---------- /start (ala RIPZZ STORE) ----------
const HARI_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// Waktu server dalam WIB (UTC+7)
function wibParts() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    waktu: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} WIB`,
    tanggal: `${HARI_ID[d.getUTCDay()]}, ${d.getUTCDate()} ${BULAN_ID[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
  };
}

// Uptime bot: Xd Xh Xm Xs
function botUptime() {
  let s = Math.floor((Date.now() - BOT_START_TIME) / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

// Caption /start: info akun + waktu/server dalam blockquote
async function buildWelcomeCaption(ctx) {
  const { get } = require('./src/db');
  const uid = ctx.from.id;
  const role = await ppob.getRole(uid).catch(() => 'member');
  const saldo = await ppob.getSaldo(uid).catch(() => 0);
  const cnt = await get('SELECT COUNT(*) AS n FROM users').catch(() => ({ n: 0 }));
  const { waktu, tanggal } = wibParts();
  const username = ctx.from.username ? '@' + ctx.from.username : '-';
  return `SELAMAT DATANG DI RIPZZ STORE 💎
NIKMATI PENGALAMAN MEMBELI AKUN VPN
TERCEPAT, AMAN, DAN OTOMATIS 🚀

<blockquote>👁️ INFORMASI AKUN
💰 SALDO: ${digi.rp(saldo)}
👤 STATUS: ${settings.roleBadge(role)}
🌐 USERNAME: ${esc(username)}
🆔 ID PENGGUNA: <code>${uid}</code>

🕐 WAKTU &amp; SERVER
⏱️ WAKTU: ${waktu}
📅 TANGGAL: ${tanggal}
🖥️ SERVER: 1 | 👥 USER: ${cnt?.n || 0}
⌚ BOT AKTIF: ${botUptime()}

☎️ HUBUNGI ADMIN
📩 @Notif2Ajibot</blockquote>

📦 ─────────── 📦
🌐 DIKELOLA OLEH RIPZZ STORE NETWORK
📦 ─────────── 📦`;
}

bot.start(async (ctx) => {
  await ensureUser(ctx);
  await safeCb(ctx);
  const fj = await checkForceJoin(ctx);
  if (!fj.ok) {
    const rows = fj.missing.map((t) => [
      { text: `📢 Join ${t.label}`, url: t.url || `https://t.me/${String(t.id).replace('@', '')}` },
    ]);
    rows.push([{ text: '✅ Saya Sudah Gabung', callback_data: 'fj_verify' }]);
    return ctx.reply(
      '⚠️ <b>Wajib Join Dulu</b>\n\n' +
      'Untuk memakai bot ini, silakan join ' +
      fj.missing.map((t) => t.label).join(' & ') +
      ' kami dulu.\n\nSetelah join, tekan tombol <b>✅ Saya Sudah Gabung</b>.',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
    );
  }
  await sendMenuPhoto(ctx, 'banner-utama.webp',
    await buildWelcomeCaption(ctx),
    mainMenu(await admin.hasAdminAccess(ctx), (await ppob.getRole(ctx.from.id).catch(() => 'member')) === 'reseller'));
});

// Verifikasi ulang force join setelah user tekan "Saya Sudah Gabung"
bot.action('fj_verify', async (ctx) => {
  await safeCb(ctx);
  const fj = await checkForceJoin(ctx);
  if (!fj.ok) {
    return ctx.reply('❌ Kamu belum join semua. Join dulu lalu tekan tombol verifikasi lagi.');
  }
  await sendMenuPhoto(ctx, 'banner-utama.webp',
    await buildWelcomeCaption(ctx),
    mainMenu(await admin.hasAdminAccess(ctx), (await ppob.getRole(ctx.from.id).catch(() => 'member')) === 'reseller'));
});

bot.action('menu_main', async (ctx) => {
  await safeCb(ctx);
  const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
  await sendMenuPhoto(ctx, 'banner-utama.webp',
    await buildWelcomeCaption(ctx),
    mainMenu(await admin.hasAdminAccess(ctx), role === 'reseller'));
});

// ---------- Submenu VPN (dari tombol 🌐 Menu VPN) ----------
bot.action('menu_vpn_home', async (ctx) => {
  await safeCb(ctx);
  await sendMenuPhoto(ctx, 'banner-utama.webp',
    `🌐 <b>MENU VPN</b>
━━━━━━━━━━━━━━━━━━
Pilih layanan VPN:`,
    Markup.inlineKeyboard([
      [sBtn('🛰️ Premium', 'menu_vpn', 'success'), sBtn('☁️ CloudFront', 'menu_cf', 'primary')],
      [sBtn('📊 Cek Kuota', 'menu_kuota', 'primary'), sBtn('💰 Sewa Script', 'menu_sewa', 'success')],
      [sBtn('📈 Statistik', 'menu_stat', 'primary'), sBtn('🔙 Kembali', 'menu_main', 'danger')],
    ]));
});

// ---------- Menu VPN ----------
bot.action('menu_vpn', async (ctx) => {
  await safeCb(ctx);
  await sendMenuPhoto(ctx, 'banner-utama.webp',
    `🛰️ <b>VPN PREMIUM</b>
━━━━━━━━━━━━━━━━━━
` +
    `<blockquote>🖥️ <b>SSH</b> — cepat & stabil
` +
    `📡 <b>VMess</b> — protokol V2Ray
` +
    `⚡ <b>VLess</b> — ringan & cepat
` +
    `🛡️ <b>Trojan</b> — aman & anti-blokir
` +
    `👻 <b>Shadowsocks</b> — simpel & cepat</blockquote>

` +
    `Pilih protokol di bawah ini:`, vpnMenu(false));
});

bot.action('menu_cf', async (ctx) => {
  await safeCb(ctx);
  await sendMenuPhoto(ctx, 'banner-utama.webp',
    `☁️ <b>VPN via CLOUDFRONT</b>
━━━━━━━━━━━━━━━━━━
` +
    `<blockquote>☁ Trafik disamarkan sebagai <b>HTTPS CloudFront</b> —
` +
    `sulit dideteksi & diblokir.</blockquote>

` +
    `🖥️ <b>SSH</b>  📡 <b>VMess</b>
` +
    `⚡ <b>VLess</b>  🛡️ <b>Trojan</b>

` +
    `Pilih protokol di bawah ini:`, vpnMenu(true));
});

// ---------- Buat akun VPN ----------
const PROTO_LABEL = { ssh: 'SSH', vmess: 'VMess', vless: 'VLess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', zivpn: 'Zivpn UDP' };

// ---------- Pemilih server saat beli (bendera + paginasi) ----------
// Tiap server wajib punya bendera (kolom country, mis. ID/SG) — tampil
// sebagai emoji di tombol. Daftar diambil dari DB (otomatis, bukan
// hardcode) dan dipaginasi 8 server/halaman supaya tetap jalan walau
// admin mendaftarkan 100 server (batas tombol Telegram per pesan).
const SRV_PAGE_SIZE = 8;
let mainCountryCache = null;
async function mainFlag() {
  if (mainCountryCache === null) {
    const ip = await installServer.getMainBotIp().catch(() => '');
    mainCountryCache = ip ? await country.detectCountry(ip).catch(() => '') : '';
  }
  return country.flagFor(mainCountryCache);
}
async function showServerPicker(ctx, page) {
  const sess = sessions.get(ctx.chat.id);
  const viaCF = !!sess?.pendingCf;
  const servers = await vpn.listBuyServers().catch(() => []);
  const totalPages = Math.max(1, Math.ceil(servers.length / SRV_PAGE_SIZE));
  const p = Math.min(Math.max(0, page || 0), totalPages - 1);
  const start = p * SRV_PAGE_SIZE;
  const slice = servers.slice(start, start + SRV_PAGE_SIZE);
  const rows = [];
  if (p === 0) rows.push([sBtn(`${await mainFlag()} Server Utama (${config.vpn.domain})`, 'vpn_srv_0', 'primary')]);
  for (const sv of slice) rows.push([sBtn(`${country.flagFor(sv.country)} ${sv.nama} (${sv.domain})`, `vpn_srv_${sv.id}`, 'success')]);
  const nav = [];
  if (p > 0) nav.push(sBtn('⬅️ Sebelumnya', `vpn_srvpage_${p - 1}`, 'primary'));
  if (p < totalPages - 1) nav.push(sBtn(`➡️ Berikutnya (${p + 2}/${totalPages})`, `vpn_srvpage_${p + 1}`, 'primary'));
  if (nav.length) rows.push(nav);
  rows.push([sBtn('🔙 Kembali', viaCF ? 'menu_cf' : 'menu_vpn', 'danger')]);
  const text = `🌐 <b>Pilih Server</b>\n\nAkun akan dibuat di server yang kamu pilih:${totalPages > 1 ? ` (hal ${p + 1}/${totalPages})` : ''}`;
  return { text, reply_markup: { inline_keyboard: rows } };
}
bot.action(/^vpn_srvpage_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  const sess = sessions.get(ctx.chat.id);
  if (!sess?.pendingProto) return ctx.reply('❌ Sesi pembelian tidak ditemukan. Ulangi dari menu.');
  const picker = await showServerPicker(ctx, Number(ctx.match[1]));
  try { await ctx.editMessageText(picker.text, { parse_mode: 'HTML', reply_markup: picker.reply_markup }); }
  catch (_) { await ctx.reply(picker.text, { parse_mode: 'HTML', reply_markup: picker.reply_markup }); }
});

async function handleCreate(ctx, proto, viaCF) {
  const chatId = ctx.chat.id;
  // Pilih server dulu bila ada server AKTIF terdaftar (health check
  // lolos saat didaftarkan); bila tidak ada, langsung ke input username
  // (server utama, perilaku lama).
  const servers = await vpn.listBuyServers().catch(() => []);
  if (servers.length) {
    sessions.set(chatId, { pendingProto: proto, pendingCf: viaCF });
    const picker = await showServerPicker(ctx, 0);
    await ctx.reply(picker.text, { parse_mode: 'HTML', reply_markup: picker.reply_markup });
    await safeCb(ctx);
    return;
  }
  sessions.set(chatId, { step: 'vpn_username', proto, viaCF, serverId: 0 });
  await ctx.reply(
    `✏️ <b>Buat Akun ${PROTO_LABEL[proto]}${viaCF ? ' (CloudFront)' : ''}</b>\n\n` +
      `Kirim <b>username</b> (3-20 karakter, huruf/angka):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
  await safeCb(ctx);
}

for (const proto of ['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn']) {
  bot.action(`mk_${proto}`, (ctx) => handleCreate(ctx, proto, false));
  bot.action(`cf_mk_${proto}`, (ctx) => handleCreate(ctx, proto, true));
}

// ---------- Pilih server saat beli (lanjut ke input username) ----------
bot.action(/^vpn_srv_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  const sess = sessions.get(ctx.chat.id);
  if (!sess?.pendingProto) return ctx.reply('❌ Sesi pembelian tidak ditemukan. Ulangi dari menu.');
  const proto = sess.pendingProto;
  const viaCF = !!sess.pendingCf;
  const serverId = Number(ctx.match[1]);
  sessions.set(ctx.chat.id, { step: 'vpn_username', proto, viaCF, serverId });
  await ctx.reply(
    `✏️ <b>Buat Akun ${PROTO_LABEL[proto]}${viaCF ? ' (CloudFront)' : ''}</b>\n\n` +
      `Kirim <b>username</b> (3-20 karakter, huruf/angka):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

// ---------- Trial 1 jam, gratis, 1x/24 jam per telegram_id (biasa+CF digabung) ----------
// Alur: tombol trial -> pilih protokol -> kirim username -> (SSH/Zivpn: password)
// -> akun dibuat via fungsi create* yang sama dengan akun biasa, sehingga
// akun biasa (viaCF=false) tetap pakai domain/path/kredensial biasa, dan
// hanya akun CF (viaCF=true) yang pakai domain/path/kredensial CF.
async function trialProtoMenu(ctx, viaCF) {
  await safeCb(ctx);
  const p = viaCF ? 'cf_trial_proto_' : 'trial_proto_';
  const rows = [
    [sBtn('🖥️ SSH', `${p}ssh`, 'danger'), sBtn('📡 VMess', `${p}vmess`, 'success')],
    [sBtn('⚡ VLess', `${p}vless`, 'primary'), sBtn('🛡️ Trojan', `${p}trojan`, 'success')],
    [sBtn('👻 Shadowsocks', `${p}shadowsocks`, 'primary')],
    [sBtn('⚡ Zivpn UDP', `${p}zivpn`, 'success')],
    [sBtn('🔙 Kembali', 'menu_main', 'danger')],
  ];
  await ctx.reply('🎁 <b>TRIAL GRATIS 1 JAM</b>\n\nPilih protokol (1 akun, 1x per 24 jam):',
    { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(rows).reply_markup });
}
bot.action('mk_trial', (ctx) => trialProtoMenu(ctx, false));
bot.action('cf_mk_trial', (ctx) => trialProtoMenu(ctx, true));

async function trialProtoPick(ctx, proto, viaCF) {
  await safeCb(ctx);
  if (!['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn'].includes(proto)) {
    return ctx.reply('❌ Protokol trial tidak dikenal.');
  }
  if (!(await vpn.canClaimTrial(ctx.from.id).catch(() => false))) {
    return ctx.reply('❌ Kamu sudah klaim trial dalam 24 jam terakhir. Coba lagi besok.');
  }
  // Pilih server dulu bila ada server AKTIF terdaftar (seperti alur beli);
  // bila tidak ada, langsung ke input username (server utama, perilaku lama).
  const trialServers = await vpn.listBuyServers().catch(() => []);
  if (trialServers.length) {
    sessions.set(ctx.chat.id, { pendingTrialProto: proto, pendingTrialCf: viaCF });
    const rows = [[sBtn(`🏠 Server Utama (${config.vpn.domain})`, 'trial_srv_0', 'primary')]];
    for (const sv of trialServers) rows.push([sBtn(`🌐 ${sv.nama} (${sv.domain})`, `trial_srv_${sv.id}`, 'success')]);
    rows.push([sBtn('🔙 Kembali', 'menu_main', 'danger')]);
    await ctx.reply('🌐 <b>Pilih Server</b>\n\nTrial akan dibuat di server yang kamu pilih:', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(rows) });
    await safeCb(ctx);
    return;
  }
  sessions.set(ctx.chat.id, { step: 'vpn_username', proto, viaCF, isTrial: true });
  await ctx.reply(
    `🎁 <b>Trial ${PROTO_LABEL[proto]}${viaCF ? ' (CloudFront)' : ''} — Gratis 1 Jam</b>\n\n` +
      `Kirim <b>username</b> (3-20 karakter, huruf/angka):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
}
bot.action(/^trial_proto_(.+)$/, (ctx) => trialProtoPick(ctx, ctx.match[1], false));
bot.action(/^cf_trial_proto_(.+)$/, (ctx) => trialProtoPick(ctx, ctx.match[1], true));

// ---------- Pilih server saat trial (lanjut ke input username) ----------
bot.action(/^trial_srv_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  const sess = sessions.get(ctx.chat.id);
  if (!sess?.pendingTrialProto) return ctx.reply('❌ Sesi trial tidak ditemukan. Ulangi dari menu.');
  const proto = sess.pendingTrialProto;
  const viaCF = !!sess.pendingTrialCf;
  const serverId = Number(ctx.match[1]);
  sessions.set(ctx.chat.id, { step: 'vpn_username', proto, viaCF, isTrial: true, serverId });
  await ctx.reply(
    `🎁 <b>Trial ${PROTO_LABEL[proto]}${viaCF ? ' (CloudFront)' : ''} — Gratis 1 Jam</b>\n\n` +
      `Kirim <b>username</b> (3-20 karakter, huruf/angka):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

// Buat akun trial: tanpa cek/potong saldo, exp=1 ke API (BUKAN 0 —
// exp=0 di API dibaca jadi 30 hari), masa trial 1 jam dicatat di
// trial_expires_at dan ditegakkan sweeper, bukan kolom tanggal expiry.
async function finishTrialVpn(ctx, sess, username, password = '') {
  sessions.delete(ctx.chat.id);
  const { proto, viaCF, serverId } = sess;
  const srv = await vpn.getServer(serverId).catch(() => null);
  if (!(await vpn.canClaimTrial(ctx.from.id).catch(() => false))) {
    return ctx.reply('❌ Kamu sudah klaim trial dalam 24 jam terakhir. Coba lagi besok.');
  }
  await ctx.reply('⏳ Membuat akun trial...');
  let r;
  try {
    if (proto === 'ssh') {
      r = viaCF ? vpn.cfSSHInfo(username, password, 1, srv)
        : await vpn.createSSH(username, password, 1, 1, srv);
      if (viaCF && r.success) await vpn.createSSH(username, password, 1, 1, srv).catch(() => {});
    } else if (proto === 'vmess') r = await vpn.createVMess(username, 1, viaCF, srv);
    else if (proto === 'vless') r = await vpn.createVLess(username, 1, viaCF, srv);
    else if (proto === 'shadowsocks') r = await vpn.createShadowsocks(username, 1, viaCF, srv);
    else if (proto === 'zivpn') r = await vpn.createZivpn(username, password, 1, srv);
    else r = await vpn.createTrojan(username, 1, viaCF, srv);
  } catch (e) {
    r = { success: false, message: `❌ Error: ${esc(e.message)}` };
  }
  if (!r.success) return ctx.reply(r.message, { parse_mode: 'HTML' });
  const trialEnd = vpn.trialExpiresAtISO();
  await vpn.recordTrialClaim(ctx.from.id);
  await vpn.saveAccount(ctx.from.id, proto, username, r.expiry, 1, viaCF ? 1 : 0, trialEnd, serverId || 0);
  notifGrup(bot, `🎁 <b>Trial VPN</b>\n👤 ${ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name}\n📦 ${proto.toUpperCase()}${viaCF ? ' (CF)' : ''} - 1 jam (gratis)`);
  // Pesan trial menampilkan JAM berakhir (WIB), bukan tanggal expiry.
  const endWib = new Date(Date.now() + 3600 * 1000 + 7 * 3600 * 1000);
  const hhmm = String(endWib.getUTCHours()).padStart(2, '0') + ':' + String(endWib.getUTCMinutes()).padStart(2, '0');
  const _att = vpn.attachSave(proto, username, r.message, srv);
  r.message = _att.message; r.saveUrl = _att.saveUrl;
  const msg = r.message.replace(/Expired\s*:?\s*<code>[^<]*<\/code>/, `📅 Berlaku s/d : <code>${hhmm} WIB</code> 🎁 Trial 1 jam`)
    + `\n\n🎁 <b>TRIAL GRATIS 1 JAM</b> — berlaku s/d <b>${hhmm} WIB</b>, akun dihapus otomatis setelah habis.`;
  let extra = { parse_mode: 'HTML' };
  if ((await hc.hcEnabled()) && ['vmess', 'vless', 'trojan', 'ssh'].includes(proto)) {
    const cacheKey = ctx.from.id + '_' + proto + '_' + username;
    hcCache.set(cacheKey, {
      proto, username,
      uuid: r.uuid || '', password: r.password || '',
      domain: viaCF ? config.cloudfront.domain : vpn.dispDomain(srv),
    });
    if (hcCache.size > 100) hcCache.delete(hcCache.keys().next().value);
    extra.reply_markup = { inline_keyboard: [[{ text: '📱 Download .hc', callback_data: 'hc_dl_' + cacheKey }]] };
  }
  const expRows = exportRowsFor(ctx, proto, username, r, viaCF, srv);
  if (expRows.length) {
    const kb = (extra.reply_markup && extra.reply_markup.inline_keyboard) || [];
    extra.reply_markup = { inline_keyboard: [...expRows, ...kb] };
  }
  await ctx.reply(msg, extra);
}


function exportRowsFor(ctx, proto, username, r, viaCF, srv) {
  if (!r || !r.success) return [];
  if (!['vmess', 'vless', 'trojan', 'shadowsocks', 'ssh'].includes(proto)) return [];
  const key = ctx.from.id + '_' + proto + '_' + username;
  const domain = viaCF ? config.cloudfront.domain : (srv?.domain || config.vpn.domain);
  exportCache.set(key, { proto, username, uuid: r.uuid || '', password: r.password || '', domain, links: r.links || (r.link ? { tls: r.link } : {}), saveUrl: r.saveUrl || '', exp: r.expiry || '', method: r.method || '' });
  if (exportCache.size > 100) exportCache.delete(exportCache.keys().next().value);
  if (proto === 'ssh') return [[{ text: '📱 HTTP Custom', callback_data: 'exp_httpcustom_' + key }, { text: '🌐 NetMod', callback_data: 'exp_netmod_' + key }]];
  return [
    [{ text: '📦 Clash', callback_data: 'exp_clash_' + key }, { text: '⚡ V2Ray', callback_data: 'exp_v2ray_' + key }],
    [{ text: '📱 HTTP Custom', callback_data: 'exp_httpcustom_' + key }, { text: '🌐 NetMod', callback_data: 'exp_netmod_' + key }],
  ];
}

bot.action(/^exp_(clash|v2ray|httpcustom|netmod)_(.+)$/, async (ctx) => {
  await safeCb(ctx);
  const kind = ctx.match[1];
  const info = exportCache.get(ctx.match[2]);
  if (!info) { await ctx.reply('❌ Data akun tidak ditemukan. Buat akun baru dulu.'); return; }
  if (kind === 'clash') {
    const yaml = vpn.buildClash(info.proto, info.username, info.uuid, info.password, info.domain, info.links);
    if (!yaml) { await ctx.reply('❌ Clash tidak tersedia untuk protokol ini.'); return; }
    await ctx.replyWithDocument({ source: Buffer.from(yaml, 'utf8'), filename: `clash-${info.username}.yaml` }, { caption: `📦 Clash config untuk <code>${info.username}</code>`, parse_mode: 'HTML' });
    return;
  }
  if (kind === 'v2ray') {
    const json = vpn.buildV2ray(info.proto, info.username, info.uuid, info.password, info.domain);
    if (!json) { await ctx.reply('❌ V2Ray tidak tersedia untuk protokol ini.'); return; }
    await ctx.replyWithDocument({ source: Buffer.from(json, 'utf8'), filename: `v2ray-${info.username}.json` }, { caption: `⚡ V2Ray config untuk <code>${info.username}</code>`, parse_mode: 'HTML' });
    return;
  }
  const appName = kind === 'httpcustom' ? 'HTTP Custom' : 'NetMod';
  if (info.proto === 'ssh') {
    await ctx.reply(`📱 <b>${appName}</b> — SSH <code>${info.username}</code>\n<blockquote>🌐 Host: <code>${info.domain}</code>\n👤 Username: <code>${info.username}</code>\n🔑 Password: <code>${info.password}</code>\n🔌 TLS: 443 / HTTP: 80 / SSH: 22</blockquote>\n\n📄 Payload:\n<code>GET wss://[host]/ HTTP/1.1[crlf]Host: ${info.domain}[crlf]Upgrade: websocket[crlf][crlf]</code>`, { parse_mode: 'HTML' });
    return;
  }
  const link = (info.links && info.links.tls) || '';
  if (!link) { await ctx.reply('❌ Link tidak tersedia.'); return; }
  await ctx.reply(`📱 <b>${appName}</b> — impor link ini:\n<code>${link}</code>`, { parse_mode: 'HTML' });
});

// ---------- Terima input teks (session) ----------
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = sessions.get(chatId);

  // Ketik "batal" untuk membatalkan sesi input yang sedang berjalan
  if (sess && /^(batal|cancel)$/i.test(ctx.message.text.trim())) {
    sessions.delete(chatId);
    await ctx.reply('❌ <b>Dibatalkan.</b>', { parse_mode: 'HTML' });
    return goMainMenu(ctx);
  }

  // --- Session input Pengaturan & API Key ---
  if (sess?.step === 'adm_api_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const field = sess.data?.field;
    const value = ctx.message.text.trim();
    sessions.delete(chatId);
    if (sess?.data?.menuMsgId) { try { await ctx.telegram.deleteMessage(chatId, sess.data.menuMsgId); } catch (_) {} }
    const f = apiSettings.FIELDS.find((x) => x.key === field);
    if (!f) return ctx.reply('❌ Field tidak dikenal.', { parse_mode: 'HTML', reply_markup: apiMenuKb() });
    if (!value) return ctx.reply('❌ Nilai tidak boleh kosong.', { parse_mode: 'HTML', reply_markup: apiMenuKb() });
    try {
      apiSettings.setKey(field, value);
    } catch (e) {
      return ctx.reply(`❌ Gagal menyimpan: ${esc(e.message)}`, { parse_mode: 'HTML', reply_markup: apiMenuKb() });
    }
    if (f.secret) { try { await ctx.deleteMessage(ctx.message.message_id); } catch (_) {} }
    const shown = f.secret ? apiSettings.mask(value) : esc(value);
    return ctx.reply(`✅ <b>${esc(f.label)}</b> tersimpan${f.secret ? ` (<code>${shown}</code>)` : `: <code>${shown}</code>`}. Berlaku setelah Terapkan &amp; Restart.`, { parse_mode: 'HTML', reply_markup: apiMenuKb() });
  }
  // --- Session input API key ePro ---
  if (sess?.step === 'adm_epro_key') {
    const apiKey = ctx.message.text.trim();
    sessions.delete(chatId);
    if (!apiKey) return ctx.reply('❌ API key tidak boleh kosong.');
    await settings.setSetting('epro_api_key', apiKey);
    // Hapus pesan berisi API key dari chat demi keamanan
    try { await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}
    const masked = apiKey.length > 12 ? apiKey.slice(0, 8) + '...' + apiKey.slice(-4) : '***';
    return ctx.reply(`✅ API key ePro disimpan (<code>${masked}</code>).`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // --- Session admin: set bonus topup (format: "min_topup persen") ---
  if (sess?.step === 'adm_bonus_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const parts = ctx.message.text.trim().split(/\s+/);
    const minTopup = Number((parts[0] || '').replace(/\D/g, ''));
    const persen = Number((parts[1] || '').replace(/\D/g, ''));
    sessions.delete(chatId);
    if (parts[0] === '0' || (!minTopup && !persen)) {
      await ppob.setBonusConfig(0, 0);
      return ctx.reply('✅ Bonus topup <b>dinonaktifkan</b>.', { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup });
    }
    if (!minTopup || !persen || persen > 100) {
      return ctx.reply('❌ Format salah. Contoh: <code>50000 10</code>', { parse_mode: 'HTML' });
    }
    const cfg = await ppob.setBonusConfig(minTopup, persen);
    return ctx.reply(
      `✅ <b>Bonus topup diaktifkan!</b>\n\nMin. topup: <b>${digi.rp(cfg.min_topup)}</b>\nBonus: <b>${cfg.bonus_percent}%</b>`,
      { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
    );
  }

  // --- Session admin: set minimal topup otomatis reseller ---
  if (sess?.step === 'adm_resset_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const nominal = Number(ctx.message.text.replace(/\D/g, ''));
    sessions.delete(chatId);
    await settings.setSetting('reseller_min_topup', String(nominal || 0));
    return ctx.reply(
      nominal > 0
        ? `✅ Min. topup otomatis reseller: <b>${digi.rp(nominal)}</b>\n\nUser yang total topup-nya mencapai nominal ini otomatis jadi 🏪 Reseller.`
        : `✅ Fitur otomatis reseller <b>dinonaktifkan</b>.`,
      { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
    );
  }

  // --- Session admin: set minimal deposit per role ---
  if (sess?.step === 'adm_mindep_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const role = sess.data?.role === 'reseller' ? 'reseller' : 'member';
    const nominal = Number(ctx.message.text.replace(/\D/g, ''));
    sessions.delete(chatId);
    const val = await settings.setMinDeposit(role, nominal || 0);
    return ctx.reply(
      val > 0
        ? `✅ Min. deposit ${role === 'reseller' ? 'Reseller' : 'Member'}: <b>${digi.rp(val)}</b>`
        : `✅ Min. deposit ${role === 'reseller' ? 'Reseller' : 'Member'}: <b>tanpa minimal</b> (nominal tetap harus > 0).`,
      { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
    );
  }

  // --- Session admin: set margin PPOB ---
  if (sess?.step === 'adm_margin_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const raw = ctx.message.text.trim().replace('%', '').replace(',', '.');
    const pct = Number(raw);
    sessions.delete(chatId);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return ctx.reply('❌ Persen tidak valid. Ketik angka 0–100, contoh: <code>5</code> atau <code>2.5</code>', { parse_mode: 'HTML' });
    }
    const val = await settings.setPpobMargin(pct);
    return ctx.reply(
      val > 0
        ? `✅ Margin PPOB: <b>${val}%</b>\n\nHarga jual produk = harga dasar Digiflazz + ${val}% (dibulatkan ke atas).`
        : `✅ Margin PPOB: <b>0% (tanpa margin)</b>\n\nHarga jual = harga dasar Digiflazz.`,
      { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
    );
  }

  // --- Session admin: tambah grup broadcast ---
  if (sess?.step === 'adm_bcast_add') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const chatIdIn = ctx.message.text.trim();
    sessions.delete(chatId);
    if (!/^-?\d+$/.test(chatIdIn)) return ctx.reply('❌ ID grup tidak valid. Contoh: <code>-1001234567890</code>', { parse_mode: 'HTML' });
    // Ambil judul grup (best effort)
    let title = '';
    try {
      const ch = await ctx.telegram.getChat(chatIdIn);
      title = ch.title || '';
    } catch (e) {
      return ctx.reply(`⚠️ Tidak bisa akses grup <code>${esc(chatIdIn)}</code>.\nPastikan bot sudah jadi <b>admin</b> di grup tersebut, lalu coba lagi.`, { parse_mode: 'HTML' });
    }
    await settings.addBroadcastGroup(chatIdIn, title);
    return ctx.reply(`✅ Grup <b>${esc(title || chatIdIn)}</b> ditambahkan ke daftar broadcast.`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // --- Session admin: tulis pesan broadcast ---
  if (sess?.step === 'adm_bcast_msg') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const pesan = ctx.message.text;
    sessions.delete(chatId);
    if (!pesan || pesan.length < 2) return ctx.reply('❌ Pesan terlalu pendek.');
    const groups = await settings.listBroadcastGroups();
    if (!groups.length) return ctx.reply('❌ Belum ada grup terdaftar.');
    await ctx.reply(`⏳ Mengirim broadcast ke ${groups.length} grup...`);
    let ok = 0, fail = 0;
    for (const g of groups) {
      try {
        await ctx.telegram.sendMessage(g.chat_id, `📢 <b>Pengumuman</b>\n\n${pesan}`, { parse_mode: 'HTML' });
        ok++;
      } catch (e) { fail++; }
      await new Promise((r) => setTimeout(r, 100));
    }
    notifGrup(bot, `📢 <b>Broadcast Grup</b>\n👤 Admin: ${ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name}\n✅ Terkirim: ${ok} grup${fail ? `\n❌ Gagal: ${fail} grup` : ''}`);
    return ctx.reply(`✅ Broadcast selesai.\n📨 Terkirim: <b>${ok}</b> grup${fail ? `\n❌ Gagal: <b>${fail}</b> grup` : ''}`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // --- Session admin: tulis pesan broadcast user → konfirmasi ---
  if (sess?.step === 'adm_bcu_msg') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const pesan = ctx.message.text;
    const { target, tlabel } = sess.data || {};
    if (!pesan || pesan.length < 2) return ctx.reply('❌ Pesan terlalu pendek.');
    const { all } = require('./src/db');
    const rows = target === 'all'
      ? await all('SELECT telegram_id FROM users')
      : await all('SELECT telegram_id FROM users WHERE role = ?', [target]);
    const count = new Set(rows.map((r) => r.telegram_id).filter(Boolean)).size;
    if (!count) { sessions.delete(chatId); return ctx.reply('❌ Tidak ada user pada target ini.'); }
    sessions.set(chatId, { step: 'adm_bcu_confirm', data: { target, tlabel, pesan } });
    return ctx.reply(
      `📣 <b>Konfirmasi Broadcast</b>\n\n🎯 Target: <b>${tlabel}</b>\n👥 Penerima: <b>${count}</b> user\n\n<b>Isi pesan:</b>\n${pesan}\n\nKirim sekarang?`,
      {
        parse_mode: 'HTML', ...cancelKb(),
        reply_markup: Markup.inlineKeyboard([
          [sBtn('✅ Ya, Kirim', 'adm_bcu_confirm', 'success'), sBtn('❌ Batal', 'adm_bcu_cancel', 'danger')],
        ]).reply_markup,
      }
    );
  }

  // --- Session admin: set grup notifikasi ---
  if (sess?.step === 'adm_notifgrp_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const gid = ctx.message.text.trim();
    sessions.delete(chatId);
    if (!/^-?\d+$/.test(gid)) return ctx.reply('❌ ID grup tidak valid. Contoh: <code>-1001234567890</code>', { parse_mode: 'HTML' });
    try {
      await ctx.telegram.sendMessage(gid, '🔔 <b>Grup notifikasi terhubung!</b>\n\nNotifikasi transaksi akan dikirim ke sini.', { parse_mode: 'HTML' });
    } catch (e) {
      return ctx.reply(`⚠️ Tidak bisa kirim pesan ke <code>${esc(gid)}</code>.\nPastikan bot sudah jadi <b>admin</b> di grup tersebut.`, { parse_mode: 'HTML' });
    }
    await settings.setSetting('notif_group_id', gid);
    return ctx.reply(`✅ Grup notifikasi diatur ke <code>${esc(gid)}</code>.`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // --- Session admin: set channel/grup force join (format: "ID | link") ---
  if (sess?.step === 'adm_fj_channel' || sess?.step === 'adm_fj_group') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const isChannel = sess.step === 'adm_fj_channel';
    const raw = ctx.message.text.trim();
    sessions.delete(chatId);
    const key = isChannel ? 'force_join_channel' : 'force_join_group';
    const label = isChannel ? 'Channel' : 'Grup';
    if (raw === '-') {
      await settings.setSetting(key + '_id', '');
      await settings.setSetting(key + '_url', '');
      return ctx.reply(`✅ ${label} wajib join <b>dikosongkan</b> (tidak dicek).`, {
        parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
      });
    }
    const [idPart, ...urlParts] = raw.split('|').map((s) => s.trim());
    const url = urlParts.join('|').trim();
    if (!idPart) return ctx.reply('❌ ID tidak boleh kosong.', { parse_mode: 'HTML' });
    await settings.setSetting(key + '_id', idPart);
    if (url) await settings.setSetting(key + '_url', url);
    return ctx.reply(
      `✅ ${label} wajib join diatur:\n🆔 ID: <code>${esc(idPart)}</code>\n🔗 Link: ${esc(url || '-')}`,
      { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
    );
  }

  // --- Session buat akun VPN ---
  if (sess?.step === 'vpn_username') {
    const username = ctx.message.text.trim();
    if (!vpn.validUser(username)) {
      return ctx.reply('❌ Username tidak valid (3-20 karakter, huruf/angka). Coba lagi:');
    }
    if (sess.proto === 'ssh' || sess.proto === 'zivpn') {
      sess.data = { username };
      sess.step = 'vpn_password';
      return ctx.reply('Kirim <b>password</b> untuk akun SSH:', { parse_mode: 'HTML' });
    }
    sess.data = { username };
    if (sess.isTrial) return finishTrialVpn(ctx, sess, username);
    sess.step = 'vpn_days';
    const _r1 = await ppob.getRole(ctx.from.id).catch(() => 'member');
    const _p1 = await vpn.getVpnPrice(sess.proto, _r1, sess.viaCF);
    return ctx.reply(
      'Masukkan <b>durasi (hari)</b>\nHarga: <b>Rp' + _p1.toLocaleString('id-ID') + '/hari</b>\nSaldo kamu: <b>Rp' + (await ppob.getSaldo(ctx.from.id)).toLocaleString('id-ID') + '</b>',
      { parse_mode: 'HTML' }
    );
  }

  if (sess?.step === 'vpn_password') {
    const password = ctx.message.text.trim();
    if (password.length < 4) return ctx.reply('❌ Password minimal 4 karakter. Coba lagi:');
    sess.data.password = password;
    if (sess.isTrial) return finishTrialVpn(ctx, sess, sess.data.username, password);
    sess.step = 'vpn_days';
    const _r2 = await ppob.getRole(ctx.from.id).catch(() => 'member');
    const _p2 = await vpn.getVpnPrice(sess.proto, _r2, sess.viaCF);
    return ctx.reply(
      'Masukkan <b>durasi (hari)</b>\nHarga: <b>Rp' + _p2.toLocaleString('id-ID') + '/hari</b>\nSaldo kamu: <b>Rp' + (await ppob.getSaldo(ctx.from.id)).toLocaleString('id-ID') + '</b>',
      { parse_mode: 'HTML' }
    );
  }

  if (sess?.step === 'restore_db') {
    const doc = ctx.message.document;
    if (!doc || !doc.file_name.endsWith('.db')) {
      return ctx.reply('❌ Kirim file .db yang valid. Batalkan dengan /start');
    }
    if (!(await admin.hasAdminAccess(ctx))) {
      sessions.delete(ctx.chat.id);
      return ctx.reply('❌ Khusus admin.');
    }
    try {
      const fs = require('fs');
      const path = require('path');
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const https = require('https');
      const dbPath = path.join(__dirname, 'data', 'bot.db');
      const tmpPath = dbPath + '.restore-tmp';
      // Safety: keep current DB before overwrite, and validate the upload.
      const _safetyDir = path.join(__dirname, 'data', 'backups');
      try { fs.mkdirSync(_safetyDir, { recursive: true }); } catch (_) {}
      const _ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      try { if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, path.join(_safetyDir, `before-restore-${_ts}.db`)); } catch (_) {}
      await new Promise((resolve, reject) => {
        https.get(link.href, (res) => {
          const ws = fs.createWriteStream(tmpPath);
          res.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
        }).on('error', reject);
      });
      const _st = fs.statSync(tmpPath);
      if (_st.size === 0 || _st.size > 20 * 1024 * 1024) { fs.unlinkSync(tmpPath); throw new Error('Ukuran file restore tidak valid (maks 20 MB).'); }
      const _hdr = fs.readFileSync(tmpPath).subarray(0, 16).toString('latin1');
      if (!_hdr.startsWith('SQLite format 3')) { fs.unlinkSync(tmpPath); throw new Error('File bukan database SQLite yang valid.'); }
      fs.copyFileSync(tmpPath, dbPath);
      fs.unlinkSync(tmpPath);
      sessions.delete(ctx.chat.id);
      await ctx.reply('✅ Database berhasil di-restore. Bot restart...');
      setTimeout(() => process.exit(0), 1500); // pm2 akan restart otomatis
    } catch (e) {
      sessions.delete(ctx.chat.id);
      await ctx.reply(`❌ Restore gagal: ${e.message}`);
    }
    return;
  }

  if (sess?.step === 'vpn_days') {
    const days = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(days) || days < 1 || days > 365) {
      return ctx.reply('❌ Durasi tidak valid (1-365 hari). Coba lagi:');
    }
    const username = sess.data.username;
    const password = sess.data.password || '';
    return finishCreateVpn(ctx, sess, username, password, days);
  }

  // --- Session renew akun ---
  if (sess?.step === 'renew_days') {
    const days = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(days) || days < 1 || days > 365) {
      return ctx.reply('❌ Durasi tidak valid (1-365 hari). Coba lagi:');
    }
    return finishRenew(ctx, sess.accountId, days);
  }

  // --- Session hapus akun ketik-nama-saja ---
  if (sess?.step === 'hapus_nama') {
    const raw = ctx.message.text.trim();
    const { all } = require('./src/db');
    const PROTOS = ['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn'];
    let rows = [], adminMode = false, nama = raw, protoReq = '';
    if (raw.includes(':')) {
      const parts = raw.split(':');
      nama = parts[0].trim(); protoReq = (parts[1] || '').trim().toLowerCase();
      if (!vpn.validUser(nama) || !PROTOS.includes(protoReq)) {
        return ctx.reply('❌ Format: nama:protokol, contoh: testuser:vmess. Ketik lagi, atau ketik batal:');
      }
      rows = await all('SELECT * FROM vpn_accounts WHERE username = ? AND telegram_id = ? AND proto = ?', [nama, ctx.from.id, protoReq]).catch(() => []);
      if (!rows.length && await admin.hasAdminAccess(ctx)) {
        rows = await all('SELECT * FROM vpn_accounts WHERE username = ? AND proto = ?', [nama, protoReq]).catch(() => []);
        adminMode = rows.length > 0;
      }
    } else {
      if (!vpn.validUser(raw)) {
        return ctx.reply('❌ Nama akun 3-20 karakter, huruf/angka saja. Ketik nama lain, atau ketik batal:');
      }
      rows = await all('SELECT * FROM vpn_accounts WHERE username = ? AND telegram_id = ?', [nama, ctx.from.id]).catch(() => []);
      if (!rows.length && await admin.hasAdminAccess(ctx)) {
        rows = await all('SELECT * FROM vpn_accounts WHERE username = ?', [nama]).catch(() => []);
        adminMode = rows.length > 0;
      }
    }
    if (!rows.length) {
      return ctx.reply('❌ Akun tidak ditemukan di daftar akunmu. Ketik nama lain, atau ketik batal:');
    }
    if (rows.length > 1) {
      const protos = rows.map((a) => a.proto.toUpperCase()).join(', ');
      return ctx.reply(
        `Nama <code>${esc(nama)}</code> ada di beberapa protokol: <code>${esc(protos)}</code>. ` +
        `Ketik <b>nama:protokol</b>, contoh: <code>${esc(nama)}:${esc(rows[0].proto)}</code>, atau ketik batal:`,
        { parse_mode: 'HTML', ...cancelKb() }
      );
    }
    sessions.delete(chatId);
    const a = rows[0];
    const cb = adminMode ? `delconfadm_${a.id}` : `delconf_${a.id}`;
    return ctx.reply(
      `🗑️ <b>Hapus Akun?</b>\n\n` +
      `👤 Username: <code>${esc(a.username)}</code>\n` +
      `📦 Protokol: <code>${esc(a.proto.toUpperCase())}</code>${a.via_cf ? ' ☁️CF' : ''}\n\n` +
      `Akun akan dihapus dari server dan daftar akun. Tindakan ini tidak bisa dibatalkan.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '✅ Ya, Hapus', callback_data: cb }],
        [{ text: '❌ Batal', callback_data: 'menu_akun' }],
      ] } }
    );
  }

  // --- Session renew akun ketik-nama-saja ---
  if (sess?.step === 'renew_nama') {
    const raw = ctx.message.text.trim();
    const { all } = require('./src/db');
    const PROTOS = ['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn'];
    let rows = [], nama = raw, protoReq = '';
    if (raw.includes(':')) {
      const parts = raw.split(':');
      nama = parts[0].trim(); protoReq = (parts[1] || '').trim().toLowerCase();
      if (!vpn.validUser(nama) || !PROTOS.includes(protoReq)) {
        return ctx.reply('❌ Format: nama:protokol, contoh: testuser:vmess. Ketik lagi, atau ketik batal:');
      }
      rows = await all('SELECT * FROM vpn_accounts WHERE username = ? AND telegram_id = ? AND proto = ?', [nama, ctx.from.id, protoReq]).catch(() => []);
    } else {
      if (!vpn.validUser(raw)) {
        return ctx.reply('❌ Nama akun 3-20 karakter, huruf/angka saja. Ketik nama lain, atau ketik batal:');
      }
      rows = await all('SELECT * FROM vpn_accounts WHERE username = ? AND telegram_id = ?', [nama, ctx.from.id]).catch(() => []);
    }
    if (!rows.length) {
      return ctx.reply('❌ Akun tidak ditemukan di daftar akunmu. Ketik nama lain, atau ketik batal:');
    }
    if (rows.length > 1) {
      const protos = rows.map((a) => a.proto.toUpperCase()).join(', ');
      return ctx.reply(
        `Nama <code>${esc(nama)}</code> ada di beberapa protokol: <code>${esc(protos)}</code>. ` +
        `Ketik <b>nama:protokol</b>, contoh: <code>${esc(nama)}:${esc(rows[0].proto)}</code>, atau ketik batal:`,
        { parse_mode: 'HTML', ...cancelKb() }
      );
    }
    const acc = rows[0];
    sessions.set(ctx.chat.id, { step: 'renew_days', accountId: acc.id });
    const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
    const _rpDay = await vpn.getVpnPrice(acc.proto, role, !!acc.via_cf);
    return ctx.reply(
      `♻️ <b>Renew Akun</b>\n\n` +
      `👤 Username: <code>${esc(acc.username)}</code>\n` +
      `📅 Exp saat ini: <code>${esc(acc.expiry)}</code>\n\n` +
      `Harga: <b>Rp${_rpDay.toLocaleString('id-ID')}/hari</b> (${role})\n` +
      `Kirim <b>durasi perpanjangan (hari)</b>:`,
      { parse_mode: 'HTML', ...cancelKb() }
    );
  }

  // --- Session cek kuota ---
  if (sess?.step === 'kuota_nomor') {
    sessions.delete(chatId);
    const r = await kuota.cekKuota(ctx.message.text.trim());
    return ctx.reply(r.message, { parse_mode: 'HTML' });
  }

  // --- Session cari produk PPOB: keyword ---
  if (sess?.step === 'ppob_cari') {
    const kw = ctx.message.text.trim();
    sessions.delete(chatId);
    if (!kw || kw.length < 2) {
      return ctx.reply('❌ Kata kunci minimal 2 karakter. Coba lagi dari menu PPOB.');
    }
    if (kw.length > 40) {
      return ctx.reply('❌ Kata kunci terlalu panjang (maks 40 karakter).');
    }
    return showProductList(ctx, 'cari:' + kw);
  }

  // --- Session beli PPOB: tujuan (tombol daftar produk ATAU input kode manual) ---
  if (sess?.step === 'ppob_tujuan') {
    let tujuan = ctx.message.text.trim();
    if (!tujuan || tujuan.length < 5) {
      return ctx.reply('❌ Nomor tujuan tidak valid. Coba lagi:');
    }
    const d = sess.data || {};
    if (d.category || d.brand) {
      const spec = digi.destinationSpec(d.category, d.brand);
      const tokens = tujuan.split(/\s+/).filter(Boolean);
      if (spec.tokens === 1) {
        tujuan = tokens.join('');
        if (!tujuan || tujuan.length < 5) return ctx.reply('❌ Nomor tujuan tidak valid. Coba lagi:');
      } else if (tokens.length !== spec.tokens) {
        return ctx.reply(`❌ Format tujuan salah. Harus ${spec.tokens} bagian (${esc(spec.label)}), contoh: <code>${esc(spec.placeholder)}</code>. Coba lagi:`);
      } else {
        tujuan = tokens.join(' ');
      }
    }
    sessions.delete(chatId);
    // Animasi loading: edit SATU pesan yang sama selama transaksi berjalan.
    const loadFrames = ['⏳ Memproses pembelian...', '⌛ Memproses pembelian...', '🔄 Memproses pembelian...'];
    let loadIdx = 0;
    let loadMsg = null;
    try { loadMsg = await ctx.reply(loadFrames[0]); } catch {}
    const loadTimer = loadMsg ? setInterval(async () => {
      loadIdx = (loadIdx + 1) % loadFrames.length;
      try { await ctx.telegram.editMessageText(loadMsg.chat.id, loadMsg.message_id, undefined, loadFrames[loadIdx]); } catch {}
    }, 1000) : null;
    const stopLoading = () => { if (loadTimer) clearInterval(loadTimer); };
    let sku = d.sku, price = d.price, productName = d.productName;
    if (!sku && d.kode) {
      // Alur input kode manual: cari produk & harga dari daftar
      const list = await ppob.productList().catch(() => ({ items: [] }));
      const prod = (list.items || []).find((p) => p.buyer_sku_code.toUpperCase() === String(d.kode).toUpperCase());
      if (!prod) { stopLoading(); return ctx.reply('❌ Kode produk tidak ditemukan. Lihat /produk'); }
      sku = prod.buyer_sku_code; price = prod.price_sell; productName = prod.product_name;
    }
    if (!sku) { stopLoading(); return ctx.reply('❌ Data produk tidak lengkap. Ulangi dari menu PPOB.'); }
    let r;
    try { r = await ppob.buyProduct(ctx.from.id, sku, tujuan, price); }
    finally { stopLoading(); }
    if (r.success) {
      const uname = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
      notifGrup(bot, `🛒 <b>Pembelian PPOB</b>\n👤 ${uname}\n📦 ${productName || sku}\n📱 ${tujuan}\n💰 Rp${Number(price).toLocaleString('id-ID')}`);
    }
    return ctx.reply(r.message, { parse_mode: 'HTML' });
  }

  // --- Session sewa: username lisensi ---
  if (sess?.step === 'sewa_username') {
    const username = ctx.message.text.trim();
    if (!sewa.validUsername(username)) {
      return ctx.reply('❌ Username tidak valid (3-20 karakter, huruf/angka). Coba lagi:');
    }
    sess.data = { username };
    sess.step = 'sewa_ip';
    return ctx.reply('Kirim <b>IP VPS</b> kamu (contoh: 103.150.116.158):', { parse_mode: 'HTML' });
  }

  if (sess?.step === 'sewa_ip') {
    const ip = ctx.message.text.trim();
    if (!sewa.validIp(ip)) {
      return ctx.reply('❌ IP tidak valid. Contoh: 103.150.116.158\nCoba lagi:');
    }
    const { days, data } = sess;
    const { username } = data;
    sessions.delete(chatId);
    await ctx.reply('⏳ Membuat QRIS pembayaran...');
    const r = await sewa.createSewaOrder(ctx.from.id, username, ip, days).catch((e) => ({ success: false, message: `❌ ${esc(e.message)}` }));
    if (!r.success) return ctx.reply(r.message);
    const caption =
      `💰 <b>Sewa Script ${r.days} Hari</b>\n` +
      `👤 Username: <code>${r.username}</code>\n` +
      `🖥️ IP VPS: <code>${r.ip}</code>\n` +
      `💵 Bayar: <b>${digi.rp(r.uniqueAmount || r.amount)}</b>\n` +
      `Ref: <code>${r.ref}</code>\n\n` +
      `Scan QRIS di atas untuk bayar, lalu tekan tombol cek di bawah.`;
    const kb = Markup.inlineKeyboard([[sBtn('✅ Cek Pembayaran', `sewa_cek_${r.ref}`, 'success')]]);
    if (r.qrBuffer) return ctx.replyWithPhoto({ source: r.qrBuffer }, { caption, parse_mode: 'HTML', reply_markup: kb.reply_markup });
    return ctx.reply(caption + `\n${r.qrUrl || ''}`, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
  }




  // ============================================================
  // --- Session PANEL ADMIN ---
  // ============================================================
  // Tambah server: nama
  if (sess?.step === 'adm_addserver_nama') {
    const nama = ctx.message.text.trim();
    if (!nama || nama.length < 2) return ctx.reply('❌ Nama terlalu pendek. Coba lagi:');
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    sess.data.nama = nama;
    sess.step = 'adm_addserver_domain';
    return ctx.reply(`➕ <b>Tambah Server</b>\n\nNama: <b>${esc(nama)}</b>\n\nKetik <b>domain server</b> (contoh: sgdo2.satsetvpn.web.id):`, { parse_mode: 'HTML' });
  }

  // Tambah server: domain
  if (sess?.step === 'adm_addserver_domain') {
    const domain = ctx.message.text.trim();
    if (!domain || domain.length < 4) return ctx.reply('❌ Domain tidak valid. Coba lagi:');
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    sess.data.domain = domain;
    sess.step = 'adm_addserver_api';
    return ctx.reply(`➕ <b>Tambah Server</b>\n\nNama: <b>${esc(sess.data.nama)}</b>\nDomain: <code>${esc(domain)}</code>\n\nKetik <b>API base server</b> (contoh: http://1.2.3.4:5890 atau https://api.server.com):`, { parse_mode: 'HTML' });
  }

  // Tambah server: api_base
  if (sess?.step === 'adm_addserver_api') {
    const apiBase = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!/^https?:\/\//.test(apiBase)) return ctx.reply('❌ API base harus diawali http:// atau https://. Coba lagi:');
    sess.data.api_base = apiBase;
    sess.step = 'adm_addserver_key';
    return ctx.reply(`➕ <b>Tambah Server</b>\n\nNama: <b>${esc(sess.data.nama)}</b>\nDomain: <code>${esc(sess.data.domain)}</code>\nAPI: <code>${esc(apiBase)}</code>\n\nKetik <b>API key (auth) server</b> — ketik <b>-</b> bila API tanpa auth:`, { parse_mode: 'HTML' });
  }

  // Tambah server: api_key (boleh kosong bila API tanpa auth)
  if (sess?.step === 'adm_addserver_key') {
    const key = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    sess.data.api_auth = (key === '-') ? '' : key;
    sess.step = 'adm_addserver_harga';
    return ctx.reply(`➕ <b>Tambah Server</b>\n\nNama: <b>${esc(sess.data.nama)}</b>\nDomain: <code>${esc(sess.data.domain)}</code>\nAPI: <code>${esc(sess.data.api_base)}</code>\n🔑 Key: <b>${sess.data.api_auth ? 'terisi' : 'kosong (tanpa auth)'}</b>\n\nKetik <b>harga per hari</b> (angka saja, contoh: 500):`, { parse_mode: 'HTML' });
  }

  // Tambah server: harga -> health check -> simpan (hanya bila sehat)
  if (sess?.step === 'adm_addserver_harga') {
    const harga = parseInt(ctx.message.text.replace(/\D/g, ''), 10);
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!harga || harga < 0) return ctx.reply('❌ Harga tidak valid. Ketik angka saja (contoh: 500):');
    const d = sess.data;
    const apiBase = srvTools.normalizeApiBase(d.api_base);
    // Gerbang kesehatan (model bot-baru): API server itu HARUS menjawab
    // /health dengan status success SEBELUM server diaktifkan. Gagal =
    // tidak disimpan sama sekali (bukan disimpan lalu nonaktif).
    const health = await srvTools.checkServerHealth(apiBase).catch(() => ({ ok: false, message: 'Health check gagal (error internal).' }));
    if (!health.ok) {
      sessions.delete(chatId);
      return ctx.reply(
        `❌ <b>Server TIDAK ditambahkan — health check gagal.</b>\n\n📝 Nama: <b>${esc(d.nama)}</b>\n🌐 Domain: <code>${esc(d.domain)}</code>\n🔌 API: <code>${esc(apiBase)}</code>\n\nAlasan: ${esc(health.message)}\n\nServer tidak diaktifkan. Perbaiki api_base / server itu, lalu ulangi dari ➕ Tambah Server.`,
        { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
      );
    }
    const { run } = require('./src/db');
    // Negara terdeteksi otomatis dari IP/host API (untuk bendera di
    // pemilih server); gagal deteksi -> '' (admin bisa isi via Edit Negara).
    const hostM = String(apiBase || '').match(/https?:\/\/([^:/]+)/);
    const srvCountry = hostM ? await country.detectCountry(hostM[1]).catch(() => '') : '';
    const r = await run('INSERT INTO servers (nama, domain, api_base, api_auth, harga, country, active) VALUES (?,?,?,?,?,?,1)',
      [d.nama, d.domain, apiBase, d.api_auth || '', harga, srvCountry]);
    sessions.delete(chatId);
    return ctx.reply(
      `✅ <b>Server ditambahkan!</b>\n\n🆔 ID: <code>${r.id}</code>\n📝 Nama: <b>${esc(d.nama)}</b>\n🌐 Domain: <code>${esc(d.domain)}</code>\n🔌 API: <code>${esc(apiBase)}</code>\n🔑 Key: <b>${d.api_auth ? 'terisi' : 'kosong (tanpa auth)'}</b>\n💲 Harga: <b>Rp${harga.toLocaleString('id-ID')}/hari</b>\n${country.flagFor(srvCountry)} Negara: <b>${esc(srvCountry || 'belum terdeteksi — isi via 🌍 Edit Negara')}</b>\n🟢 Status: <b>AKTIF (health check lolos)</b>`,
      { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
    );
  }

  // ============================================================
  // --- Session: Install Server Baru (SSH + installer --remote) ---
  // ============================================================
  // Install server baru: IP VPS
  if (sess?.step === 'adm_installsrv_ip') {
    const ip = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!installServer.validIp(ip)) return ctx.reply('❌ IP tidak valid. Ketik IPv4 VPS baru (contoh: 146.190.107.177):');
    sess.data.ip = ip;
    sess.step = 'adm_installsrv_domain';
    return ctx.reply(`🖥️ <b>Install Server Baru</b>\n\n📡 IP: <code>${esc(ip)}</code>\n\nKetik <b>domain server</b> (contoh: sgdo2.satsetvpn.web.id) — ketik <b>-</b> bila belum ada domain:`, { parse_mode: 'HTML' });
  }

  // Install server baru: domain (atau -)
  if (sess?.step === 'adm_installsrv_domain') {
    const raw = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const domain = (raw === '-') ? '' : raw;
    if (domain && !installServer.validDomain(domain)) return ctx.reply('❌ Domain tidak valid (huruf, angka, titik, strip saja). Coba lagi atau ketik -:');
    sess.data.domain = domain;
    sess.step = 'adm_installsrv_nama';
    return ctx.reply(`🖥️ <b>Install Server Baru</b>\n\n📡 IP: <code>${esc(sess.data.ip)}</code>\n🌐 Domain: <code>${esc(domain || '-')}</code>\n\nKetik <b>nama server</b> (contoh: SGDO-2):`, { parse_mode: 'HTML' });
  }

  // Install server baru: nama
  if (sess?.step === 'adm_installsrv_nama') {
    const nama = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!nama || nama.length < 2) return ctx.reply('❌ Nama terlalu pendek. Coba lagi:');
    sess.data.nama = nama;
    sess.step = 'adm_installsrv_harga';
    return ctx.reply(`🖥️ <b>Install Server Baru</b>\n\n📡 IP: <code>${esc(sess.data.ip)}</code>\n🌐 Domain: <code>${esc(sess.data.domain || '-')}</code>\n📝 Nama: <b>${esc(nama)}</b>\n\nKetik <b>harga per hari</b> (angka saja, contoh: 500):`, { parse_mode: 'HTML' });
  }

  // Install server baru: harga -> konfirmasi (tombol Ya/Batal)
  if (sess?.step === 'adm_installsrv_harga') {
    const harga = parseInt(ctx.message.text.replace(/\D/g, ''), 10);
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!harga || harga < 0) return ctx.reply('❌ Harga tidak valid. Ketik angka saja (contoh: 500):');
    sess.data.harga = harga;
    const d = sess.data;
    sessions.set(chatId, { step: 'adm_installsrv_confirm', data: d });
    return ctx.reply(
      `🖥️ <b>Install Server Baru — Konfirmasi</b>\n\n📡 IP: <code>${esc(d.ip)}</code>\n🌐 Domain: <code>${esc(d.domain || '- (localhost saja)')}</code>\n📝 Nama: <b>${esc(d.nama)}</b>\n💲 Harga: <b>Rp${harga.toLocaleString('id-ID')}/hari</b>\n\nBot akan SSH ke VPS ini sebagai root dan menjalankan installer Darren mode remote (stack VPN saja, tanpa bot Telegram). Bila ada instalasi Darren lama di VPS itu, akan dibackup lalu dihapus total. Pastikan kunci SSH installer bot sudah ditambahkan ke VPS ini lewat konsol provider.\n\nLanjutkan?`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[sBtn('✅ Ya, instal', 'adm_installsrv_yes', 'success'), sBtn('🔙 Batal', 'adm_back', 'danger')]] },
      }
    );
  }

  // Install server baru: menunggu konfirmasi tombol (bukan ketikan)
  if (sess?.step === 'adm_installsrv_confirm') {
    return ctx.reply('⏳ Menunggu konfirmasi — ketuk <b>✅ Ya, instal</b> atau <b>🔙 Batal</b> di pesan konfirmasi di atas.', { parse_mode: 'HTML' });
  }

  // Edit harga: ketik harga baru dari keyboard
  if (sess?.step === 'adm_editharga_input') {
    const harga = parseInt(ctx.message.text.replace(/\D/g, ''), 10);
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!harga || harga < 0) return ctx.reply('❌ Harga tidak valid. Ketik angka saja (contoh: 500):');
    const { run, get } = require('./src/db');
    await run('UPDATE servers SET harga = ? WHERE id = ?', [harga, sess.data.serverId]);
    const s = await get('SELECT * FROM servers WHERE id = ?', [sess.data.serverId]);
    sessions.delete(chatId);
    return ctx.reply(
      `✅ <b>Harga diperbarui!</b>\n\n📝 Server: <b>${esc(s.nama)}</b>\n💲 Harga baru: <b>Rp${Number(s.harga).toLocaleString('id-ID')}/hari</b>`,
      { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
    );
  }

  // Edit nama: ketik nama baru
  if (sess?.step === 'adm_editnama_input') {
    const nama = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!nama || nama.length < 2) return ctx.reply('❌ Nama terlalu pendek. Coba lagi:');
    const { run } = require('./src/db');
    await run('UPDATE servers SET nama = ? WHERE id = ?', [nama, sess.data.serverId]);
    sessions.delete(chatId);
    return ctx.reply(`✅ Nama server diperbarui menjadi <b>${esc(nama)}</b>`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // Edit API key: ketik key baru (atau - untuk kosong; nilai tidak ditampilkan)
  if (sess?.step === 'adm_editkey_input') {
    const key = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const apiAuth = (key === '-') ? '' : key;
    const { run } = require('./src/db');
    await run('UPDATE servers SET api_auth = ? WHERE id = ?', [apiAuth, sess.data.serverId]);
    sessions.delete(chatId);
    return ctx.reply(`✅ API key server diperbarui (${apiAuth ? 'terisi' : 'kosong / tanpa auth'})`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // Edit API base: ketik API base baru
  if (sess?.step === 'adm_editapi_input') {
    const apiBase = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!/^https?:\/\//.test(apiBase)) return ctx.reply('❌ API base harus diawali http:// atau https://. Coba lagi:');
    const { run } = require('./src/db');
    await run('UPDATE servers SET api_base = ? WHERE id = ?', [apiBase, sess.data.serverId]);
    sessions.delete(chatId);
    return ctx.reply(`✅ API base server diperbarui menjadi <code>${esc(apiBase)}</code>`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // Edit domain: ketik domain baru
  if (sess?.step === 'adm_editdomain_input') {
    const domain = ctx.message.text.trim();
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    if (!domain || domain.length < 4) return ctx.reply('❌ Domain tidak valid. Coba lagi:');
    const { run } = require('./src/db');
    await run('UPDATE servers SET domain = ? WHERE id = ?', [domain, sess.data.serverId]);
    sessions.delete(chatId);
    return ctx.reply(`✅ Domain server diperbarui menjadi <code>${esc(domain)}</code>`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // Ubah harga VPN per role: ketik angka (Rp/hari)
  if (sess?.step === 'adm_price_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const harga = parseInt(ctx.message.text.replace(/\D/g, ''), 10);
    if (!Number.isFinite(harga) || harga < 0) return ctx.reply('❌ Harga tidak valid. Ketik angka saja (contoh: 500):');
    const { key, role, viaCF } = sess.data;
    sessions.delete(chatId);
    try {
      await vpn.setVpnPrice(key, role, harga, !!viaCF);
      return ctx.reply(
        `✅ <b>Harga diperbarui!</b>\n\n📦 Produk: <b>${esc(key)}</b>\n👤 Role: <b>${role}</b>\n🏷️ Jenis: <b>${viaCF ? 'CloudFront' : 'Biasa'}</b>\n💲 Harga baru: <b>Rp${harga.toLocaleString('id-ID')}/hari</b>`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      return ctx.reply(`❌ ${esc(e.message)}`);
    }
  }

  // Ubah role user: ketik ID Telegram
  if (sess?.step === 'adm_role_id') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const uid = parseInt(ctx.message.text.replace(/\D/g, ''), 10);
    if (!uid) return ctx.reply('❌ ID tidak valid. Ketik angka saja:');
    sessions.delete(chatId);
    const cur = await ppob.getRole(uid).catch(() => 'member');
    return ctx.reply(
      `✏️ <b>Ubah Role User</b>\n\n🆔 ID: <code>${uid}</code>\n📌 Role saat ini: <b>${cur}</b>\n\nPilih role baru:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [sBtn('🛡️ Admin', `adm_roleset_${uid}_admin`, 'danger'), sBtn('🤝 Reseller', `adm_roleset_${uid}_reseller`, 'success')],
            [sBtn('👤 Member', `adm_roleset_${uid}_member`, 'primary')],
          ],
        },
      }
    );
  }

  // Tambah saldo: format "userId jumlah"
  if (sess?.step === 'adm_addsaldo_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const parts = ctx.message.text.trim().split(/\s+/);
    const uid = Number(parts[0]);
    const amt = Number((parts[1] || '').replace(/\D/g, ''));
    if (!uid || !amt || amt <= 0) return ctx.reply('❌ Format salah. Contoh: <code>123456 50000</code>', { parse_mode: 'HTML' });
    const s = await ppob.addSaldo(uid, amt);
    sessions.delete(chatId);
    notifGrup(bot, `💰 <b>Topup Saldo</b>\n👤 ID: <code>${uid}</code>\n💵 Rp${amt.toLocaleString('id-ID')}\n✅ Saldo baru: Rp${Number(s).toLocaleString('id-ID')}`);
    return ctx.reply(`✅ Saldo user <code>${uid}</code> ditambah Rp${amt.toLocaleString('id-ID')}.\nSaldo baru: <b>${digi.rp(s)}</b>`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // Kurangi saldo: format "userId jumlah"
  if (sess?.step === 'adm_minsaldo_input') {
    if (!await admin.hasAdminAccess(ctx)) { sessions.delete(chatId); return ctx.reply('❌ Khusus admin.'); }
    const parts = ctx.message.text.trim().split(/\s+/);
    const uid = Number(parts[0]);
    const amt = Number((parts[1] || '').replace(/\D/g, ''));
    if (!uid || !amt || amt <= 0) return ctx.reply('❌ Format salah. Contoh: <code>123456 10000</code>', { parse_mode: 'HTML' });
    const cur = await ppob.getSaldo(uid);
    if (cur < amt) { sessions.delete(chatId); return ctx.reply(`❌ Saldo user <code>${uid}</code> hanya ${digi.rp(cur)}, tidak bisa dikurangi Rp${amt.toLocaleString('id-ID')}.`, { parse_mode: 'HTML' }); }
    const { run } = require('./src/db');
    await run('UPDATE users SET saldo = saldo - ? WHERE telegram_id = ?', [amt, uid]);
    const s = await ppob.getSaldo(uid);
    sessions.delete(chatId);
    return ctx.reply(`✅ Saldo user <code>${uid}</code> dikurangi Rp${amt.toLocaleString('id-ID')}.\nSaldo baru: <b>${digi.rp(s)}</b>`, {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  }

  // --- Session deposit nominal ---
  if (sess?.step === 'deposit_nominal') {
    const nominal = parseInt(ctx.message.text.replace(/\D/g, ''), 10);
    const depRole = await ppob.getRole(ctx.from.id).catch(() => 'member');
    const minDep = depRole === 'admin' ? 0 : await settings.getMinDeposit(depRole).catch(() => 10000);
    if (!nominal || (minDep > 0 && nominal < minDep)) {
      sessions.delete(chatId);
      return ctx.reply(
        minDep > 0
          ? `❌ Nominal minimal deposit ${depRole === 'reseller' ? 'Reseller' : 'Member'}: <b>${digi.rp(minDep)}</b>`
          : '❌ Nominal deposit harus lebih dari 0.',
        { parse_mode: 'HTML' }
      );
    }
    // Deposit hanya lewat GoPay QRIS (H2H milik sendiri) — tanpa pilih metode.
    sessions.delete(chatId);
    await ctx.reply('⏳ Membuat QRIS...');
    const r = await ppob.createDeposit(ctx.from.id, nominal);
    if (!r.success) return ctx.reply(r.message);
    const caption = `💳 <b>Deposit ${digi.rp(nominal)}</b>\nRef: <code>${r.ref}</code>\n\nScan QRIS di atas untuk bayar. Saldo masuk otomatis setelah pembayaran terdeteksi.\n⏰ QRIS berlaku 5 menit.`;
    if (r.qrBuffer) return ctx.replyWithPhoto({ source: r.qrBuffer }, { caption, parse_mode: 'HTML' });
    return ctx.reply(caption + `\n${r.qrUrl || ''}`, { parse_mode: 'HTML' });
  }
});

async function finishCreateVpn(ctx, sess, username, password = '', days = 30) {
  sessions.delete(ctx.chat.id);
  const { proto, viaCF, serverId } = sess;
  const srv = await vpn.getServer(serverId).catch(() => null);
  // Harga VPN per role (diatur admin di tabel vpn_prices; role admin = 0/modal)
  const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
  const perDay = await vpn.getVpnPrice(proto, role, viaCF);
  const totalHarga = perDay * days;
  // Cek saldo
  const saldo = await ppob.getSaldo(ctx.from.id);
  if (saldo < totalHarga) {
    return ctx.reply(
      `❌ <b>Saldo tidak cukup.</b>\n` +
      `💰 Harga (${days} hari): <b>Rp${totalHarga.toLocaleString('id-ID')}</b>\n` +
      `💳 Saldo kamu: <b>Rp${saldo.toLocaleString('id-ID')}</b>\n\n` +
      `Silakan topup dulu via menu <b>💰 Saldo</b>.`,
      { parse_mode: 'HTML' }
    );
  }
  await ctx.reply('⏳ Membuat akun...');
  let r;
  try {
    if (proto === 'ssh') {
      r = viaCF
        ? vpn.cfSSHInfo(username, password, days, srv)
        : await vpn.createSSH(username, password, days, 1, srv);
      // Untuk mode CF, akun SSH tetap dibuat di server dulu
      if (viaCF && r.success) await vpn.createSSH(username, password, days, 1, srv).catch(() => {});
    } else if (proto === 'vmess') r = await vpn.createVMess(username, days, viaCF, srv);
    else if (proto === 'vless') r = await vpn.createVLess(username, days, viaCF, srv);
    else if (proto === 'shadowsocks') r = await vpn.createShadowsocks(username, days, viaCF, srv);
    else if (proto === 'zivpn') r = await vpn.createZivpn(username, password, days, srv);
    else r = await vpn.createTrojan(username, days, viaCF, srv);
  } catch (e) {
    r = { success: false, message: `❌ Error: ${esc(e.message)}` };
  }
  // Potong saldo jika berhasil
  if (r.success) {
    await ppob.deductSaldo(ctx.from.id, totalHarga);
    const { run } = require('./src/db');
    await run('INSERT INTO transactions (telegram_id, type, amount, ref_id, status) VALUES (?,?,?,?,?)',
      [ctx.from.id, 'vpn_' + proto, totalHarga, 'VPN' + Date.now().toString(36).toUpperCase(), 'success']).catch(() => {});
    // Notif ke grup
    const uname = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
    notifGrup(bot, `🛒 <b>Pembelian VPN</b>\n👤 ${uname}\n📦 ${proto.toUpperCase()}${viaCF ? ' (CF)' : ''} - ${days} hari\n🌐 Server: <b>${esc(srv ? srv.nama : 'Utama')}</b>\n💰 Rp${totalHarga.toLocaleString('id-ID')}`);
  }
  if (r.success) await vpn.saveAccount(ctx.from.id, proto, username, r.expiry, 0, viaCF ? 1 : 0, null, serverId || 0);
  // Tombol download .hc jika berhasil dan HC tersedia
  let extra = { parse_mode: 'HTML' };
  if (r.success && (await hc.hcEnabled()) && ['vmess', 'vless', 'trojan', 'ssh'].includes(proto)) {
    const cacheKey = ctx.from.id + '_' + proto + '_' + username;
    hcCache.set(cacheKey, {
      proto, username,
      uuid: r.uuid || '', password: r.password || '',
      domain: viaCF ? config.cloudfront.domain : (srv?.domain || config.vpn.domain),
    });
    // Hapus cache lama (max 100 entri)
    if (hcCache.size > 100) {
      const firstKey = hcCache.keys().next().value;
      hcCache.delete(firstKey);
    }
    extra.reply_markup = {
      inline_keyboard: [[
        { text: '📱 Download .hc', callback_data: 'hc_dl_' + cacheKey }
      ]]
    };
  }
  if (r.success) {
    const _att = vpn.attachSave(proto, username, r.message, srv);
    r.message = _att.message; r.saveUrl = _att.saveUrl;
  }
  const expRows = exportRowsFor(ctx, proto, username, r, viaCF, srv);
  if (expRows.length) {
    const kb = (extra.reply_markup && extra.reply_markup.inline_keyboard) || [];
    extra.reply_markup = { inline_keyboard: [...expRows, ...kb] };
  }
  await ctx.reply(r.message, extra);
}

// Kirim notifikasi transaksi ke grup (ID dikonfigurasi via panel admin;
// fallback ke GROUP_NOTIF bila belum dikonfigurasi)
async function notifGrup(bot, pesan) {
  try {
    const gid = (await settings.getNotifGroup().catch(() => '')) || GROUP_NOTIF;
    if (!gid) return;
    await bot.telegram.sendMessage(gid, pesan, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) { /* abaikan jika gagal */ }
}

// ---------- Download .hc ----------
bot.action(/^hc_dl_(.+)$/, async (ctx) => {
  await safeCb(ctx);
  const cacheKey = ctx.match[1];
  const info = hcCache.get(cacheKey);
  if (!info) {
    await ctx.reply('❌ Data akun tidak ditemukan. Buat akun baru dulu.');
    return;
  }
  // Tanya pilih config — semua preset dari hc.presetList() (12 preset)
  const presets = hc.presetList();
  const keyboard = presets.map((p) => [{ text: p.label, callback_data: 'hc_go_' + p.id + '_' + cacheKey }]);
  await ctx.reply('Pilih config untuk file .hc:', {
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action(/^hc_go_(.+)$/, async (ctx) => {
  await safeCb(ctx);
  const rest = ctx.match[1];
  // Ambil preset dari daftar presetList (id terpanjang dulu),
  // sisanya adalah cacheKey (userId_proto_username, boleh mengandung underscore).
  const sortedPresetIds = hc.presetList().map((p) => p.id).sort((a, b) => b.length - a.length);
  let preset = null;
  let cacheKey = null;
  for (const id of sortedPresetIds) {
    if (rest.startsWith(id + '_')) { preset = id; cacheKey = rest.slice(id.length + 1); break; }
  }
  if (!preset || !hc.HC_PRESETS[preset] || !cacheKey) {
    await ctx.reply('❌ Preset .hc tidak dikenal. Pilih lagi dari menu Download .hc.');
    return;
  }
  const info = hcCache.get(cacheKey);
  if (!info) {
    await ctx.reply('❌ Data akun tidak ditemukan. Buat akun baru dulu.');
    return;
  }
  await ctx.reply('⏳ Membuat file .hc...');
  const res = await hc.generateHC({
    service: info.proto,
    username: info.username,
    uuid: info.uuid,
password: info.password,
    domain: info.domain,
    preset: preset,
  });
  if (!res.success) {
    await ctx.reply('❌ ' + res.message, { parse_mode: 'HTML' });
    return;
  }
  await ctx.replyWithDocument(
    { source: res.buffer, filename: res.filename },
    { caption: '📱 File <b>' + res.filename + '</b> untuk <code>' + info.username + '</code>',
      parse_mode: 'HTML' }
  );
});

// ---------- Menu Sewa Script ----------
bot.action('menu_sewa', async (ctx) => {
  await safeCb(ctx);
  const orders = await sewa.mySewaOrders(ctx.from.id).catch(() => []);
  const orderList = Array.isArray(orders) ? orders : [];
  const aktif = orderList.filter((o) => o && o.status === 'fulfilled');
  const lines = aktif.slice(0, 3).map((o) =>
    `• <code>${esc(o.username)}</code> (<code>${esc(o.ip)}</code>) — ${o.days} hari${o.expiry ? ` s/d ${o.expiry}` : ''}`
  );
  await sendMenuPhoto(ctx, 'banner-utama.webp',
    `💰 <b>SEWA SCRIPT VPN</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 <b>Daftar Paket:</b>\n<blockquote>${sewa.packageListText()}</blockquote>\n\n` +
    (lines.length ? `📋 <b>Sewamu (aktif):</b>\n<blockquote>${lines.join('\n')}</blockquote>\n\n` : ``) +
    `Pilih paket di bawah ini:`,
    Markup.inlineKeyboard([
      [sBtn('📦 30 Hari', 'sewa_pkg_30', 'primary'), sBtn('📦 60 Hari', 'sewa_pkg_60', 'primary')],
      [sBtn('📦 90 Hari', 'sewa_pkg_90', 'primary')],
      [sBtn('📋 Status Sewaku', 'sewa_status', 'success')],
      [sBtn('🔙 Kembali', 'menu_main', 'danger')],
    ]));
});

for (const d of [30, 60, 90]) {
  bot.action(`sewa_pkg_${d}`, async (ctx) => {
    await safeCb(ctx);
    const pkg = sewa.PACKAGES.find((p) => p.days === d);
    sessions.set(ctx.chat.id, { step: 'sewa_username', days: d });
    await ctx.reply(
      `💰 <b>Sewa Script — ${d} Hari</b>\n` +
      `💵 Harga: <b>${digi.rp(pkg.price)}</b>\n\n` +
      `Kirim <b>username lisensi</b> (3-20 karakter, huruf/angka):`,
      { parse_mode: 'HTML', ...cancelKb() }
    );
  });
}

bot.action('sewa_status', async (ctx) => {
  await safeCb(ctx);
  const orders = await sewa.mySewaOrders(ctx.from.id).catch(() => []);
  if (!orders.length) {
    return ctx.reply('📭 Kamu belum pernah sewa script.', { parse_mode: 'HTML' });
  }
  const stMap = { pending: '⏳ menunggu bayar', paid: '✅ lunas, aktivasi segera', fulfilled: '🟢 aktif', failed: '❌ gagal', review: '⚠️ menunggu verifikasi admin', expired: '⌛ kedaluwarsa' };
  const lines = orders.map((o, i) =>
    `${i + 1}. <code>${esc(o.username || '-')}</code> (<code>${esc(o.ip || '-')}</code>)\n` +
    `   📦 ${o.days} hari — ${stMap[o.status] || esc(o.status)}${o.expiry ? ` s/d ${o.expiry}` : ''}`
  );
  await ctx.reply(`💰 <b>Status Sewa Script</b>\n━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
});

// Cek pembayaran sewa: sewa_cek_<ref>
bot.action(/^sewa_cek_(.+)$/, async (ctx) => {
  await safeCb(ctx);
  const ref = ctx.match[1];
  const order = await sewa.getSewaOrder(ref).catch(() => null);
  if (!order) return ctx.reply('❌ Order tidak ditemukan.');
  // FIXED: only the owner (or an admin) may trigger activation for an order.
  if (order.telegram_id !== ctx.from.id && !(await admin.hasAdminAccess(ctx).catch(() => false))) {
    return ctx.reply('❌ Order ini bukan milikmu.');
  }
  if (order.status === 'fulfilled') return ctx.reply('✅ Lisensimu sudah aktif!');
  // Registrasi / percobaan ulang registrasi IP ke repo GitHub
  const doRegister = async () => {
    const reg = await ipregistry.registerIp(order.username, order.days, order.ip);
    if (reg.success) {
      await sewa.markSewaFulfilled(ref, reg.expiry);
      return ctx.reply(
        `✅ <b>Lisensi aktif!</b>\n\n` +
        `👤 Username: <code>${esc(order.username)}</code>\n` +
        `🌐 IP: <code>${esc(order.ip)}</code>\n` +
        `📅 Berlaku s.d: <b>${esc(reg.expiry)}</b>\n\n` +
        `Silakan install / restart script di VPS kamu.`,
        { parse_mode: 'HTML' }
      );
    }
    return ctx.reply(
      `✅ <b>Pembayaran diterima!</b>\n\n` +
      `Registrasi lisensi belum berhasil (${esc(reg.message)}). Tekan tombol cek lagi sebentar, atau hubungi admin.`,
      { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[sBtn('🔄 Coba Registrasi Lagi', `sewa_cek_${ref}`, 'primary')]]).reply_markup }
    );
  };
  if (order.status === 'paid') return doRegister();
  const st = await sewa.checkSewaPayment(order.payment_id).catch(() => ({ status: 'unknown', paidAmount: null }));
  if (h2h.isPaidStatus(st.status)) {
    // FASE 1: paid TANPA field amount = TIDAK terverifikasi — jangan
    // aktifkan; tandai review untuk pemeriksaan manual.
    if (st.paidAmount == null) {
      await sewa.markSewaReview(ref).catch(() => {});
      return ctx.reply(`⚠️ <b>Pembayaran tercatat, menunggu verifikasi admin.</b>\n\nPembayaran order sewa kamu sudah tercatat di gateway, tapi nominalnya belum bisa diverifikasi otomatis sehingga lisensi BELUM diaktifkan.\n🧾 Ref: <code>${esc(ref)}</code>\nAdmin akan memeriksa manual — jangan bayar ulang.`, { parse_mode: 'HTML' });
    }
    // Verifikasi nominal (BARU di rombak H2H): tombol cek manual juga tidak
    // boleh mengaktifkan order bila nominal gateway tidak cocok.
    if (Math.abs(Number(st.paidAmount) - Number(order.amount)) > 1000) {
      return ctx.reply(`❌ Nominal pembayaran tidak cocok (tercatat <b>${digi.rp(order.amount)}</b>). Hubungi admin.`, { parse_mode: 'HTML' });
    }
    await sewa.markSewaPaid(ref);
    return doRegister();
  }
  if (h2h.isExpiredStatus(st.status)) {
    await sewa.markSewaExpired(ref).catch(() => {});
    return ctx.reply('❌ QRIS sudah kedaluwarsa. Buat order sewa baru.', { parse_mode: 'HTML' });
  }
  await ctx.reply(`⏳ Belum ada pembayaran terdeteksi (status: <code>${esc(st.status)}</code>).\nScan QRIS dulu, lalu tekan tombol cek lagi.`, { parse_mode: 'HTML' });
});

// ---------- Admin: daftar sewa ----------
bot.command('sewalist', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return;
  const { all } = require('./src/db');
  const rows = await all(`SELECT * FROM sewa_orders ORDER BY id DESC LIMIT 15`).catch(() => []);
  const orderRows = Array.isArray(rows) ? rows : [];
  if (!orderRows.length) return ctx.reply('📭 Belum ada order sewa.');
  const lines = orderRows.map((o, i) =>
    `${i + 1}. <code>${o.username || '-'}</code> ${o.ip || '-'} — ${o.days}hr [${esc(o.status)}]`
  );
  await ctx.reply(`💰 <b>Order Sewa Terakhir</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
});


// ---------- Admin: hapus akun siapa pun ----------
// ---------- Hapus akun ketik-nama-saja ----------
async function showHapusNamaList(ctx) {
  const rows = await vpn.myAccounts(ctx.from.id).catch(() => []);
  if (!rows.length) return ctx.reply('📭 Kamu belum punya akun VPN.');
  const lines = rows.map((a, n) =>
    `${n + 1}. <code>${esc(a.username)}</code> (${esc(a.proto.toUpperCase())})${a.via_cf ? ' ☁️CF' : ''} — Exp: ${esc(a.expiry)}`
  );
  sessions.set(ctx.chat.id, { step: 'hapus_nama' });
  await ctx.reply(
    `🗑️ <b>Hapus Akun</b>\n━━━━━━━━━━━━━━━━━━\n<blockquote>${lines.join('\n')}</blockquote>\n\n` +
    `Ketik <b>nama akun</b> yang mau dihapus (atau ketik <b>batal</b>):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
}
bot.command('hapusakun', async (ctx) => {
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const username = parts[1], proto = (parts[2] || '').toLowerCase();
  if (!username) return showHapusNamaList(ctx);
  if (!await admin.hasAdminAccess(ctx)) return ctx.reply('❌ Hapus akun orang lain khusus admin. Untuk akun sendiri, pakai /hapusakun tanpa argumen.');
  if (!proto || !['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn'].includes(proto))
    return ctx.reply('Penggunaan: /hapusakun <username> <ssh|vmess|vless|trojan|shadowsocks|zivpn>\nAtau /hapusakun saja untuk hapus akun sendiri dengan ketik nama.');
  const { get } = require('./src/db');
  const acc = await get('SELECT * FROM vpn_accounts WHERE username = ? AND proto = ?', [username, proto]).catch(() => null);
  if (!acc) return ctx.reply('❌ Akun tidak ditemukan di database bot.');
  const srv = await vpn.getServer(acc.server_id).catch(() => null);
  const r = await vpn.deleteAccount(proto, username, srv);
  await ctx.reply(r.success ? `🗑️ ${r.message}` : `❌ Gagal: ${esc(r.message || 'API error')}`, { parse_mode: 'HTML' });
});
bot.action('menu_hapus_nama', async (ctx) => {
  await safeCb(ctx);
  await showHapusNamaList(ctx);
});
bot.action(/^delconfadm_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  if (!await admin.hasAdminAccess(ctx)) return ctx.reply('❌ Khusus admin.');
  const { get } = require('./src/db');
  const acc = await get('SELECT * FROM vpn_accounts WHERE id = ?', [ctx.match[1]]).catch(() => null);
  if (!acc) return ctx.reply('❌ Akun tidak ditemukan.');
  const srv = await vpn.getServer(acc.server_id).catch(() => null);
  const r = await vpn.deleteAccount(acc.proto, acc.username, srv);
  await ctx.reply(r.success ? `🗑️ ${r.message}` : `❌ Gagal: ${esc(r.message || 'API error')}`, { parse_mode: 'HTML' });
});


// ---------- Renew akun ketik-nama-saja ----------
async function showRenewNamaList(ctx) {
  const rows = await vpn.myAccounts(ctx.from.id).catch(() => []);
  if (!rows.length) return ctx.reply('📭 Kamu belum punya akun VPN.');
  const lines = rows.map((a, n) =>
    `${n + 1}. <code>${esc(a.username)}</code> (${esc(a.proto.toUpperCase())})${a.via_cf ? ' ☁️CF' : ''} — Exp: ${esc(a.expiry)}`
  );
  sessions.set(ctx.chat.id, { step: 'renew_nama' });
  await ctx.reply(
    `♻️ <b>Renew Akun</b>\n━━━━━━━━━━━━━━━━━━\n<blockquote>${lines.join('\n')}</blockquote>\n\n` +
    `Ketik <b>nama akun</b> yang mau diperpanjang (atau ketik <b>batal</b>):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
}
bot.command('renewakun', async (ctx) => {
  await showRenewNamaList(ctx);
});
bot.action('menu_renew_nama', async (ctx) => {
  await safeCb(ctx);
  await showRenewNamaList(ctx);
});


// ---------- Akun Saya (dengan paginasi) ----------
const AKUN_PER_PAGE = 10;
function akunKeyboard(page, pages, slice = []) {
  const row = [];
  if (page > 1) row.push({ text: '◀️ Prev', callback_data: `akun_page_${page - 1}` });
  if (page < pages) row.push({ text: 'Next ▶️', callback_data: `akun_page_${page + 1}` });
  const kb = [];
  if (row.length) kb.push(row);
  kb.push([{ text: '♻️ Renew (Ketik Nama)', callback_data: 'menu_renew_nama' }]);
  kb.push([{ text: '🗑️ Hapus (Ketik Nama)', callback_data: 'menu_hapus_nama' }]);
  kb.push([{ text: '🔙 Kembali', callback_data: 'menu_main' }]);
  return { inline_keyboard: kb };
}
function akunPageText(rows, page) {
  const pages = Math.max(1, Math.ceil(rows.length / AKUN_PER_PAGE));
  const pg = Math.min(Math.max(1, Number(page) || 1), pages);
  const slice = rows.slice((pg - 1) * AKUN_PER_PAGE, pg * AKUN_PER_PAGE);
  const lines = slice.map((a, i) => {
    const n = (pg - 1) * AKUN_PER_PAGE + i + 1;
    return `${n}. <b>${esc(a.proto.toUpperCase())}</b> <code>${esc(a.username)}</code>\n   📅 Exp: ${esc(a.expiry)}${a.via_cf ? ' ☁️CF' : ''}${a.is_trial ? ' 🎁trial' : ''}`;
  });
  return {
    text: `👤 <b>AKUN SAYA</b>\n━━━━━━━━━━━━━━━━━━\n📄 Halaman <b>${pg}</b> dari <b>${pages}</b>\n\n<blockquote>${lines.join('\n')}</blockquote>`,
    page: pg, pages, slice,
  };
}
bot.action('menu_akun', async (ctx) => {
  await safeCb(ctx);
  const rows = await vpn.myAccounts(ctx.from.id);
  if (!rows.length) {
    return sendMenuPhoto(ctx, 'menu-akun.png',
      `👤 <b>AKUN SAYA</b>\n━━━━━━━━━━━━━━━━━━\n\n📭 Kamu belum punya akun VPN.\nBuat dulu di menu VPN ya!`, backBtn());
  }
  const { text, page, pages, slice } = akunPageText(rows, 1);
  await sendMenuPhoto(ctx, 'menu-akun.png', text, { reply_markup: akunKeyboard(page, pages, slice) });
});
bot.action(/^akun_page_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  const rows = await vpn.myAccounts(ctx.from.id);
  if (!rows.length) return;
  const { text, page, pages, slice } = akunPageText(rows, parseInt(ctx.match[1], 10));
  const extra = { parse_mode: 'HTML', reply_markup: akunKeyboard(page, pages, slice) };
  try { await ctx.editMessageCaption(text, extra); }
  catch (e1) {
    try { await ctx.editMessageText(text, extra); }
    catch (e2) { await ctx.reply(text, extra); }
  }
});

// ============================================================
// ---------- Panel Reseller ----------
// ============================================================
const isResellerOrAdmin = async (ctx) => {
  if (await admin.hasAdminAccess(ctx)) return true;
  const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
  return role === 'reseller';
};

const resellerPanel = () => Markup.inlineKeyboard([
  [sBtn('💰 Harga Modal Saya', 'rsl_prices', 'primary'), sBtn('➕ Buat Akun VPN', 'rsl_create', 'success')],
  [sBtn('📋 Riwayat Transaksi', 'rsl_history', 'primary'), sBtn('💳 Saldo Saya', 'rsl_saldo', 'success')],
  [sBtn('🔙 Kembali', 'menu_main', 'danger')],
]);

bot.action('menu_reseller', async (ctx) => {
  await safeCb(ctx);
  if (!await isResellerOrAdmin(ctx)) return ctx.reply('❌ Khusus reseller.');
  const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
  const saldo = await ppob.getSaldo(ctx.from.id).catch(() => 0);
  await ctx.reply(
    `🏪 <b>PANEL RESELLER</b> ${settings.roleBadge(role)}\n━━━━━━━━━━━━━━━━━━\n\n` +
    `💳 Saldo: <b>Rp${Number(saldo).toLocaleString('id-ID')}</b>\n\n` +
    `Pilih menu di bawah ini:`,
    { parse_mode: 'HTML', reply_markup: resellerPanel().reply_markup }
  );
});

// a. Harga modal reseller
bot.action('rsl_prices', async (ctx) => {
  await safeCb(ctx);
  if (!await isResellerOrAdmin(ctx)) return ctx.reply('❌ Khusus reseller.');
  const protos = ['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn'];
  const labels = { ssh: '🖥️ SSH', vmess: '📡 VMess', vless: '⚡ VLess', trojan: '🛡️ Trojan', shadowsocks: '👻 Shadowsocks', zivpn: '🚀 Zivpn UDP' };
  const lines = [];
  for (const p of protos) {
    const harga = await vpn.getVpnPrice(p, 'reseller');
    lines.push(`${labels[p]}: <b>Rp${Number(harga).toLocaleString('id-ID')}/hari</b>`);
  }
  await ctx.reply(
    `💰 <b>Harga Modal Reseller</b>\n━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n')}\n\n<i>Harga per hari. Admin = Rp0 (modal).</i>`,
    { parse_mode: 'HTML', reply_markup: resellerPanel().reply_markup }
  );
});

// b. Buat akun VPN (pakai alur yang sudah ada — harga otomatis sesuai role)
bot.action('rsl_create', async (ctx) => {
  await safeCb(ctx);
  if (!await isResellerOrAdmin(ctx)) return ctx.reply('❌ Khusus reseller.');
  const saldo = await ppob.getSaldo(ctx.from.id).catch(() => 0);
  await ctx.reply(
    `➕ <b>Buat Akun VPN</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
    `💳 Saldo kamu: <b>Rp${Number(saldo).toLocaleString('id-ID')}</b>\n` +
    `Harga sesuai tarif reseller.\n\nPilih protokol:`,
    { parse_mode: 'HTML', reply_markup: vpnMenu(false).reply_markup }
  );
});

// c. Riwayat transaksi reseller
bot.action('rsl_history', async (ctx) => {
  await safeCb(ctx);
  if (!await isResellerOrAdmin(ctx)) return ctx.reply('❌ Khusus reseller.');
  const { all } = require('./src/db');
  const rows = await all(
    'SELECT type, amount, status, created_at FROM transactions WHERE telegram_id = ? ORDER BY rowid DESC LIMIT 15',
    [ctx.from.id]
  ).catch(() => []);
  if (!rows.length) {
    return ctx.reply('📋 <b>Riwayat Transaksi</b>\n\n📭 Belum ada transaksi.', {
      parse_mode: 'HTML', reply_markup: resellerPanel().reply_markup,
    });
  }
  const lines = rows.map((r, i) => {
    const tgl = r.created_at ? new Date(r.created_at).toLocaleDateString('id-ID') : '-';
    return `${i + 1}. <code>${esc(r.type || '-')}</code> — Rp${Number(r.amount || 0).toLocaleString('id-ID')} (${esc(r.status || '-')}) <i>${tgl}</i>`;
  });
  await ctx.reply(
    `📋 <b>Riwayat Transaksi</b> (15 terakhir)\n━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n')}`,
    { parse_mode: 'HTML', reply_markup: resellerPanel().reply_markup }
  );
});

// d. Saldo reseller
bot.action('rsl_saldo', async (ctx) => {
  await safeCb(ctx);
  if (!await isResellerOrAdmin(ctx)) return ctx.reply('❌ Khusus reseller.');
  const saldo = await ppob.getSaldo(ctx.from.id).catch(() => 0);
  await ctx.reply(
    `💳 <b>Saldo Saya</b>\n━━━━━━━━━━━━━━━━━━\n\n💰 Saldo: <b>Rp${Number(saldo).toLocaleString('id-ID')}</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [sBtn('💰 Topup Saldo', 'ppob_deposit', 'success')],
        [sBtn('🔙 Kembali', 'menu_reseller', 'danger')],
      ]).reply_markup,
    }
  );
});

// ---------- Renew Akun ----------
bot.action(/^renew_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  const { get } = require('./src/db');
  const acc = await get('SELECT * FROM vpn_accounts WHERE id = ? AND telegram_id = ?', [ctx.match[1], ctx.from.id]);
  if (!acc) return ctx.reply('❌ Akun tidak ditemukan.');
  sessions.set(ctx.chat.id, { step: 'renew_days', accountId: acc.id });
  const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
  const _rpDay = await vpn.getVpnPrice(acc.proto, role, !!acc.via_cf);
  await ctx.reply(
    `♻️ <b>Renew Akun</b>\n\n` +
    `F464 Username: <code>${esc(acc.username)}</code>\n` +
    `📅 Exp saat ini: <code>${esc(acc.expiry)}</code>\n\n` +
    `Harga: <b>Rp${_rpDay.toLocaleString('id-ID')}/hari</b> (${role})\n` +
    `Kirim <b>durasi perpanjangan (hari)</b>:`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

bot.action(/^del_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  const { get } = require('./src/db');
  const acc = await get('SELECT * FROM vpn_accounts WHERE id = ? AND telegram_id = ?', [ctx.match[1], ctx.from.id]);
  if (!acc) return ctx.reply('❌ Akun tidak ditemukan.');
  await ctx.reply(
    `🗑️ <b>Hapus Akun?</b>\n\n` +
    `👤 Username: <code>${esc(acc.username)}</code>\n` +
    `📦 Protokol: <code>${esc(acc.proto.toUpperCase())}</code>${acc.via_cf ? ' ☁️CF' : ''}\n\n` +
    `Akun akan dihapus dari server dan daftar akunmu. Tindakan ini tidak bisa dibatalkan.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: '✅ Ya, Hapus', callback_data: `delconf_${acc.id}` }],
      [{ text: '❌ Batal', callback_data: 'menu_akun' }],
    ] } }
  );
});
bot.action(/^delconf_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  const { get } = require('./src/db');
  const acc = await get('SELECT * FROM vpn_accounts WHERE id = ? AND telegram_id = ?', [ctx.match[1], ctx.from.id]);
  if (!acc) return ctx.reply('❌ Akun tidak ditemukan.');
  const srv = await vpn.getServer(acc.server_id).catch(() => null);
  const r = await vpn.deleteAccount(acc.proto, acc.username, srv);
  await ctx.reply(r.success ? `🗑️ ${r.message}` : `❌ Gagal menghapus: ${esc(r.message || 'API error')}`, { parse_mode: 'HTML' });
});

async function finishRenew(ctx, accountId, days) {
  sessions.delete(ctx.chat.id);
  const { get, run } = require('./src/db');
  const acc = await get('SELECT * FROM vpn_accounts WHERE id = ? AND telegram_id = ?', [accountId, ctx.from.id]);
  if (!acc) return ctx.reply('❌ Akun tidak ditemukan.');
  const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
  const totalHarga = (await vpn.getVpnPrice(acc.proto, role, !!acc.via_cf)) * days; // harga per role (admin = 0)
  const saldo = await ppob.getSaldo(ctx.from.id);
  if (saldo < totalHarga) {
    return ctx.reply(
      `❌ <b>Saldo tidak cukup.</b>\n` +
      `💰 Harga (${days} hari): <b>Rp${totalHarga.toLocaleString('id-ID')}</b>\n` +
      `💳 Saldo kamu: <b>Rp${saldo.toLocaleString('id-ID')}</b>`,
      { parse_mode: 'HTML' }
    );
  }
  // Hitung expiry baru: tambah hari ke expiry saat ini (atau dari sekarang jika sudah lewat)
  const now = new Date();
  const cur = new Date(acc.expiry + 'T00:00:00');
  const base = (cur > now) ? cur : now;
  base.setDate(base.getDate() + days);
  const newExpiry = base.toISOString().slice(0, 10);
  await ctx.reply('⏳ Memperpanjang akun...');
  // FASE 1: renew HANYA bila API mengonfirmasi success. Dulu blok ini
  // best-effort (.catch(()=>{})) lalu tetap UPDATE expiry + potong saldo,
  // sehingga user membayar padahal akun tidak diperpanjang.
  let renewOk = false;
  let renewErr = '';
  try {
    const axios = require('axios');
    const config = require('./src/config');
    const srv = await vpn.getServer(acc.server_id).catch(() => null);
    const renewBase = (srv && srv.api_base) || config.vpn.apiBase;
    const renewAuth = (srv && srv.api_auth) || config.vpn.apiAuth;
    const res = await axios.get(`${renewBase}/renew`, {
      params: { auth: renewAuth, proto: acc.proto, user: acc.username, exp: days },
      timeout: 25000,
    });
    renewOk = res?.data?.status === 'success';
    if (!renewOk) renewErr = res?.data?.message || 'API renew gagal';
  } catch (e) {
    renewOk = false;
    renewErr = 'API renew tidak merespons (timeout/jaringan)';
  }
  if (!renewOk) {
    return ctx.reply(
      `❌ <b>Renew gagal.</b>\n\nAkun <code>${esc(acc.username)}</code> TIDAK diperpanjang dan saldo TIDAK terpotong.\nAlasan: ${esc(renewErr)}\nSilakan coba lagi atau hubungi admin.`,
      { parse_mode: 'HTML' }
    );
  }
  await run('UPDATE vpn_accounts SET expiry = ? WHERE id = ?', [newExpiry, accountId]);
  await ppob.deductSaldo(ctx.from.id, totalHarga);
  await run('INSERT INTO transactions (telegram_id, type, amount, ref_id, status) VALUES (?,?,?,?,?)',
    [ctx.from.id, 'renew_' + acc.proto, totalHarga, 'RNW' + Date.now().toString(36).toUpperCase(), 'success']).catch(() => {});
  const uname = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
  notifGrup(bot, `♻️ <b>Renew VPN</b>\n👤 ${uname}\n📦 ${acc.proto.toUpperCase()} <code>${esc(acc.username)}</code>\n📅 +${days} hari → ${newExpiry}\n💰 Rp${totalHarga.toLocaleString('id-ID')}`);
  await ctx.reply(
    `✅ <b>Akun diperpanjang!</b>\n\n` +
    `F464 Username: <code>${esc(acc.username)}</code>\n` +
    `📅 Exp baru: <code>${newExpiry}</code> (+${days} hari)\n` +
    `💰 Biaya: <b>Rp${totalHarga.toLocaleString('id-ID')}</b>`,
    { parse_mode: 'HTML' }
  );
}

// ---------- Menu PPOB ----------
bot.action('menu_ppob', async (ctx) => {
  await safeCb(ctx);
  const saldo = await ppob.getSaldo(ctx.from.id);
  const role = await ppob.getRole(ctx.from.id).catch(() => 'member');
  await sendMenuPhoto(ctx, 'banner-ppob.webp',
    `🛒 <b>PPOB RIPZZ STORE</b>
Belanja kebutuhan digital otomatis — cepat, aman & 24 jam.

` +
    `👤 Role: <b>${settings.roleBadge(role)}</b>
` +
    `💰 Saldo: <b>${digi.rp(saldo)}</b>

` +
    `⚡ <i>Harga mengikuti role kamu.</i>
` +
    `Pilih kategori layanan:`,
    ppobCategoryKeyboard());
});

// Keyboard kategori PPOB (2 kolom, ala screenshot)
function ppobCategoryKeyboard() {
  const btns = ppobLayout.CATEGORY_BUTTONS || [];
  const rows = [];
  // Baris deposit di atas
  rows.push([sBtn('💰 Deposit / Top Up', 'ppob_deposit', 'success')]);
  for (let i = 0; i < btns.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, btns.length); j++) {
      const [group, label] = btns[j];
      row.push(sBtn(label, 'ppob_cat_' + group, j % 2 === 0 ? 'success' : 'primary'));
    }
    rows.push(row);
  }
  rows.push([sBtn('🔍 CARI PRODUK', 'ppob_cari', 'primary'), sBtn('⭐ POPULER', 'ppob_populer', 'danger')]);
  rows.push([sBtn('📱 Prabayar', 'ppob_prabayar', 'primary'), sBtn('🧾 Pascabayar', 'ppob_pascabayar', 'primary')]);
  rows.push([sBtn('📋 Cek Order', 'ppob_cekorder', 'primary'), sBtn('🏠 Menu Utama', 'menu_main', 'success')]);
  return Markup.inlineKeyboard(rows);
}

bot.action('ppob_deposit', async (ctx) => {
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'deposit_nominal' });
  const bonus = await ppob.getBonusConfig().catch(() => ({}));
  const bonusTxt = bonus?.enabled
    ? `\n🎁 <b>Bonus ${bonus.bonus_percent}%</b> untuk topup min. <b>${digi.rp(bonus.min_topup)}</b>!`
    : '';
  const depRole0 = await ppob.getRole(ctx.from.id).catch(() => 'member');
  const minDep0 = depRole0 === 'admin' ? 0 : await settings.getMinDeposit(depRole0).catch(() => 10000);
  const minDepTxt = depRole0 === 'admin' ? '(tanpa minimal, khusus admin)' : minDep0 > 0 ? `(min ${digi.rp(minDep0)})` : '(tanpa minimal)';
  await ctx.reply(`💰 Kirim <b>nominal deposit</b> ${minDepTxt}:${bonusTxt}`, { parse_mode: 'HTML', ...cancelKb() });
});

// Tampilkan daftar produk PPOB (dipakai tombol Beli & Daftar Produk)
// Bila kategori memakai layer provider dan belum pilih provider → tampilkan pilih provider dulu
async function showProductList(ctx, group, page = 1) {
  await safeCb(ctx);
  const gstr = String(group || '');
  const base = gstr.split(':')[0].toLowerCase();
  if (ppob.hasProviders(base) && !gstr.includes(':')) {
    return showProviders(ctx, base);
  }
  const r = await ppob.productList(group, page)
    .catch((e) => ({ success: false, message: `❌ ${esc(e.message)}` }));
  if (!r.success) { await ctx.reply(r.message, { parse_mode: 'HTML' }); return; }
  if (r.pageItems) prodCache.set(ctx.from.id, { pageItems: r.pageItems, page: r.page, group: group || '', _ts: Date.now() });
  const extra = { parse_mode: 'HTML', reply_markup: ppob.productKeyboard(r.page, r.pages, r.pageItems, group || '') };
  try { await ctx.editMessageText(r.message, extra); }
  catch (e) { await ctx.reply(r.message, extra); }
}

// Layar pilih provider untuk kategori PPOB (ala bot RIPZZ)
async function showProviders(ctx, group) {
  await safeCb(ctx);
  const names = await ppob.getProviderNames(group).catch(() => null);
  if (!names || !names.length) return showProductList(ctx, group);
  const grpDef = ppob.CATEGORY_GROUPS[group];
  const title = grpDef ? grpDef.title : `📦 <b>${esc(group)}</b>`;
  const text = `${title}\nPilih provider:`;
  const extra = { parse_mode: 'HTML', reply_markup: ppob.providerKeyboard(group, names) };
  try { await ctx.editMessageText(text, extra); }
  catch (e) { await ctx.reply(text, extra); }
}

bot.action('ppob_beli', async (ctx) => {
  await showProductList(ctx, 'pulsa');
});

bot.action('ppob_produk', async (ctx) => {
  await showProductList(ctx, 'lainnya');
});

// Kategori PPOB (tombol grid): ppob_cat_<group>
bot.action(/^ppob_cat_([a-z0-9-]+)$/, async (ctx) => {
  await showProductList(ctx, ctx.match[1]);
});

// Provider PPOB: ppob_prov_<group>_<provider> → daftar produk "group:provider"
bot.action(/^ppob_prov_([a-z0-9-]+)_(.+)$/, async (ctx) => {
  await showProductList(ctx, ctx.match[1] + ':' + ctx.match[2].trim());
});

// Prabayar / Pascabayar
bot.action('ppob_prabayar', async (ctx) => {
  await showProductList(ctx, 'prabayar');
});
bot.action('ppob_pascabayar', async (ctx) => {
  await showProductList(ctx, 'pascabayar');
});

// Produk populer
bot.action('ppob_populer', async (ctx) => {
  await showProductList(ctx, 'populer');
});

// Cari produk — minta keyword via session
bot.action('ppob_cari', async (ctx) => {
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'ppob_cari' });
  await ctx.reply('🔍 Kirim <b>kata kunci</b> produk yang dicari (contoh: <code>telkomsel 10</code>):', { parse_mode: 'HTML', ...cancelKb() });
});
bot.action(/^prod_page_([a-zA-Z0-9-: .]*?)_(\d+)$/, async (ctx) => {
  await showProductList(ctx, ctx.match[1] || undefined, parseInt(ctx.match[2], 10));
});

// Tombol beli produk PPOB
bot.action(/^prod_buy_([a-zA-Z0-9-: .]*?)_(\d+)_(\d+)$/, async (ctx) => {
  await safeCb(ctx);
  const page = parseInt(ctx.match[2], 10);
  const idx = parseInt(ctx.match[3], 10);
  const cached = prodCache.get(ctx.from.id);
  if (!cached || !cached.pageItems || (cached._ts && Date.now() - cached._ts > 30 * 60 * 1000) || cached.page !== page || (cached.group || '') !== (ctx.match[1] || '') || !cached.pageItems[idx]) {
    await ctx.reply('❌ Produk tidak ditemukan / halaman kadaluarsa. Buka daftar produk lagi.');
    return;
  }
  const p = cached.pageItems[idx];
  sessions.set(ctx.chat.id, {
    step: 'ppob_tujuan',
    data: { sku: p.buyer_sku_code, price: p.price_sell, productName: p.product_name, category: p.category, brand: p.brand },
  });
  const spec = digi.destinationSpec(p.category, p.brand);
  await ctx.reply(
    '🛒 <b>' + esc(p.product_name) + '</b>\n' +
    '💰 Harga: <b>' + digi.rp(p.price_sell) + '</b>\n\n' +
    'Kirim <b>' + esc(spec.label) + '</b> (contoh: <code>' + esc(spec.placeholder) + '</code>):',
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

bot.action('ppob_cekorder', async (ctx) => {
  await safeCb(ctx);
  await ctx.reply('📦 Kirim <b>ref order</b> dengan perintah:\n<code>/cekorder REFID</code>', { parse_mode: 'HTML' });
});

bot.command('cekorder', async (ctx) => {
  const ref = ctx.message.text.split(' ')[1];
  if (!ref) return ctx.reply('Contoh: <code>/cekorder PPOBABC123</code>', { parse_mode: 'HTML' });
  const r = await ppob.checkOrder(ref.trim().toUpperCase());
  await ctx.reply(r.message, { parse_mode: 'HTML' });
});

bot.command('saldo', async (ctx) => {
  const s = await ppob.getSaldo(ctx.from.id);
  await ctx.reply(`💰 Saldo kamu: <b>${digi.rp(s)}</b>`, { parse_mode: 'HTML' });
});

bot.command('produk', async (ctx) => {
  await showProductList(ctx, 'lainnya');
});

bot.command('beli', async (ctx) => {
  const [, kode, tujuan] = ctx.message.text.split(' ');
  if (!kode || !tujuan) return ctx.reply('Contoh: <code>/beli TLKM5 087862591220</code>', { parse_mode: 'HTML' });
  const list = await ppob.productList().catch(() => ({ items: [] }));
  const prodItems = Array.isArray(list.items) ? list.items : [];
  const prod = prodItems.find((p) => p && p.buyer_sku_code && p.buyer_sku_code.toUpperCase() === kode.toUpperCase());
  if (!prod) return ctx.reply('❌ Kode produk tidak ditemukan. Lihat /produk');
  await ctx.reply('⏳ Memproses...');
  const r = await ppob.buyProduct(ctx.from.id, kode.toUpperCase(), tujuan, prod.price_sell);
  await ctx.reply(r.message, { parse_mode: 'HTML' });
});

// ---------- Cek Kuota ----------
bot.action('menu_riwayat', async (ctx) => {
  await safeCb(ctx);
  await ensureUser(ctx);
  const msg = await ppob.getHistory(ctx.from.id, 10);
  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: backBtn().reply_markup });
});

bot.action('menu_kuota', async (ctx) => {
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'kuota_nomor' });
  await ctx.reply('📡 Kirim <b>nomor HP</b> (contoh: 087862591220):', { parse_mode: 'HTML', ...cancelKb() });
});

// ---------- Statistik (admin lihat global, user lihat ringkas) ----------
bot.action('menu_stat', async (ctx) => {
  await safeCb(ctx);
  if (await admin.hasAdminAccess(ctx)) {
    const s = await admin.statistik();
    return sendMenuPhoto(ctx, 'menu-stat.png',
      `🟠 <b>STATISTIK SERVER</b>
━━━━━━━━━━━━━━━━━━

${s}`, backBtn());
  }
  const rows = await vpn.myAccounts(ctx.from.id);
  await sendMenuPhoto(ctx, 'menu-stat.png',
    `🟠 <b>STATISTIK</b>
━━━━━━━━━━━━━━━━━━

📊 Kamu punya <b>${rows.length}</b> akun VPN aktif.`, backBtn());
});

// ---------- Admin commands ----------
bot.command('broadcast', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return;
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Contoh: /broadcast Halo semua!');
  const ids = await admin.broadcastList();
  let ok = 0;
  for (const id of ids) {
    try { await ctx.telegram.sendMessage(id, `📢 <b>Pengumuman</b>\n\n${esc(text)}`, { parse_mode: 'HTML' }); ok++; }
    catch { /* skip blocked */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  await ctx.reply(`✅ Broadcast terkirim ke ${ok}/${ids.length} user.`);
});

bot.command('addsaldo', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return;
  const [, uid, amt] = ctx.message.text.split(' ');
  if (!uid || !amt) return ctx.reply('Contoh: <code>/addsaldo 123456 50000</code>', { parse_mode: 'HTML' });
  const r = await ppob.addSaldo(Number(uid), Number(amt));
  const bonusTxt = r.bonus > 0 ? `\n🎁 Bonus: Rp${Number(r.bonus).toLocaleString('id-ID')}` : '';
  notifGrup(bot, `💰 <b>Topup Saldo</b>\n👤 ID: <code>${uid}</code>\n💵 Rp${Number(amt).toLocaleString('id-ID')}${bonusTxt}\n✅ Saldo baru: Rp${Number(r.saldo).toLocaleString('id-ID')}`);
  await ctx.reply(`✅ Saldo user <code>${uid}</code> kini ${digi.rp(r.saldo)}${r.bonus > 0 ? ` (termasuk bonus ${digi.rp(r.bonus)})` : ''}`, { parse_mode: 'HTML' });
});

// ============================================================
// PANEL ADMIN — /admin + semua handler tombol
// ============================================================
bot.action('adm_open', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await sendMenuPhoto(ctx, 'menu-utama.png', await adminPanelText(), adminPanel());
});


// ---------- FASE 2: resolve manual deposit/sewa review/mismatch ----------
// Setujui deposit = klaim atomik yang sama dengan poller (BEGIN IMMEDIATE +
// guard status), jadi tidak pernah dobel kredit. Setujui sewa = status paid,
// lalu fulfillment cron yang sudah ada mengaktifkan lisensi.
async function approveReviewDeposit(ref) {
  try {
    await run('BEGIN IMMEDIATE');
    let r = await run(
      `UPDATE transactions SET status = 'success' WHERE ref_id = ? AND status = 'review'`,
      [ref]
    );
    if (!r.changes) {
      r = await run(
        `UPDATE transactions SET status = 'success' WHERE ref_id = ? AND status = 'pending' AND mismatch_notified = 1`,
        [ref]
      );
    }
    if (!r.changes) { await run('ROLLBACK'); return null; }
    const tx = await get(`SELECT * FROM transactions WHERE ref_id = ?`, [ref]);
    await ppob.addSaldo(tx.telegram_id, tx.amount);
    await run('COMMIT');
    return tx;
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    throw e;
  }
}

bot.action('adm_panel', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await ctx.reply(await adminPanelText(), { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup });
});

bot.action('adm_review', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const deps = await all(
    `SELECT * FROM transactions WHERE type = 'deposit' AND (status = 'review' OR (status = 'pending' AND mismatch_notified = 1)) ORDER BY id DESC LIMIT 20`
  ).catch(() => []);
  const sewas = await sewa.reviewSewaOrders().catch(() => []);
  let txt = '🔍 <b>REVIEW DEPOSIT / SEWA</b>\n\n';
  const kb = [];
  if (!deps.length && !sewas.length) txt += 'Tidak ada yang menunggu keputusan admin.';
  for (const d of deps) {
    txt += `💰 Deposit <code>${d.ref_id}</code> — ID <code>${d.telegram_id}</code> — Rp${Number(d.amount || 0).toLocaleString('id-ID')} — ${d.status === 'review' ? '⚠️ review (nominal tak terverifikasi)' : '⚠️ mismatch (nominal beda)'}\n`;
    kb.push([sBtn(`✅ Setujui ${d.ref_id}`, `adm_rev_dep_ok_${d.ref_id}`, 'success'), sBtn(`❌ Tolak ${d.ref_id}`, `adm_rev_dep_no_${d.ref_id}`, 'danger')]);
  }
  for (const s of sewas) {
    txt += `📦 Sewa <code>${s.payment_ref}</code> — ID <code>${s.telegram_id}</code> — ${s.days} hari — Rp${Number(s.amount || 0).toLocaleString('id-ID')} — ${s.status === 'review' ? '⚠️ review (nominal tak terverifikasi)' : '⚠️ mismatch (nominal beda)'}\n`;
    kb.push([sBtn(`✅ Setujui ${s.payment_ref}`, `adm_rev_sewa_ok_${s.payment_ref}`, 'success'), sBtn(`❌ Tolak ${s.payment_ref}`, `adm_rev_sewa_no_${s.payment_ref}`, 'danger')]);
  }
  kb.push([sBtn('🔙 Kembali ke Panel Admin', 'adm_panel', 'danger')]);
  await ctx.reply(txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
});

bot.action(/^adm_rev_dep_(ok|no)_(.+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const aksi = ctx.match[1];
  const ref = ctx.match[2];
  try {
    if (aksi === 'ok') {
      const tx = await approveReviewDeposit(ref);
      if (!tx) return ctx.reply(`❌ Deposit <code>${ref}</code> sudah diproses / tidak ditemukan.`, { parse_mode: 'HTML' });
      await bot.telegram.sendMessage(tx.telegram_id, `✅ <b>Deposit kamu disetujui admin.</b>\n💰 Saldo Rp${Number(tx.amount).toLocaleString('id-ID')} sudah ditambahkan.`, { parse_mode: 'HTML' }).catch(() => {});
      return ctx.reply(`✅ Deposit <code>${ref}</code> disetujui, saldo user ditambahkan.`, { parse_mode: 'HTML' });
    }
    const r = await run(`UPDATE transactions SET status = 'rejected' WHERE ref_id = ? AND (status = 'review' OR (status = 'pending' AND mismatch_notified = 1))`, [ref]);
    if (!r.changes) return ctx.reply(`❌ Deposit <code>${ref}</code> sudah diproses / tidak ditemukan.`, { parse_mode: 'HTML' });
    const tx = await get(`SELECT telegram_id FROM transactions WHERE ref_id = ?`, [ref]);
    if (tx) await bot.telegram.sendMessage(tx.telegram_id, `❌ <b>Deposit kamu ditolak admin.</b>\n🧾 Ref: <code>${ref}</code>\nHubungi admin bila merasa ini keliru.`, { parse_mode: 'HTML' }).catch(() => {});
    return ctx.reply(`❌ Deposit <code>${ref}</code> ditolak.`, { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(`❌ Gagal memproses <code>${ref}</code>: ${e.message}`, { parse_mode: 'HTML' });
  }
});

bot.action(/^adm_rev_sewa_(ok|no)_(.+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const aksi = ctx.match[1];
  const ref = ctx.match[2];
  try {
    if (aksi === 'ok') {
      const n = await sewa.resolveSewaPaid(ref);
      if (!n) return ctx.reply(`❌ Sewa <code>${ref}</code> sudah diproses / tidak ditemukan.`, { parse_mode: 'HTML' });
      const o = await sewa.getSewaOrder(ref);
      if (o) await bot.telegram.sendMessage(o.telegram_id, `✅ <b>Sewa kamu disetujui admin.</b>\n📦 Lisensi ${o.days} hari sedang diproses.`, { parse_mode: 'HTML' }).catch(() => {});
      return ctx.reply(`✅ Sewa <code>${ref}</code> disetujui, fulfillment cron akan mengaktifkan lisensi.`, { parse_mode: 'HTML' });
    }
    const n = await sewa.resolveSewaRejected(ref);
    if (!n) return ctx.reply(`❌ Sewa <code>${ref}</code> sudah diproses / tidak ditemukan.`, { parse_mode: 'HTML' });
    const o = await sewa.getSewaOrder(ref);
    if (o) await bot.telegram.sendMessage(o.telegram_id, `❌ <b>Sewa kamu ditolak admin.</b>\n🧾 Ref: <code>${ref}</code>\nHubungi admin bila merasa ini keliru.`, { parse_mode: 'HTML' }).catch(() => {});
    return ctx.reply(`❌ Sewa <code>${ref}</code> ditolak.`, { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(`❌ Gagal memproses <code>${ref}</code>: ${e.message}`, { parse_mode: 'HTML' });
  }
});

bot.action('adm_akun', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await ctx.reply(await adminPanelText(), { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup });
});

bot.command('admin', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return ctx.reply('❌ Khusus admin.');
  await safeCb(ctx).catch(() => {});
  await sendMenuPhoto(ctx, 'menu-utama.png',
    await adminPanelText(),
    adminPanel());
});

// ---------- Kelola Server ----------
// Tambah server: nama -> domain -> harga (ketik manual dari keyboard)
bot.action('adm_addserver', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_addserver_nama', data: {} });
  await ctx.reply('➕ <b>Tambah Server</b>\n\nKetik <b>nama server</b>:', { parse_mode: 'HTML', ...cancelKb() });
});

// Install server baru: IP -> domain -> nama -> harga -> konfirmasi -> SSH install
// (installer Darren mode --remote: stack VPN saja, tanpa bot Telegram).
bot.action('adm_installsrv', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_installsrv_ip', data: {} });
  // Kunci SSH installer tampil OTOMATIS di bot (kunci PUBLIK, aman
  // disalin) + perintah sekali-tempel untuk VPS yang sudah jadi,
  // supaya admin tidak perlu menanyakannya lagi dan tidak salah
  // tempel kunci sebagai perintah (kasus 2026-11-06: 'command not found').
  const pubKey = (typeof installServer.getInstallerPublicKey === 'function') ? installServer.getInstallerPublicKey() : null;
  const keyBlock = pubKey
    ? `\n\n🔑 <b>Pasang kunci SSH installer dulu — pilih 1 cara:</b>\n\n1️⃣ <b>Saat buat droplet</b> (paling mudah): di DigitalOcean, tambah kunci ini di bagian SSH keys:\n<code>${esc(pubKey)}</code>\n\n2️⃣ <b>Droplet sudah jadi:</b> buka terminal VPS baru, tempel perintah ini lalu Enter (sekali saja):\n<code>${esc(`mkdir -p ~/.ssh; echo '${pubKey}' >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; echo OK`)}</code>\n\nKalau muncul <b>OK</b>, kunci sudah terpasang. Kalau instalasi gagal di langkah SSH, berarti kunci belum terpasang.`
    : `\n\n⚠️ <b>Kunci SSH installer tidak ditemukan</b> di server bot — instalasi akan gagal di langkah SSH. Buat dulu keypair-nya.`;
  await ctx.reply(
    '🖥️ <b>Install Server Baru</b>\n\nBot akan menginstal stack VPN Darren (mode remote, tanpa bot Telegram) ke VPS baru lewat SSH, lalu mendaftarkan server itu otomatis.' + keyBlock + '\n\nKetik <b>IP VPS baru</b> (contoh: 146.190.107.177):',
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

bot.action('adm_installsrv_yes', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const sess = sessions.get(ctx.chat.id);
  const d = sess && sess.step === 'adm_installsrv_confirm' ? sess.data : null;
  sessions.delete(ctx.chat.id);
  if (!d || !d.ip) return ctx.reply('❌ Data instalasi tidak ditemukan (sesi kedaluwarsa). Ulangi dari 🖥️ Install Server Baru.');
  const apiBase = `http://${d.ip}:5890`;
  await ctx.reply(
    `⏳ <b>Menginstal server ${esc(d.nama)} (${esc(d.ip)})...</b>\n\nProses ini bisa 5–15 menit (apt, Node, Xray, PKI OpenVPN). Bot tetap bisa dipakai untuk hal lain, tapi jangan restart bot selama instalasi berjalan. Hasil instalasi akan dikirim di sini.`,
    { parse_mode: 'HTML' }
  );
  // BUGFIX 2026-11-06: instalasi 5–15 menit melebihi batas callback
  // Telegram (~90 detik) → Telegraf melempar 'Promise timed out after
  // 90000 milliseconds' dan bot.catch mengirim '❌ Terjadi kesalahan'
  // padahal instalasi tetap jalan lalu sukses. Jalankan instalasi
  // terlepas (detached): handler kembali seketika, hasil dikirim lewat
  // sendMessage saat selesai. ctx.telegram dipakai langsung (ctx.reply
  // tidak lagi andal setelah handler kembali).
  const chatId = ctx.chat.id;
  const send = (text, extra) => ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...(extra || {}) }).catch(() => {});
  const panel = () => adminPanel().reply_markup;
  (async () => {
  let inst;
  try {
    inst = await installServer.installRemoteServer({ ip: d.ip, domain: d.domain || '' });
  } catch (e) {
    inst = { ok: false, message: 'Install gagal (error internal bot: ' + (e.message || e) + ').', tail: '' };
  }
  if (!inst.ok) {
    await send(
      `❌ <b>Instalasi GAGAL — server TIDAK didaftarkan.</b>\n\n📡 IP: <code>${esc(d.ip)}</code>\n📝 Nama: <b>${esc(d.nama)}</b>\n\nAlasan: ${esc(inst.message || 'tidak diketahui')}\n\n${inst.tail ? `<b>Log akhir:</b>\n<pre>${esc(inst.tail.slice(-1500))}</pre>` : ''}\nPerbaiki VPS/kunci SSH-nya, lalu ulangi dari 🖥️ Install Server Baru.`,
      { reply_markup: panel() }
    );
    return;
  }
  // Instalasi sukses: baca kunci auth vpn-api, health check, lalu daftarkan.
  const apiAuth = await installServer.readRemoteAuth(d.ip).catch(() => null);
  if (!apiAuth) {
    await send(
      `⚠️ <b>Server terinstal, tapi kunci API tidak bisa dibaca.</b>\n\n📡 IP: <code>${esc(d.ip)}</code>\n📝 Nama: <b>${esc(d.nama)}</b>\n🔌 API: <code>${esc(apiBase)}</code>\n\nStack VPN sudah terpasang (installer lolos), tetapi bot tidak bisa membaca <code>/etc/vpn-api/auth.env</code> di VPS itu. Daftarkan manual via ➕ Tambah Server dengan API base di atas dan kunci dari file tersebut (baca lewat SSH manual).`,
      { reply_markup: panel() }
    );
    return;
  }
  const health = await srvTools.checkServerHealth(apiBase).catch(() => ({ ok: false, message: 'Health check gagal (error internal).' }));
  if (!health.ok) {
    await send(
      `⚠️ <b>Server terinstal, tapi health check API gagal.</b>\n\n📡 IP: <code>${esc(d.ip)}</code>\n📝 Nama: <b>${esc(d.nama)}</b>\n🔌 API: <code>${esc(apiBase)}</code>\n\nAlasan: ${esc(health.message)}\n\nServer TIDAK didaftarkan otomatis. Periksa service vpn-api di VPS itu, lalu daftarkan manual via ➕ Tambah Server.`,
      { reply_markup: panel() }
    );
    return;
  }
  const { run } = require('./src/db');
  // Negara terdeteksi otomatis dari IP (untuk bendera di pemilih server).
  const srvCountry = await country.detectCountry(d.ip).catch(() => '');
  const r = await run('INSERT INTO servers (nama, domain, api_base, api_auth, harga, country, active) VALUES (?,?,?,?,?,?,1)',
    [d.nama, d.domain || '', apiBase, apiAuth, d.harga, srvCountry]);
  await send(
    `✅ <b>Server baru terinstal & terdaftar!</b>\n\n🆔 ID: <code>${r.id}</code>\n📝 Nama: <b>${esc(d.nama)}</b>\n📡 IP: <code>${esc(d.ip)}</code>\n🌐 Domain: <code>${esc(d.domain || '-')}</code>\n🔌 API: <code>${esc(apiBase)}</code>\n🔑 Key: <b>terisi</b>\n💲 Harga: <b>Rp${Number(d.harga).toLocaleString('id-ID')}/hari</b>\n${country.flagFor(srvCountry)} Negara: <b>${esc(srvCountry || 'belum terdeteksi — isi via 🌍 Edit Negara')}</b>\n🟢 Status: <b>AKTIF (health check lolos)</b>\n\nServer ini sudah muncul di pilihan server saat beli/trial VPN.`,
    { reply_markup: panel() }
  );
  })().catch(() => {});
  return;
});

// ---------- Uninstall / Install Ulang / Monitoring Server ----------
// Server utama (bot, server2) TIDAK ada di tabel servers, tapi pengaman
// ini mencegah admin tidak sengaja meng-uninstall/install-ulang bot
// sendiri bila server utama sempat didaftarkan manual via Tambah Server.
async function isMainServerRow(s) {
  const m = String(s.api_base || '').match(/https?:\/\/([^:/]+)/);
  const host = m ? m[1] : '';
  if (!host) return false;
  if (host === '127.0.0.1' || host === 'localhost') return true;
  const mainIp = await installServer.getMainBotIp().catch(() => '');
  return !!mainIp && host === mainIp;
}
function serverIp(s) {
  const m = String(s.api_base || '').match(/https?:\/\/([^:/]+)/);
  return m ? m[1] : '';
}

// --- Uninstall Server ---
bot.action('adm_uninstallsrv', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via 🖥️ Install Server Baru.');
  const kb = rows.map((s) => [sBtn(`🗑️ ${s.nama} (${esc(s.domain || serverIp(s) || '-')})`, `adm_uninstallsrv_${s.id}`, 'danger')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('🗑️ <b>Uninstall Server</b>\n\nPilih server yang akan di-uninstall (stack VPN dihapus total, backup dulu):', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});
bot.action(/^adm_uninstallsrv_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  if (await isMainServerRow(s)) return ctx.reply('❌ Server utama (bot) tidak bisa di-uninstall dari sini.');
  await ctx.reply(
    `🗑️ <b>Uninstall Server?</b>\n\n📝 <b>${esc(s.nama)}</b> (ID <code>${s.id}</code>)\n📡 IP: <code>${esc(serverIp(s))}</code>\n🌐 Domain: <code>${esc(s.domain || '-')}</code>\n\nStack VPN (bot tidak ada di server ini) + Xray + OpenVPN + menu akan <b>dihapus total</b> (backup dulu di VPS itu). Akun VPN yang ada di server ini akan <b>berhenti berfungsi</b>. Server dihapus dari daftar bot.\n\nTindakan ini tidak bisa dibatalkan.`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[sBtn('✅ Ya, uninstall', `adm_uninstallsrv_yes_${id}`, 'danger'), sBtn('🔙 Batal', 'adm_back', 'primary')]] },
    }
  );
});
bot.action(/^adm_uninstallsrv_yes_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get, run } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  if (await isMainServerRow(s)) return ctx.reply('❌ Server utama (bot) tidak bisa di-uninstall dari sini.');
  const ip = serverIp(s);
  if (!ip) return ctx.reply('❌ IP server tidak bisa dibaca dari api_base.');
  await ctx.reply(
    `⏳ <b>Meng-uninstall server ${esc(s.nama)} (${esc(ip)})...</b>\n\nBackup + hapus stack (bisa beberapa menit). Jangan restart bot selama proses berjalan.`,
    { parse_mode: 'HTML' }
  );
  // Detached (lihat adm_installsrv_yes): uninstall menit-menit, jangan
  // tahan handler melewati batas callback ~90 detik.
  const chatId = ctx.chat.id;
  const send = (text, extra) => ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...(extra || {}) }).catch(() => {});
  const panel = () => adminPanel().reply_markup;
  (async () => {
  let un;
  try { un = await installServer.uninstallRemoteServer(ip); }
  catch (e) { un = { ok: false, message: 'Uninstall gagal (error internal bot: ' + (e.message || e) + ').', tail: '' }; }
  if (!un.ok) {
    await send(
      `❌ <b>Uninstall GAGAL — server tetap terdaftar.</b>\n\n📝 <b>${esc(s.nama)}</b>\n📡 IP: <code>${esc(ip)}</code>\n\nAlasan: ${esc(un.message || 'tidak diketahui')}\n\n${un.tail ? `<b>Log akhir:</b>\n<pre>${esc(un.tail.slice(-1500))}</pre>` : ''}\nPeriksa VPS/kunci SSH-nya, lalu ulangi.`,
      { reply_markup: panel() }
    );
    return;
  }
  await run('DELETE FROM servers WHERE id = ?', [id]);
  await send(
    `✅ <b>Server ter-uninstall & dihapus dari daftar.</b>\n\n📝 <b>${esc(s.nama)}</b>\n📡 IP: <code>${esc(ip)}</code>\n🌐 Domain: <code>${esc(s.domain || '-')}</code>\n\nStack VPN di VPS itu sudah dihapus total (backup tersimpan di VPS itu). Akun VPN di server ini sudah tidak berfungsi.`,
    { reply_markup: panel() }
  );
  })().catch(() => {});
  return;
});

// --- Install Ulang Server ---
bot.action('adm_reinstallsrv', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via 🖥️ Install Server Baru.');
  const kb = rows.map((s) => [sBtn(`🔄 ${s.nama} (${esc(s.domain || serverIp(s) || '-')})`, `adm_reinstallsrv_${s.id}`, 'primary')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('🔄 <b>Install Ulang Server</b>\n\nPilih server yang akan di-install ulang (uninstall total lalu install fresh — harga + domain dipertahankan):', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});
bot.action(/^adm_reinstallsrv_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  if (await isMainServerRow(s)) return ctx.reply('❌ Server utama (bot) tidak bisa di-install ulang dari sini.');
  await ctx.reply(
    `🔄 <b>Install Ulang Server?</b>\n\n📝 <b>${esc(s.nama)}</b> (ID <code>${s.id}</code>)\n📡 IP: <code>${esc(serverIp(s))}</code>\n🌐 Domain: <code>${esc(s.domain || '-')}</code>\n💲 Harga: <b>Rp${Number(s.harga).toLocaleString('id-ID')}/hari</b>\n\nStack lama dibackup lalu dihapus total, lalu install fresh (5–15 menit). Akun VPN lama di server ini <b>ikut terhapus</b> (Xray baru, akun kosong). Nama, domain, dan harga dipertahankan; kunci API baru dibaca otomatis.\n\nTindakan ini tidak bisa dibatalkan.`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[sBtn('✅ Ya, install ulang', `adm_reinstallsrv_yes_${id}`, 'primary'), sBtn('🔙 Batal', 'adm_back', 'primary')]] },
    }
  );
});
bot.action(/^adm_reinstallsrv_yes_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get, run } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  if (await isMainServerRow(s)) return ctx.reply('❌ Server utama (bot) tidak bisa di-install ulang dari sini.');
  const ip = serverIp(s);
  if (!ip) return ctx.reply('❌ IP server tidak bisa dibaca dari api_base.');
  const apiBase = `http://${ip}:5890`;
  await ctx.reply(
    `⏳ <b>Meng-install ulang server ${esc(s.nama)} (${esc(ip)})...</b>\n\nUninstall total lalu install fresh (bisa 5–15 menit). Jangan restart bot selama proses berjalan. Hasil akan dikirim di sini.`,
    { parse_mode: 'HTML' }
  );
  // Detached (lihat adm_installsrv_yes): install ulang menit-menit, jangan
  // tahan handler melewati batas callback ~90 detik.
  const chatId = ctx.chat.id;
  const send = (text, extra) => ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...(extra || {}) }).catch(() => {});
  const panel = () => adminPanel().reply_markup;
  (async () => {
  let re;
  try { re = await installServer.reinstallRemoteServer({ ip, domain: s.domain || '' }); }
  catch (e) { re = { ok: false, stage: '?', message: 'Install ulang gagal (error internal bot: ' + (e.message || e) + ').', tail: '' }; }
  if (!re.ok) {
    await send(
      `❌ <b>Install Ulang GAGAL di tahap ${esc(re.stage || '?')} — server tetap terdaftar dengan data lama.</b>\n\n📝 <b>${esc(s.nama)}</b>\n📡 IP: <code>${esc(ip)}</code>\n\nAlasan: ${esc(re.message || 'tidak diketahui')}\n\n${re.tail ? `<b>Log akhir:</b>\n<pre>${esc(re.tail.slice(-1500))}</pre>` : ''}\nPeriksa VPS/kunci SSH-nya, lalu ulangi.`,
      { reply_markup: panel() }
    );
    return;
  }
  const apiAuth = await installServer.readRemoteAuth(ip).catch(() => null);
  if (!apiAuth) {
    await send(
      `⚠️ <b>Server ter-install ulang, tapi kunci API baru tidak bisa dibaca.</b>\n\n📝 <b>${esc(s.nama)}</b>\n📡 IP: <code>${esc(ip)}</code>\n🔌 API: <code>${esc(apiBase)}</code>\n\nStack sudah fresh, tetapi bot tidak bisa membaca <code>/etc/vpn-api/auth.env</code> di VPS itu. Perbarui kunci API server ini manual via 🔑 Edit API Key (baca kunci dari file itu lewat SSH).`,
      { reply_markup: panel() }
    );
    return;
  }
  const health = await srvTools.checkServerHealth(apiBase).catch(() => ({ ok: false, message: 'Health check gagal (error internal).' }));
  if (!health.ok) {
    await send(
      `⚠️ <b>Server ter-install ulang, tapi health check API gagal.</b>\n\n📝 <b>${esc(s.nama)}</b>\n📡 IP: <code>${esc(ip)}</code>\n🔌 API: <code>${esc(apiBase)}</code>\n\nAlasan: ${esc(health.message)}\n\nKunci API baru sudah dibaca, tapi server belum bisa dipakai. Periksa service vpn-api di VPS itu.`,
      { reply_markup: panel() }
    );
    return;
  }
  await run('UPDATE servers SET api_auth = ? WHERE id = ?', [apiAuth, id]);
  await send(
    `✅ <b>Server berhasil di-install ulang & aktif!</b>\n\n🆔 ID: <code>${s.id}</code>\n📝 Nama: <b>${esc(s.nama)}</b>\n📡 IP: <code>${esc(ip)}</code>\n🌐 Domain: <code>${esc(s.domain || '-')}</code>\n🔌 API: <code>${esc(apiBase)}</code>\n🔑 Key: <b>baru (diperbarui otomatis)</b>\n💲 Harga: <b>Rp${Number(s.harga).toLocaleString('id-ID')}/hari</b>\n🟢 Status: <b>AKTIF (health check lolos)</b>\n\nServer sudah bisa dipakai lagi. Akun VPN lama di server ini sudah terhapus (Xray fresh).`,
    { reply_markup: panel() }
  );
  })().catch(() => {});
  return;
});

// --- Monitoring Server ---
async function monitorText() {
  const local = await liveServer.checkLocal();
  const rows = await getServers().catch(() => []);
  const lines = ['📊 <b>MONITORING SERVER</b>\n'];
  lines.push('<b>📍 Lokal (server2 — bot utama)</b>');
  lines.push(`vpn-api: ${local.vpnApi.ok ? '✅ ONLINE' : '❌ OFFLINE'}${local.vpnApi.ms >= 0 ? ` (${local.vpnApi.ms} ms)` : ''}`);
  lines.push(`Xray: ${local.xrayOpen}/${local.xrayTotal} port terbuka`);
  lines.push(`nginx (:81): ${local.nginx ? '✅ aktif' : '❌ tidak merespons'}`);
  lines.push(`haproxy (:443): ${local.haproxy ? '✅ aktif' : '❌ tidak merespons'}`);
  if (!rows.length) {
    lines.push('\n<i>Belum ada server tambahan di tabel servers.</i>');
  } else {
    lines.push('\n<b>🌐 Server tambahan</b>');
    const checks = await Promise.all(rows.map(async (s) => {
      const ip = serverIp(s);
      const health = await liveServer.checkRemote(s).catch(() => ({ ok: false, ms: -1 }));
      let svc = null;
      if (ip && installServer.validIp(ip)) svc = await installServer.getRemoteServiceStatus(ip).catch(() => null);
      return { s, ip, health, svc };
    }));
    for (const { s, ip, health, svc } of checks) {
      const apiSt = health.ok ? `✅ ONLINE (${health.ms} ms)` : '❌ OFFLINE';
      lines.push(`\n• <b>${esc(s.nama)}</b> — <code>${esc(s.domain || ip || '-')}</code>${s.active ? '' : ' (nonaktif)'}`);
      lines.push(`  API: ${apiSt}`);
      if (svc) {
        if (!svc.reachable) lines.push('  SSH: ❌ tidak nyambung (kunci/host mati?)');
        else lines.push(`  Xray: ${svc.xray ? '✅' : '❌'}  vpn-api: ${svc.vpnApi ? '✅' : '❌'}  nginx: ${svc.nginx ? '✅' : '❌'}  haproxy: ${svc.haproxy ? '✅' : '❌'}`);
      }
    }
  }
  return lines.join('\n');
}
const monitorKb = () => ({ inline_keyboard: [[sBtn('🔄 Refresh', 'adm_monitor_refresh', 'primary'), sBtn('🔙 Kembali', 'adm_back', 'danger')]] });
bot.action('adm_monitor', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  try { await ctx.editMessageText(await monitorText(), { parse_mode: 'HTML', reply_markup: monitorKb() }); }
  catch (_) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, ctx.callbackQuery?.message?.message_id); } catch (_) {}
    await ctx.reply(await monitorText(), { parse_mode: 'HTML', reply_markup: monitorKb() });
  }
});
bot.action('adm_monitor_refresh', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const text = await monitorText();
  try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: monitorKb() }); }
  catch (_) { await ctx.reply(text, { parse_mode: 'HTML', reply_markup: monitorKb() }); }
});

// Hapus server: tampilkan daftar dengan tombol hapus
bot.action('adm_delserver', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via ➕ Tambah Server.');
  const kb = rows.map((s) => [sBtn(`❌ ${s.nama} (Rp${Number(s.harga).toLocaleString('id-ID')}/hari)`, `adm_delserver_${s.id}`, 'danger')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('❌ <b>Hapus Server</b>\n\nPilih server yang akan dihapus:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});

bot.action(/^adm_delserver_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  // Server utama (default, id 0/null) bukan baris tabel — tidak bisa dihapus.
  if (!id) return ctx.reply('❌ Server utama (default) tidak bisa dihapus.');
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  await ctx.reply(
    `❌ <b>Hapus Server?</b>\n\n📝 <b>${esc(s.nama)}</b> (ID <code>${s.id}</code>)\n🌐 Domain: <code>${esc(s.domain || '-')}</code>\n\nAkun yang masih terdaftar di server ini TIDAK ikut terhapus otomatis. Tindakan ini tidak bisa dibatalkan.`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[sBtn('✅ Ya, hapus', `adm_delserver_yes_${id}`, 'danger'), sBtn('🔙 Batal', 'adm_back', 'primary')]] },
    }
  );
});

bot.action(/^adm_delserver_yes_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  if (!id) return ctx.reply('❌ Server utama (default) tidak bisa dihapus.');
  const { run, get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  // Tolak hapus bila masih ada akun yang merujuk server ini — kalau tidak,
  // renew/hapus akun itu nanti salah rute (jatuh ke server utama).
  const refs = await get('SELECT COUNT(*) AS n FROM vpn_accounts WHERE server_id = ?', [id]).catch(() => ({ n: 0 }));
  if (refs && refs.n > 0) {
    return ctx.reply(`❌ Server <b>${esc(s.nama)}</b> masih dipakai <b>${refs.n} akun</b>. Hapus akun itu dulu, baru hapus server.`, { parse_mode: 'HTML' });
  }
  const r = await run('DELETE FROM servers WHERE id = ?', [id]);
  await ctx.reply(r.changes > 0 ? `✅ Server <b>${esc(s.nama)}</b> (ID <code>${id}</code>) dihapus.` : '⚠️ Server tidak ditemukan.', { parse_mode: 'HTML' });
});

// Edit harga: pilih server -> ketik harga baru dari keyboard
bot.action('adm_editharga', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via ➕ Tambah Server.');
  const kb = rows.map((s) => [sBtn(`💲 ${s.nama} (Rp${Number(s.harga).toLocaleString('id-ID')}/hari)`, `adm_editharga_${s.id}`, 'primary')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('💲 <b>Edit Harga Server</b>\n\nPilih server:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});

bot.action(/^adm_editharga_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  sessions.set(ctx.chat.id, { step: 'adm_editharga_input', data: { serverId: id } });
  await ctx.reply(
    `💲 <b>Edit Harga</b>\n\nServer: <b>${esc(s.nama)}</b>\nHarga saat ini: <b>Rp${Number(s.harga).toLocaleString('id-ID')}/hari</b>\n\nKetik <b>harga baru per hari</b> (angka saja, contoh: 500):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

// Edit nama: pilih server -> ketik nama baru
bot.action('adm_editnama', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via ➕ Tambah Server.');
  const kb = rows.map((s) => [sBtn(`📝 ${s.nama}`, `adm_editnama_${s.id}`, 'primary')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('📝 <b>Edit Nama Server</b>\n\nPilih server:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});

bot.action(/^adm_editnama_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  sessions.set(ctx.chat.id, { step: 'adm_editnama_input', data: { serverId: id } });
  await ctx.reply(`📝 <b>Edit Nama</b>\n\nNama saat ini: <b>${esc(s.nama)}</b>\n\nKetik <b>nama baru</b>:`, { parse_mode: 'HTML', ...cancelKb() });
});

// Edit domain: pilih server -> ketik domain baru
// Edit negara (bendera): pilih server -> pilih negara -> simpan.
// Bendera tampil di pemilih server saat beli VPN; negara juga terdeteksi
// otomatis dari IP saat server didaftarkan, ini untuk mengubahnya.
bot.action('adm_editcountry', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via ➕ Tambah Server.');
  const kb = rows.map((s) => [sBtn(`${country.flagFor(s.country)} ${s.nama} (${s.domain || '-'})`, `adm_editcountry_${s.id}`, 'primary')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('🌍 <b>Edit Negara (Bendera)</b>\n\nPilih server yang benderanya mau diubah:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});
bot.action(/^adm_editcountry_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  const kb = [];
  for (let i = 0; i < country.COMMON_COUNTRIES.length; i += 2) {
    const row = [];
    for (const [code, name] of country.COMMON_COUNTRIES.slice(i, i + 2)) {
      row.push(sBtn(`${country.flagFor(code)} ${name}`, `adm_editcountry_set_${id}_${code}`, 'primary'));
    }
    kb.push(row);
  }
  kb.push([sBtn('🔄 Deteksi otomatis dari IP', `adm_editcountry_auto_${id}`, 'success')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply(
    `🌍 <b>Edit Negara — ${esc(s.nama)}</b>\n\nBendera saat ini: <b>${country.flagFor(s.country)} ${esc(s.country || '(belum diset)')}</b>\n\nPilih negara untuk server ini:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
  );
});
bot.action(/^adm_editcountry_set_(\d+)_([A-Z]{2})$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const code = ctx.match[2];
  const { run, get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  await run('UPDATE servers SET country = ? WHERE id = ?', [code, id]);
  await ctx.reply(
    `✅ <b>Negara ${esc(s.nama)} diubah.</b>\n\n${country.flagFor(code)} Bendera baru: <b>${code}</b>\n\nBendera ini tampil di pemilih server saat beli VPN.`,
    { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
  );
});
bot.action(/^adm_editcountry_auto_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { run, get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  const ip = serverIp(s);
  const code = ip ? await country.detectCountry(ip).catch(() => '') : '';
  if (!code) {
    return ctx.reply(
      `❌ <b>Deteksi otomatis gagal.</b>\n\nNegara server <b>${esc(s.nama)}</b> tidak bisa dideteksi dari IP (${esc(ip || '-')}). Pilih negara manual dari daftar.`,
      { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
    );
  }
  await run('UPDATE servers SET country = ? WHERE id = ?', [code, id]);
  await ctx.reply(
    `✅ <b>Negara ${esc(s.nama)} terdeteksi otomatis.</b>\n\n${country.flagFor(code)} Bendera: <b>${code}</b>\n\nBendera ini tampil di pemilih server saat beli VPN.`,
    { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup }
  );
});
bot.action('adm_editdomain', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via ➕ Tambah Server.');
  const kb = rows.map((s) => [sBtn(`🌐 ${s.nama}`, `adm_editdomain_${s.id}`, 'primary')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('🌐 <b>Edit Domain Server</b>\n\nPilih server:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});

bot.action(/^adm_editdomain_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  sessions.set(ctx.chat.id, { step: 'adm_editdomain_input', data: { serverId: id } });
  await ctx.reply(`🌐 <b>Edit Domain</b>\n\nServer: <b>${esc(s.nama)}</b>\nDomain saat ini: <code>${esc(s.domain || '-')}</code>\n\nKetik <b>domain baru</b>:`, { parse_mode: 'HTML', ...cancelKb() });
});

bot.action('adm_editapi', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via ➕ Tambah Server.');
  const kb = rows.map((s) => [sBtn(`🔌 ${s.nama}`, `adm_editapi_${s.id}`, 'primary')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('🔌 <b>Edit API Base Server</b>\n\nPilih server:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});

bot.action(/^adm_editapi_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  sessions.set(ctx.chat.id, { step: 'adm_editapi_input', data: { serverId: id } });
  await ctx.reply(`🔌 <b>Edit API Base</b>\n\nServer: <b>${esc(s.nama)}</b>\nAPI saat ini: <code>${esc(s.api_base || '-')}</code>\n\nKetik <b>API base baru</b>:`, { parse_mode: 'HTML', ...cancelKb() });
});

bot.action('adm_editkey', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via ➕ Tambah Server.');
  const kb = rows.map((s) => [sBtn(`🔑 ${s.nama}`, `adm_editkey_${s.id}`, 'primary')]);
  kb.push([sBtn('🔙 Kembali', 'adm_back', 'danger')]);
  await ctx.reply('🔑 <b>Edit API Key Server</b>\n\nPilih server:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});

bot.action(/^adm_editkey_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const id = parseInt(ctx.match[1], 10);
  const { get } = require('./src/db');
  const s = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!s) return ctx.reply('⚠️ Server tidak ditemukan.');
  sessions.set(ctx.chat.id, { step: 'adm_editkey_input', data: { serverId: id } });
  await ctx.reply(`🔑 <b>Edit API Key</b>\n\nServer: <b>${esc(s.nama)}</b>\nKey saat ini: <b>${s.api_auth ? 'terisi' : 'kosong'}</b>\n\nKetik <b>API key baru</b> (atau <b>-</b> untuk kosong):`, { parse_mode: 'HTML', ...cancelKb() });
});

// List server
bot.action('adm_listserver', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await getServers();
  if (!rows.length) return ctx.reply('❌ Belum ada server. Tambah dulu via ➕ Tambah Server.');
  const lines = rows.map((s, i) =>
    `${i + 1}. <b>${esc(s.nama)}</b>\n   🆔 ID: <code>${s.id}</code>\n   🌐 Domain: <code>${esc(s.domain || '-')}</code>\n   🔌 API: <code>${esc(s.api_base || '-')}</code>\n   🔑 Key: <b>${s.api_auth ? 'terisi' : 'kosong'}</b>\n   💲 Harga: <b>Rp${Number(s.harga).toLocaleString('id-ID')}/hari</b>\n   ${Number(s.active) === 1 ? '🟢' : '🔴'} Status: <b>${Number(s.active) === 1 ? 'AKTIF' : 'NONAKTIF'}</b>`
  );
  await ctx.reply(`📋 <b>Daftar Server (${rows.length})</b>\n\n${lines.join('\n\n')}`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[sBtn('🔙 Kembali ke Panel', 'adm_back', 'danger')]] },
  });
});

// Kembali ke panel admin
// Live Server (Fase 3): status lokal + server tambahan, admin-only.
async function liveServerText() {
  const local = await liveServer.checkLocal();
  const rows = await getServers().catch(() => []);
  const remotes = await Promise.all(rows.map(async (s) => ({ server: s, health: await liveServer.checkRemote(s) })));
  return liveServer.formatStatus(local, remotes);
}
const liveServerKb = () => ({ inline_keyboard: [[sBtn('🔄 Refresh', 'adm_liveserver_refresh', 'primary'), sBtn('🔙 Kembali', 'adm_back', 'danger')]] });
bot.action('adm_liveserver', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  try { await ctx.editMessageText(await liveServerText(), { parse_mode: 'HTML', reply_markup: liveServerKb() }); }
  catch (_) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, ctx.callbackQuery?.message?.message_id); } catch (_) {}
    await ctx.reply(await liveServerText(), { parse_mode: 'HTML', reply_markup: liveServerKb() });
  }
});
bot.action('adm_liveserver_refresh', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const text = await liveServerText();
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: liveServerKb() });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: liveServerKb() });
  }
});
// Pengaturan & API Key (menu lengkap, input via Telegram).
function apiMenuText() {
  const st = apiSettings.getStatus();
  const lines = ['⚙️ <b>PENGATURAN &amp; API KEY</b>\n'];
  for (const f of st) {
    lines.push(`${f.filled ? '✅' : '❌'} <b>${f.label}</b>${f.filled && !f.secret ? `: <code>${esc(f.value)}</code>` : (f.filled ? ': terisi' : ': kosong')}`);
  }
  const url = apiSettings.webhookUrl();
  lines.push('');
  lines.push(`🔗 <b>URL Webhook Deposit:</b>\n${url ? `<code>${esc(url)}</code>` : '<i>domain belum diset — input Domain VPN dulu</i>'}`);
  lines.push('\n<i>Kunci/secret tidak pernah ditampilkan di sini. Setelah input kunci/secret, hapus pesan itu dari chat. Perubahan berlaku setelah Terapkan &amp; Restart.</i>');
  return lines.join('\n');
}
const apiMenuKb = () => ({ inline_keyboard: [
  [sBtn('🌐 Input Domain VPN', 'adm_api_VPN_DOMAIN', 'primary'), sBtn('🔗 Input URL Gateway', 'adm_api_H2H_BASE_URL', 'primary')],
  [sBtn('🔑 Input Kunci Gateway', 'adm_api_H2H_API_KEY', 'primary'), sBtn('🤫 Input Secret Webhook', 'adm_api_WEBHOOK_SECRET', 'primary')],
  [sBtn('👤 Input User Digiflazz', 'adm_api_DIGIFLAZZ_USERNAME', 'primary'), sBtn('🔑 Input Kunci Digiflazz', 'adm_api_DIGIFLAZZ_API_KEY', 'primary')],
  [sBtn('🔗 URL Webhook', 'adm_api_url', 'primary'), sBtn('🔄 Terapkan &amp; Restart Bot', 'adm_api_apply', 'success')],
  [sBtn('📡 Daftarkan Webhook', 'adm_api_register', 'success')],
  [sBtn('👁️ Tampilkan Secret 10 Detik', 'adm_api_showsecret', 'primary')],
  [sBtn('🔙 Kembali', 'adm_back', 'danger')],
] });
async function replyApiMenu(ctx, text) {
  try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: apiMenuKb() }); }
  catch (_) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, ctx.callbackQuery?.message?.message_id); } catch (_) {}
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: apiMenuKb() });
  }
}

bot.action('adm_api', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.delete(ctx.chat.id);
  await replyApiMenu(ctx, apiMenuText());
});
bot.action(/^adm_api_(VPN_DOMAIN|H2H_BASE_URL|H2H_API_KEY|WEBHOOK_SECRET|DIGIFLAZZ_USERNAME|DIGIFLAZZ_API_KEY)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const field = ctx.match[1];
  const label = (apiSettings.FIELDS.find((f) => f.key === field) || {}).label || field;
  sessions.set(ctx.chat.id, { step: 'adm_api_input', data: { field, menuMsgId: ctx.callbackQuery?.message?.message_id } });
  await ctx.reply(`✏️ <b>Input ${esc(label)}</b>\n\nKetik nilainya sekarang (satu baris, tanpa spasi). Ketik <code>batal</code> untuk membatalkan.\n<i>Untuk kunci/secret: setelah terkirim, hapus pesan itu dari chat.</i>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[sBtn('🔙 Kembali', 'adm_api', 'danger')]] } });
});
bot.action('adm_api_url', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.delete(ctx.chat.id);
  const url = apiSettings.webhookUrl();
  const st = apiSettings.getStatus();
  const sec = st.find((f) => f.key === 'WEBHOOK_SECRET');
  const h2h = st.find((f) => f.key === 'H2H_API_KEY');
  const text = url
    ? `🔗 <b>URL WEBHOOK DEPOSIT</b>\n\n<code>${esc(url)}</code>\n\nEvents: <code>payment.success</code>, <code>payment.expired</code>\nSecret webhook: ${sec && sec.filled ? '✅ terisi' : '❌ kosong — input dulu'}\nKunci gateway: ${h2h && h2h.filled ? '✅ terisi' : '❌ kosong'}\n\n<i>Daftarkan URL ini di gateway (panel /webhook) dengan secret yang sama seperti di bot. Pendaftaran otomatis dari bot belum tersedia karena admin API gateway hanya loopback di Biznet.</i>`
    : '❌ <b>Domain VPN belum diset.</b> Input Domain VPN dulu, lalu buka lagi URL Webhook.';
  await replyApiMenu(ctx, text);
});
bot.action('adm_api_apply', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.delete(ctx.chat.id);
  await ctx.reply('🔄 <b>Menerapkan &amp; me-restart bot...</b> Tunggu beberapa detik, lalu cek panel admin lagi.', { parse_mode: 'HTML' });
  setTimeout(() => { try { require('child_process').exec('pm2 restart darren-bot'); } catch (_) {} }, 800);
});
bot.action('adm_api_register', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.delete(ctx.chat.id);
  const url = apiSettings.webhookUrl();
  const st = apiSettings.getStatus();
  const keySt = st.find((f) => f.key === 'H2H_API_KEY');
  const secSt = st.find((f) => f.key === 'WEBHOOK_SECRET');
  if (!url) return replyApiMenu(ctx, '❌ Domain VPN belum diset. Input Domain VPN dulu, lalu Terapkan &amp; Restart.');
  if (!keySt || !keySt.filled) return replyApiMenu(ctx, '❌ Kunci gateway belum diisi. Input Kunci Gateway dulu, lalu Terapkan &amp; Restart.');
  const runningSecret = config.webhook?.secret || '';
  if ((!secSt || !secSt.filled) && !runningSecret) return replyApiMenu(ctx, '❌ Secret webhook belum diisi. Restart bot sekali (secret dibuat otomatis), lalu coba lagi.');
  try {
    const r = await h2h.registerWebhook(url);
    if (r.already) return replyApiMenu(ctx, `✅ Webhook sudah terdaftar di gateway:\n<code>${esc(url)}</code>\n\n<i>Panel /webhook menampilkan webhook ini juga.</i>`);
    return replyApiMenu(ctx, `✅ Webhook terdaftar di gateway:\n<code>${esc(url)}</code>\nEvent: payment.success, payment.expired\n\n<i>Deposit berikutnya masuk instan lewat webhook ini. Panel /webhook menampilkan webhook ini juga.</i>`);
  } catch (e) {
    const m = e?.message || 'unknown';
    let hint = '';
    if (m.includes('401')) hint = '\n\n<i>401 = secret belum diterapkan atau tidak cocok — tekan Terapkan &amp; Restart dulu, lalu coba lagi.</i>';
    else if (m.includes('409')) hint = '\n\n<i>409 = sudah 10 webhook, hapus salah satu dulu.</i>';
    else if (m.includes('503')) hint = '\n\n<i>503 = layanan akun gateway tidak jalan.</i>';
    return replyApiMenu(ctx, `❌ Gagal mendaftar: ${esc(m)}${hint}`);
  }
});
bot.action('adm_api_showsecret', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.delete(ctx.chat.id);
  const sec = config.webhook?.secret || '';
  if (!sec) return ctx.reply('❌ Secret belum ada. Restart bot sekali (secret dibuat otomatis), lalu coba lagi.', { parse_mode: 'HTML', reply_markup: apiMenuKb() });
  const sent = await ctx.reply(`🔑 <b>Secret webhook aktif</b> (hapus otomatis 10 detik):\n<code>${esc(sec)}</code>\n\n<i>Salin sekarang. Jangan teruskan pesan ini ke siapa pun.</i>`, { parse_mode: 'HTML' });
  setTimeout(async () => {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id);
      await ctx.reply('✅ Pesan secret sudah dihapus otomatis.', { parse_mode: 'HTML' });
    } catch (_) {}
  }, 10000);
});
bot.action('adm_back', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  try {
    await ctx.editMessageText(await adminPanelText(), {
      parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
    });
  } catch (e) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, ctx.callbackQuery?.message?.message_id); } catch (_) {}
    await ctx.reply(await adminPanelText(), { parse_mode: 'HTML', reply_markup: adminPanel().reply_markup });
  }
});

// ---------- Harga VPN per Role ----------
// Admin mengatur harga Rp/hari per produk VPN untuk role member & reseller.
// Semua role melihat produk yang sama; role 'admin' beli dengan harga 0 (modal).
bot.action('adm_vpnprices', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const rows = await vpn.listVpnPrices().catch(() => []);
  const byKey = {};
  for (const r of rows) {
    byKey[r.product_key] = byKey[r.product_key] || {};
    byKey[r.product_key][r.role] = r;
  }
  const rp = (n) => 'Rp' + Number(n).toLocaleString('id-ID');
  const cfOf = (row, biasa) => (row && row.cf_price !== null && row.cf_price !== undefined && Number.isFinite(Number(row.cf_price)) ? Number(row.cf_price) : biasa);
  const lines = vpn.VPN_PRODUCTS.map((p) => {
    const mRow = byKey[p.key]?.member;
    const rRow = byKey[p.key]?.reseller;
    const m = mRow ? Number(mRow.price) : vpn.DEFAULT_VPN_PRICE.member;
    const r = rRow ? Number(rRow.price) : vpn.DEFAULT_VPN_PRICE.reseller;
    return `• <b>${p.label}</b> — member: <b>${rp(m)}/hari</b> (CF: <b>${rp(cfOf(mRow, m))}/hari</b>), reseller: <b>${rp(r)}/hari</b> (CF: <b>${rp(cfOf(rRow, r))}/hari</b>)`;
  });
  const btns = vpn.VPN_PRODUCTS.map((p) => [sBtn(`✏️ ${p.label}`, `adm_price_${p.key}`, 'primary')]);
  btns.push([sBtn('🔙 Kembali ke Panel', 'adm_back', 'danger')]);
  await ctx.reply(
    `💲 <b>Harga VPN per Role</b>\n\n${lines.join('\n')}\n\nPilih produk untuk ubah harga:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: btns } }
  );
});

bot.action(/^adm_price_([a-z]+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const key = ctx.match[1];
  const prod = vpn.VPN_PRODUCTS.find((p) => p.key === key);
  if (!prod) return ctx.reply('❌ Produk tidak dikenal.');
  await ctx.reply(
    `💲 <b>Ubah Harga: ${prod.label}</b>\n\nPilih role yang harganya mau diubah:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [sBtn('👤 Member', `adm_pricerole_${key}_member`, 'primary'), sBtn('🤝 Reseller', `adm_pricerole_${key}_reseller`, 'success')],
          [sBtn('🔙 Kembali', 'adm_vpnprices', 'danger')],
        ],
      },
    }
  );
});

bot.action(/^adm_pricerole_([a-z]+)_(member|reseller)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const key = ctx.match[1];
  const role = ctx.match[2];
  const cur = await vpn.getVpnPrice(key, role);
  const curCF = await vpn.getVpnPrice(key, role, true);
  await ctx.reply(
    `💲 <b>Ubah Harga VPN</b>\n\n📦 Produk: <b>${esc(key)}</b>\n👤 Role: <b>${role}</b>\n📌 Harga Biasa saat ini: <b>Rp${Number(cur).toLocaleString('id-ID')}/hari</b>\n📌 Harga CloudFront saat ini: <b>Rp${Number(curCF).toLocaleString('id-ID')}/hari</b>\n\nPilih jenis harga yang mau diubah:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [sBtn('💲 Harga Biasa', `adm_pricetype_${key}_${role}_biasa`, 'primary'), sBtn('☁️ Harga CloudFront', `adm_pricetype_${key}_${role}_cf`, 'success')],
      [sBtn('🔙 Kembali', 'adm_vpnprices', 'danger')],
    ] } }
  );
});


bot.action(/^adm_pricetype_([a-z]+)_(member|reseller)_(biasa|cf)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const key = ctx.match[1];
  const role = ctx.match[2];
  const viaCF = ctx.match[3] === 'cf';
  const cur = await vpn.getVpnPrice(key, role, viaCF);
  sessions.set(ctx.chat.id, { step: 'adm_price_input', data: { key, role, viaCF } });
  await ctx.reply(
    `💲 <b>Ubah Harga ${viaCF ? 'CloudFront' : 'Biasa'}</b>\n\n📦 Produk: <b>${esc(key)}</b>\n👤 Role: <b>${role}</b>\n📌 Harga saat ini: <b>Rp${Number(cur).toLocaleString('id-ID')}/hari</b>\n\nKetik <b>harga baru per hari</b> (angka saja, contoh: 500):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

// ---------- Kelola Role ----------
bot.action('adm_roles', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const counts = await admin.countUsersByRole().catch(() => []);
  const c = {};
  for (const r of counts) c[r.role] = r.c;
  await ctx.reply(
    `👥 <b>Kelola Role User</b>\n\n` +
    `🛡️ Admin: <b>${c.admin || 0}</b>\n` +
    `🤝 Reseller: <b>${c.reseller || 0}</b>\n` +
    `👤 Member: <b>${c.member || 0}</b>\n\n` +
    `Pilih aksi:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [sBtn('📋 List Admin', 'adm_rolelist_admin', 'primary'), sBtn('📋 List Reseller', 'adm_rolelist_reseller', 'success')],
          [sBtn('📋 List Member', 'adm_rolelist_member', 'primary'), sBtn('✏️ Ubah Role User', 'adm_roleset', 'danger')],
          [sBtn('🔙 Kembali ke Panel', 'adm_back', 'danger')],
        ],
      },
    }
  );
});

bot.action(/^adm_rolelist_(admin|reseller|member)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const role = ctx.match[1];
  const rows = await admin.listUsersByRole(role, 30);
  if (!rows.length) {
    return ctx.reply(`📭 Belum ada user dengan role <b>${role}</b>.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[sBtn('🔙 Kembali', 'adm_roles', 'danger')]] },
    });
  }
  const lines = rows.map((u, i) =>
    `${i + 1}. <code>${u.telegram_id}</code> ${esc(u.username || '-')}` +
    (role !== 'admin' ? ` — Rp${Number(u.saldo || 0).toLocaleString('id-ID')}` : '')
  );
  await ctx.reply(`👥 <b>Daftar ${role} (${rows.length})</b>\n\n${lines.join('\n')}`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[sBtn('🔙 Kembali', 'adm_roles', 'danger')]] },
  });
});

bot.action('adm_roleset', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_role_id', data: {} });
  await ctx.reply(
    `✏️ <b>Ubah Role User</b>\n\nKetik <b>ID Telegram</b> user yang mau diubah rolenya (angka saja):`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

bot.action(/^adm_roleset_(\d+)_(admin|reseller|member)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const uid = Number(ctx.match[1]);
  const role = ctx.match[2];
  // Owner tidak bisa diturunkan rolenya — akses owner selalu via config.adminId
  if (uid === config.adminId && role !== 'admin') {
    return ctx.reply('❌ Tidak bisa mengubah role owner.');
  }
  try {
    await ppob.setRole(uid, role);
    await ctx.reply(`✅ Role user <code>${uid}</code> diubah menjadi <b>${role}</b>.`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ ${esc(e.message)}`);
  }
});

// ---------- Keuangan ----------
// Tambah saldo: ketik "userId jumlah" dari keyboard
bot.action('adm_addsaldo', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_addsaldo_input', data: {} });
  await ctx.reply('💵 <b>Tambah Saldo</b>\n\nKetik dengan format:\n<code>userId jumlah</code>\nContoh: <code>123456 50000</code>', { parse_mode: 'HTML', ...cancelKb() });
});

// Kurangi saldo: ketik "userId jumlah" dari keyboard
bot.action('adm_minsaldo', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_minsaldo_input', data: {} });
  await ctx.reply('➖ <b>Kurangi Saldo</b>\n\nKetik dengan format:\n<code>userId jumlah</code>\nContoh: <code>123456 10000</code>', { parse_mode: 'HTML', ...cancelKb() });
});

// Hasil penjualan
bot.action('adm_sales', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const { get, all } = require('./src/db');
  const total = await get("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM transactions WHERE status = 'success'");
  const byType = await all("SELECT type, COUNT(*) c, COALESCE(SUM(amount),0) s FROM transactions WHERE status = 'success' GROUP BY type");
  const lines = byType.map((t) => `• <code>${esc(t.type)}</code>: ${t.c}x = <b>Rp${Number(t.s).toLocaleString('id-ID')}</b>`);
  await ctx.reply(
    `📊 <b>Hasil Penjualan</b>\n\n` +
    `🧾 Total transaksi sukses: <b>${total.c}</b>\n` +
    `💰 Total omzet: <b>Rp${Number(total.s).toLocaleString('id-ID')}</b>\n\n` +
    (lines.join('\n') || '—'),
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[sBtn('🔙 Kembali ke Panel', 'adm_back', 'danger')]] },
    }
  );
});

// Log topup (10 terakhir)
bot.action('adm_topuplog', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const { all } = require('./src/db');
  const rows = await all("SELECT telegram_id, amount, ref_id, status, created_at FROM transactions WHERE type = 'deposit' ORDER BY id DESC LIMIT 10");
  if (!rows.length) return ctx.reply('📑 Belum ada log topup.');
  const lines = rows.map((r, i) =>
    `${i + 1}. 👤 <code>${r.telegram_id}</code> — <b>Rp${Number(r.amount).toLocaleString('id-ID')}</b>\n   ${r.status === 'success' ? '✅' : r.status === 'pending' ? '⏳' : r.status === 'review' ? '⚠️' : '❌'} <code>${esc(r.ref_id)}</code> • ${esc(r.created_at || '')}`
  );
  await ctx.reply(`📑 <b>Log Topup (10 terakhir)</b>\n\n${lines.join('\n\n')}`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[sBtn('🔙 Kembali ke Panel', 'adm_back', 'danger')]] },
  });
});

// ---------- Lainnya ----------
// Backup DB via tombol (pakai logika yang sama dengan /backupdb)
bot.action('adm_backupdb', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const dbPath = path.join(__dirname, 'data', 'bot.db');
  const backupDir = path.join(__dirname, 'data', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(backupDir, `bot-backup-${ts}.db`);
  try {
    fs.copyFileSync(dbPath, backupPath);
    await ctx.replyWithDocument({ source: backupPath }, { caption: `✅ Backup database berhasil.\n📁 ${path.basename(backupPath)}` });
  } catch (e) {
    await ctx.reply(`❌ Backup gagal: ${esc(e.message)}`);
  }
});

// Restore DB via tombol (pakai session yang sama dengan /restoredb)
bot.action('adm_restoredb', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await ctx.reply(
    '⚠️ <b>Restore Database</b>\n\n' +
    'Kirim file <b>.db</b> backup sebagai dokumen ke chat ini untuk restore.\n' +
    'Bot akan restart setelah restore.',
    { parse_mode: 'HTML' }
  );
  sessions.set(ctx.chat.id, { step: 'restore_db' });
});

// ============================================================
// ---------- Setting ePro API Key (untuk generate .hc) ----------
// ============================================================
async function showEproPanel(ctx) {
  const key = await hc.getHcApiKey();
  const masked = key ? key.slice(0, 8) + '...' + key.slice(-4) : '(belum diisi)';
  const presets = hc.presetList();
  const text =
    `🔑 <b>Setting ePro (HTTP Custom)</b>\n\n` +
    `API Key: <code>${masked}</code>\n` +
    `Status: ${key ? '✅ Terkonfigurasi' : '❌ Belum dikonfigurasi'}\n\n` +
    `Preset HC tersedia: <b>${presets.length}</b>\n` +
    `Dapatkan API key di https://eprdv.link/`;
  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [sBtn('🔑 Set API Key', 'adm_epro_key', 'primary'), sBtn('🧪 Tes Koneksi', 'adm_epro_test', 'success')],
      [sBtn('🗑️ Hapus Key', 'adm_epro_del', 'danger'), sBtn('🔙 Kembali', 'menu_admin', 'primary')],
    ]).reply_markup,
  });
}

bot.action('adm_epro', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await showEproPanel(ctx);
});

bot.action('adm_epro_key', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_epro_key' });
  await ctx.reply('🔑 Kirim <b>API key ePro</b> dari https://eprdv.link/ :', { parse_mode: 'HTML', ...cancelKb() });
});

bot.action('adm_epro_del', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await settings.setSetting('epro_api_key', '');
  await ctx.reply('✅ API key ePro dihapus.');
  await showEproPanel(ctx);
});

bot.action('adm_epro_test', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const key = await hc.getHcApiKey();
  if (!key) return ctx.reply('❌ API key belum diisi.');
  await ctx.reply('⏳ Mengetes koneksi ke ePro API...');
  try {
    const axios = require('axios');
    const resp = await axios.get('https://api.eprodev.org/v1/configs/hc', {
      headers: { 'Authorization': 'Bearer ' + key },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (resp.status === 200 || resp.status === 404 || resp.status === 405) {
      await ctx.reply('✅ Koneksi ke ePro API <b>berhasil</b> (key valid).', { parse_mode: 'HTML' });
    } else if (resp.status === 401 || resp.status === 403) {
      await ctx.reply('❌ API key <b>tidak valid</b>.', { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`⚠️ Respon tak terduga: HTTP ${resp.status}`, { parse_mode: 'HTML' });
    }
  } catch (e) {
    await ctx.reply('❌ Gagal konek: ' + e.message);
  }
});

bot.action('adm_hcpresets', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const presets = hc.presetList();
  const lines = presets.map((p, i) => `${i + 1}. <b>${p.label}</b> (<code>${p.id}</code>)`);
  await ctx.reply(
    `📲 <b>Preset HC (${presets.length})</b>\n\n${lines.join('\n')}`,
    { parse_mode: 'HTML' }
  );
});

// ============================================================
// ---------- Bonus Topup & Minimal Topup Reseller ----------
// ============================================================
async function showBonusPanel(ctx) {
  const cfg = await ppob.getBonusConfig();
  const minRes = await settings.getResellerMinTopup();
  const text =
    `🎁 <b>Bonus Topup & Reseller</b>\n\n` +
    `<b>Bonus Topup:</b> ${cfg.enabled ? '✅ Aktif' : '❌ Nonaktif'}\n` +
    `• Min. topup: <b>${digi.rp(cfg.min_topup)}</b>\n` +
    `• Bonus: <b>${cfg.bonus_percent}%</b>\n\n` +
    `<b>Otomatis jadi Reseller:</b>\n` +
    `• Min. total topup: <b>${minRes > 0 ? digi.rp(minRes) : '(nonaktif)'}</b>\n` +
    (minRes > 0 ? `User yang total topup-nya mencapai nominal ini otomatis naik jadi 🏪 Reseller.\n` : ``);
  const kb = Markup.inlineKeyboard([
    [sBtn('🎁 Set Bonus', 'adm_bonus_set', 'success'), sBtn(cfg.enabled ? '⏸️ Matikan Bonus' : '▶️ Nyalakan Bonus', 'adm_bonus_toggle', cfg.enabled ? 'danger' : 'success')],
    [sBtn('🏪 Set Min. Topup Reseller', 'adm_resset', 'primary')],
    [sBtn('🔙 Kembali', 'adm_open', 'danger')],
  ]);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
}

bot.action('adm_bonus', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await showBonusPanel(ctx);
});

bot.action('adm_bonus_set', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_bonus_input', data: {} });
  await ctx.reply(
    `🎁 <b>Set Bonus Topup</b>\n\nKetik dengan format:\n<code>min_topup persen</code>\nContoh: <code>50000 10</code> (topup min 50rb dapat bonus 10%)\n\nKetik <code>0 0</code> untuk menonaktifkan.`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

bot.action('adm_bonus_toggle', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const cfg = await ppob.getBonusConfig();
  if (cfg.enabled) {
    await ppob.setBonusConfig(0, 0);
    await ctx.reply('✅ Bonus topup <b>dinonaktifkan</b>.', { parse_mode: 'HTML' });
  } else {
    if (!cfg.min_topup || !cfg.bonus_percent) {
      return ctx.reply('❌ Set dulu nominal & persen bonus via tombol 🎁 Set Bonus.');
    }
    await ppob.setBonusConfig(cfg.min_topup, cfg.bonus_percent);
    await ctx.reply('✅ Bonus topup <b>diaktifkan</b>.', { parse_mode: 'HTML' });
  }
  await showBonusPanel(ctx);
});

bot.action('adm_resset', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_resset_input', data: {} });
  await ctx.reply(
    `🏪 <b>Min. Topup Otomatis Reseller</b>\n\nKetik <b>nominal rupiah</b> (angka saja).\nContoh: <code>500000</code>\n\nUser yang total topup sukses-nya mencapai nominal ini otomatis jadi Reseller.\nKetik <code>0</code> untuk menonaktifkan.`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

// ============================================================
// ---------- Min. Deposit per Role & Margin PPOB ----------
// ============================================================
async function showMinDepPanel(ctx) {
  const m = await settings.getMinDeposit('member');
  const r = await settings.getMinDeposit('reseller');
  const text =
    `💰 <b>Min. Deposit per Role</b>\n\n` +
    `• 👤 Member: <b>${m > 0 ? digi.rp(m) : 'tanpa minimal'}</b>\n` +
    `• 🏪 Reseller: <b>${r > 0 ? digi.rp(r) : 'tanpa minimal'}</b>\n\n` +
    `Batas bawah nominal SEKALI deposit (beda dengan Min. Topup Otomatis Reseller).\n` +
    `Ketik 0 untuk tanpa minimal (nominal tetap harus > 0).\n` +
    `Admin tidak dibatasi setting ini.`;
  const kb = Markup.inlineKeyboard([
    [sBtn('👤 Set Min. Member', 'adm_mindep_member', 'primary'), sBtn('🏪 Set Min. Reseller', 'adm_mindep_reseller', 'success')],
    [sBtn('🔙 Kembali', 'adm_open', 'danger')],
  ]);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
}

bot.action('adm_mindep', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await showMinDepPanel(ctx);
});

bot.action(/^adm_mindep_(member|reseller)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const role = ctx.match[1];
  sessions.set(ctx.chat.id, { step: 'adm_mindep_input', data: { role } });
  await ctx.reply(
    `💰 <b>Set Min. Deposit ${role === 'reseller' ? 'Reseller' : 'Member'}</b>\n\nKetik <b>nominal rupiah</b> (angka saja).\nContoh: <code>5000</code>\n\nKetik <code>0</code> untuk tanpa minimal.`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

async function showMarginPanel(ctx) {
  const set = await settings.getPpobMargin();
  const active = await ppob.getActiveMargin().catch(() => 0);
  const text =
    `📈 <b>Margin PPOB</b>\n\n` +
    `• Setting admin: <b>${set === null ? '(belum pernah diset)' : set + '%'}</b>\n` +
    `• Margin aktif: <b>${active}%</b>\n\n` +
    `Harga jual = harga dasar Digiflazz + margin% (dibulatkan ke atas).\n` +
    `Berlaku untuk semua produk PPOB; harga yang tampil = harga yang dipotong.`;
  const kb = Markup.inlineKeyboard([
    [sBtn('📈 Set Margin PPOB', 'adm_margin_set', 'success')],
    [sBtn('🔙 Kembali', 'adm_open', 'danger')],
  ]);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
}

bot.action('adm_margin', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await showMarginPanel(ctx);
});

bot.action('adm_margin_set', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_margin_input', data: {} });
  await ctx.reply(
    `📈 <b>Set Margin PPOB</b>\n\nKetik <b>persen</b> (boleh desimal).\nContoh: <code>5</code> atau <code>2.5</code>\n\nKetik <code>0</code> untuk tanpa margin.`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

// ============================================================
// ---------- Broadcast ke Grup ----------
// ============================================================
async function showBcastPanel(ctx) {
  const groups = await settings.listBroadcastGroups();
  const lines = groups.length
    ? groups.map((g, i) => `${i + 1}. <code>${esc(g.chat_id)}</code>${g.title ? ` — ${esc(g.title)}` : ''}`).join('\n')
    : '<i>Belum ada grup terdaftar.</i>';
  const kb = [
    [sBtn('➕ Tambah Grup', 'adm_bcast_add', 'success'), sBtn('❌ Hapus Grup', 'adm_bcast_del', 'danger')],
    [sBtn('📝 Tulis & Kirim Broadcast', 'adm_bcast_send', 'primary')],
    [sBtn('🔙 Kembali', 'adm_open', 'danger')],
  ];
  await ctx.reply(
    `📢 <b>Broadcast ke Grup</b>\n\n<b>Grup terdaftar (${groups.length}):</b>\n${lines}`,
    { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(kb).reply_markup }
  );
}

bot.action('adm_bcast', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await showBcastPanel(ctx);
});

bot.action('adm_bcast_add', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_bcast_add', data: {} });
  await ctx.reply(
    `➕ <b>Tambah Grup Broadcast</b>\n\nKetik <b>ID grup</b> (contoh: <code>-1001234567890</code>).\n` +
    `Cara dapat ID: tambahkan bot ke grup, lalu forward pesan dari grup ke @userinfobot.\n\n` +
    `Bot harus jadi <b>admin</b> di grup tersebut agar bisa kirim pesan.`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

bot.action('adm_bcast_del', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const groups = await settings.listBroadcastGroups();
  if (!groups.length) return ctx.reply('❌ Belum ada grup terdaftar.');
  const kb = groups.map((g) => [sBtn(`❌ ${g.title || g.chat_id}`, `adm_bcastdel_${g.id}`, 'danger')]);
  kb.push([sBtn('🔙 Kembali', 'adm_bcast', 'danger')]);
  await ctx.reply('❌ <b>Hapus Grup Broadcast</b>\n\nPilih grup:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  });
});

bot.action(/^adm_bcastdel_(\d+)$/, async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const ok = await settings.delBroadcastGroup(ctx.match[1]);
  await ctx.reply(ok ? '✅ Grup dihapus dari daftar broadcast.' : '⚠️ Grup tidak ditemukan.');
  await showBcastPanel(ctx);
});

bot.action('adm_bcast_send', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const groups = await settings.listBroadcastGroups();
  if (!groups.length) return ctx.reply('❌ Belum ada grup terdaftar. Tambah dulu via ➕ Tambah Grup.');
  sessions.set(ctx.chat.id, { step: 'adm_bcast_msg', data: {} });
  await ctx.reply(
    `📝 <b>Tulis Pesan Broadcast</b>\n\nKetik pesan yang akan dikirim ke <b>${groups.length} grup</b>.\n` +
    `Mendukung format HTML sederhana (&lt;b&gt;, &lt;i&gt;, &lt;code&gt;).`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

// ============================================================
// ---------- Broadcast ke User ----------
// ============================================================
bot.action('adm_bcastuser', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const kb = [
    [sBtn('👥 Semua User', 'adm_bcu_t_all', 'primary')],
    [sBtn('👤 Hanya Member', 'adm_bcu_t_member', 'success'), sBtn('🏪 Hanya Reseller', 'adm_bcu_t_reseller', 'success')],
    [sBtn('🔙 Kembali', 'adm_open', 'danger')],
  ];
  await ctx.reply(
    `📣 <b>Broadcast ke User</b>\n\nPilih target penerima:`,
    { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(kb).reply_markup }
  );
});

for (const [tkey, tlabel] of [['all', 'Semua User'], ['member', 'Member'], ['reseller', 'Reseller']]) {
  bot.action(`adm_bcu_t_${tkey}`, async (ctx) => {
    if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
    await safeCb(ctx);
    sessions.set(ctx.chat.id, { step: 'adm_bcu_msg', data: { target: tkey, tlabel } });
    await ctx.reply(
      `📝 <b>Tulis Pesan Broadcast</b>\n\nTarget: <b>${tlabel}</b>\n\nKetik pesan yang akan dikirim.\nMendukung format HTML sederhana (&lt;b&gt;, &lt;i&gt;, &lt;code&gt;).`,
      { parse_mode: 'HTML', ...cancelKb() }
    );
  });
}

bot.action('adm_bcu_confirm', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.step !== 'adm_bcu_confirm') return ctx.reply('❌ Sesi kedaluwarsa. Ulangi dari awal.');
  const { target, tlabel, pesan } = sess.data;
  sessions.delete(ctx.chat.id);
  const { all } = require('./src/db');
  const rows = target === 'all'
    ? await all('SELECT telegram_id FROM users')
    : await all('SELECT telegram_id FROM users WHERE role = ?', [target]);
  const ids = [...new Set(rows.map((r) => r.telegram_id).filter(Boolean))];
  if (!ids.length) return ctx.reply('❌ Tidak ada user pada target ini.');
  await ctx.reply(`⏳ Mengirim broadcast ke ${ids.length} user (${tlabel})...`);
  let ok = 0, fail = 0;
  for (const uid of ids) {
    try {
      await ctx.telegram.sendMessage(uid, `📢 <b>Pengumuman</b>\n\n${pesan}`, { parse_mode: 'HTML' });
      ok++;
    } catch (e) { fail++; }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`[bcast-user] target=${target} ok=${ok} fail=${fail}`);
  notifGrup(bot, `📣 <b>Broadcast User</b>\n👤 Admin: ${ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name}\n🎯 Target: ${tlabel}\n✅ Terkirim: ${ok} user${fail ? `\n❌ Gagal: ${fail} user` : ''}`);
  return ctx.reply(`✅ Broadcast selesai.\n🎯 Target: <b>${tlabel}</b>\n📨 Terkirim: <b>${ok}</b> user${fail ? `\n❌ Gagal: <b>${fail}</b> user` : ''}`, {
    parse_mode: 'HTML', reply_markup: adminPanel().reply_markup,
  });
});

bot.action('adm_bcu_cancel', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.delete(ctx.chat.id);
  await ctx.reply('❌ Broadcast dibatalkan.', { reply_markup: adminPanel().reply_markup });
});

// ============================================================
// ---------- Grup Notifikasi Transaksi ----------
// ============================================================
bot.action('adm_notifgrp', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const cur = await settings.getNotifGroup();
  sessions.set(ctx.chat.id, { step: 'adm_notifgrp_input', data: {} });
  await ctx.reply(
    `🔔 <b>Grup Notifikasi Transaksi</b>\n\n` +
    `ID saat ini: <code>${esc(cur || '(belum diatur)')}</code>\n\n` +
    `Semua notifikasi (deposit, pembelian VPN/PPOB, topup) dikirim ke grup ini.\n` +
    `Bot harus jadi <b>admin</b> di grup tersebut.\n\n` +
    `Ketik <b>ID grup baru</b> (contoh: <code>-1001234567890</code>), atau kirim pesan dari grup yang sudah ada.`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

// ============================================================
// ---------- Force Join Channel & Grup ----------
// ============================================================
async function showForceJoinPanel(ctx) {
  const fj = await settings.getForceJoin();
  const text =
    `🔒 <b>Force Join</b>\n\n` +
    `Status: <b>${fj.enabled ? '✅ Aktif' : '❌ Nonaktif'}</b>\n\n` +
    `📢 Channel: <code>${esc(fj.channelId || '(kosong)')}</code>\n` +
    `🔗 Link: ${esc(fj.channelUrl || '-')}\n\n` +
    `👥 Grup: <code>${esc(fj.groupId || '(kosong)')}</code>\n` +
    `🔗 Link: ${esc(fj.groupUrl || '-')}\n\n` +
    `<i>User baru wajib join sebelum bisa pakai bot. Admin selalu lolos.</i>`;
  const kb = Markup.inlineKeyboard([
    [sBtn('📢 Set Channel', 'adm_fj_channel', 'primary'), sBtn('👥 Set Grup', 'adm_fj_group', 'primary')],
    [sBtn(fj.enabled ? '⏸️ Nonaktifkan' : '▶️ Aktifkan', 'adm_fj_toggle', fj.enabled ? 'danger' : 'success')],
    [sBtn('🔙 Kembali', 'adm_open', 'danger')],
  ]);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
}

bot.action('adm_forcejoin', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  await showForceJoinPanel(ctx);
});

bot.action('adm_fj_channel', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_fj_channel', data: {} });
  await ctx.reply(
    `📢 <b>Set Channel Wajib Join</b>\n\nKetik dengan format:\n<code>ID | link_undangan</code>\n` +
    `Contoh: <code>@Notif2Ajibot | https://t.me/Notif2Ajibot</code>\n\n` +
    `Kosongkan ID (ketik <code>-</code>) untuk menonaktifkan cek channel.`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

bot.action('adm_fj_group', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  sessions.set(ctx.chat.id, { step: 'adm_fj_group', data: {} });
  await ctx.reply(
    `👥 <b>Set Grup Wajib Join</b>\n\nKetik dengan format:\n<code>ID | link_undangan</code>\n` +
    `Contoh: <code>-1001234567890 | https://t.me/Notif2Ajibot</code>\n\n` +
    `Kosongkan ID (ketik <code>-</code>) untuk menonaktifkan cek grup.`,
    { parse_mode: 'HTML', ...cancelKb() }
  );
});

bot.action('adm_fj_toggle', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) { await safeCb(ctx); return; }
  await safeCb(ctx);
  const fj = await settings.getForceJoin();
  await settings.setSetting('force_join_enabled', fj.enabled ? '0' : '1');
  await ctx.reply(`✅ Force join <b>${fj.enabled ? 'dinonaktifkan' : 'diaktifkan'}</b>.`, { parse_mode: 'HTML' });
  await showForceJoinPanel(ctx);
});

// ---------- Reseller ----------
bot.command('setreseller', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return ctx.reply('❌ Khusus admin.');
  const uid = ctx.message.text.split(' ')[1];
  if (!uid) return ctx.reply('Contoh: <code>/setreseller 123456</code>', { parse_mode: 'HTML' });
  await ppob.setRole(Number(uid), 'reseller');
  await ctx.reply(`✅ User <code>${uid}</code> kini <b>RESELLER</b> (diskon 10% VPN).`, { parse_mode: 'HTML' });
});

bot.command('unsetreseller', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return ctx.reply('❌ Khusus admin.');
  const uid = ctx.message.text.split(' ')[1];
  if (!uid) return ctx.reply('Contoh: <code>/unsetreseller 123456</code>', { parse_mode: 'HTML' });
  await ppob.setRole(Number(uid), 'member');
  await ctx.reply(`✅ User <code>${uid}</code> dikembalikan jadi <b>member</b>.`, { parse_mode: 'HTML' });
});

// ---------- Bonus Topup ----------
bot.command('setbonus', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return ctx.reply('❌ Khusus admin.');
  const [, min, persen] = ctx.message.text.split(' ');
  if (!min || !persen) {
    const cfg = await ppob.getBonusConfig();
    return ctx.reply(
      `🎁 <b>Bonus Topup</b>\n\n` +
      `Status: ${cfg.enabled ? '✅ Aktif' : '❌ Nonaktif'}\n` +
      `Min. topup: <b>Rp${Number(cfg.min_topup).toLocaleString('id-ID')}</b>\n` +
      `Bonus: <b>${cfg.bonus_percent}%</b>\n\n` +
      `Atur: <code>/setbonus 50000 10</code>\nNonaktifkan: <code>/setbonus 0 0</code>`,
      { parse_mode: 'HTML' }
    );
  }
  const cfg = await ppob.setBonusConfig(min, persen);
  await ctx.reply(
    `✅ Bonus topup ${cfg.enabled ? 'diaktifkan' : 'dinonaktifkan'}.\n` +
    `Min. topup: <b>Rp${Number(cfg.min_topup).toLocaleString('id-ID')}</b>\n` +
    `Bonus: <b>${cfg.bonus_percent}%</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('cleanup', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return;
  const dry = ctx.message.text.includes('dry');
  if (dry) {
    const r = await cleanup.dryRun();
    const e = r.expired.map((a) => `• <code>${esc(a.proto)}/${esc(a.username)}</code> exp ${esc(a.expiry)}`).join('\n') || '—';
    return ctx.reply(`🧹 <b>DRY RUN</b>\n\nKadaluarsa:\n${e}\n\nTrial menumpuk: ${r.oldTrials.length}`, { parse_mode: 'HTML' });
  }
  await ctx.reply('🧹 Membersihkan...');
  const t = await cleanup.cleanupOldTrials();
  const x = await cleanup.cleanupExpired(async (acc) => {
    try {
      await ctx.telegram.sendMessage(acc.telegram_id,
        `⏰ Akun <b>${acc.proto}/${acc.username}</b> telah kadaluarsa dan dihapus.`, { parse_mode: 'HTML' });
    } catch { /* ignore */ }
  });
  await ctx.reply(`✅ Selesai.\n🗑️ Trial menumpuk: ${t.deleted}\n⏰ Kadaluarsa: ${x.deleted} (notif: ${x.notified})`);
});

// ---------- Auto-cleanup harian (cron dalam proses) ----------
setInterval(async () => {
  try {
    await cleanup.cleanupOldTrials();
    await cleanup.cleanupExpired(async (acc) => {
      try {
        await bot.telegram.sendMessage(acc.telegram_id,
          `⏰ Akun <b>${acc.proto}/${acc.username}</b> telah kadaluarsa dan dihapus.`, { parse_mode: 'HTML' });
      } catch { /* ignore */ }
    });
    console.log('[cleanup] auto-cleanup jalan', new Date().toISOString());
  } catch (e) {
    console.error('[cleanup] error:', e.message);
  }
}, 24 * 60 * 60 * 1000); // tiap 24 jam (cleanup lama, tidak diubah)

// ---------- Sweeper trial 1 jam (baru, tiap 5 menit + sekali saat start) ----------
async function sweepTrialsOnce() {
  try {
    const n = await vpn.sweepExpiredTrials();
    if (n) console.log('[trial] sweeper hapus', n, 'akun trial kadaluarsa');
  } catch (e) { console.error('[trial] sweeper error:', e.message); }
}
setInterval(sweepTrialsOnce, 5 * 60 * 1000);
sweepTrialsOnce();

// ---------- Poller deposit QRIS: kredit saldo otomatis tiap 30 detik ----------
// Deposit yang sudah dibayar di gateway (status paid/success/settled/completed)
// dikreditkan ke saldo user. Klaim atomik: hanya transaksi yang masih 'pending'
// yang diproses. Hanya gateway h2h (GoPay H2H milik sendiri) yang dipoller.
// Baris deposit gateway lama (P2P, gateway='gopay') TIDAK lagi dipoller sejak
// rombak H2H — baris itu menggantung sampai jendela 7 hari habis; selesaikan
// manual bila masih ada saat deploy.
setInterval(async () => {
  try {
    const { all, run } = require('./src/db');
    const pending = await all(
      `SELECT telegram_id, amount, ref_id, payment_id, gateway, mismatch_notified FROM transactions
       WHERE type = 'deposit' AND status = 'pending' AND payment_id != ''
         AND created_at > datetime('now','-7 days')`
    ).catch(() => []);
    if (!pending.length) return;
    for (const tx of pending) {
      try {
        const gw = tx.gateway || 'gopay';
        let isPaid = false;
        if (gw === 'h2h') {
          const st = await h2h.getQrisStatus(tx.payment_id).catch(() => ({ ok: false }));
          if (!st.ok) continue; // gateway tak menjawab; coba putaran berikutnya
          if (h2h.isPaidStatus(st.status)) {
            // FASE 1: paid TANPA field amount = TIDAK terverifikasi.
            // Jangan kredit diam-diam (fail-open lama); tandai review
            // (poller hanya memproses status pending) + beri tahu user.
            if (st.paidAmount == null) {
              const mv = await run(`UPDATE transactions SET status = 'review' WHERE ref_id = ? AND status = 'pending'`, [tx.ref_id]);
              if (mv.changes) {
                await bot.telegram.sendMessage(
                  tx.telegram_id,
                  `⚠️ <b>Pembayaran tercatat, menunggu verifikasi admin.</b>\n\nPembayaran deposit kamu sudah tercatat di gateway, tapi nominalnya belum bisa diverifikasi otomatis sehingga saldo BELUM ditambahkan.\n🧾 Ref: <code>${esc(tx.ref_id)}</code>\nAdmin akan memeriksa manual — jangan bayar ulang.`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
                console.error('[deposit] paid tanpa nominal, ditandai review:', tx.ref_id);
              }
              continue;
            }
            // Verifikasi nominal (dipertahankan dari jalur lama): selisih kode
            // unik kecil (<=1000) ditoleransi; selisih lebih besar = jangan kredit.
            // Pesan ke user cukup sekali (mismatch_notified) walau status
            // tetap pending untuk tindak lanjut manual.
            if (Math.abs(Number(st.paidAmount) - Number(tx.amount)) > 1000) {
              if (!tx.mismatch_notified) {
                await run(`UPDATE transactions SET mismatch_notified = 1 WHERE ref_id = ?`, [tx.ref_id]).catch(() => {});
                await bot.telegram.sendMessage(
                  tx.telegram_id,
                  `⚠️ <b>Nominal deposit tidak cocok.</b>\n\nPembayaran kamu tercatat, tapi nominalnya tidak sama dengan deposit yang dibuat (<b>${digi.rp(tx.amount)}</b>), sehingga saldo BELUM ditambahkan.\n🧾 Ref: <code>${esc(tx.ref_id)}</code>\nHubungi admin dengan nomor ref ini untuk tindak lanjut (verifikasi/refund). Jangan bayar ulang sebelum ada arahan admin.`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              }
              console.error('[deposit] nominal H2H tidak cocok, tidak dikreditkan:', tx.ref_id, 'db=', tx.amount, 'gateway=', st.paidAmount);
              continue;
            }
            isPaid = true;
          } else if (h2h.isExpiredStatus(st.status)) {
            // QRIS H2H berlaku 5 menit — tandai expired, jangan dipoller selamanya.
            await run(`UPDATE transactions SET status = 'expired' WHERE ref_id = ? AND status = 'pending'`,
              [tx.ref_id]);
            continue;
          } else continue; // masih pending / status tak dikenal = belum lunas
        } else {
          continue; // gateway lama (P2P) — tidak lagi dipoller sejak rombak H2H
        }
        if (!isPaid) continue;
        // FASE 1: klaim + kredit SATU transaksi SQLite. Crash di antara
        // klaim dan kredit dulu meninggalkan deposit 'success' tanpa saldo;
        // sekarang gagal di tengah = rollback, baris tetap pending dan
        // diproses ulang putaran berikutnya (klaim tetap anti dobel).
        let s = null;
        try {
          await run('BEGIN IMMEDIATE');
          const r = await run(
            `UPDATE transactions SET status = 'success' WHERE ref_id = ? AND status = 'pending'`,
            [tx.ref_id]
          );
          if (!r.changes) { await run('ROLLBACK'); continue; } // sudah diproses
          s = await ppob.addSaldo(tx.telegram_id, tx.amount);
          await run('COMMIT');
        } catch (e) {
          await run('ROLLBACK').catch(() => {});
          console.error('[deposit] transaksi klaim+kredit gagal, di-rollback:', tx.ref_id, e.message);
          continue;
        }
        // Otomatis jadi reseller bila total topup mencapai batas (diatur admin)
        try {
          const minRes = await settings.getResellerMinTopup();
          if (minRes > 0) {
            const curRole = await ppob.getRole(tx.telegram_id).catch(() => 'member');
            if (curRole === 'member') {
              const tot = await get(
                `SELECT COALESCE(SUM(amount),0) AS t FROM transactions
                 WHERE telegram_id = ? AND type = 'deposit' AND status = 'success'`,
                [tx.telegram_id]
              ).catch(() => ({ t: 0 }));
              if (Number(tot?.t || 0) >= minRes) {
                await ppob.setRole(tx.telegram_id, 'reseller');
                await bot.telegram.sendMessage(
                  tx.telegram_id,
                  `🏪 <b>Selamat! Kamu kini RESELLER</b>\n\nTotal topup kamu mencapai <b>${digi.rp(minRes)}</b>.\nNikmati harga khusus reseller untuk VPN!`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
                notifGrup(bot, `🏪 <b>User naik jadi Reseller</b>\n👤 ID: <code>${tx.telegram_id}</code>\n💰 Total topup: <b>${digi.rp(tot.t)}</b>`);
              }
            }
          }
        } catch (e) { console.error('[deposit] auto-reseller error:', e.message); }
        await bot.telegram.sendMessage(
          tx.telegram_id,
          `✅ <b>Deposit diterima!</b>\n💰 <b>${digi.rp(tx.amount)}</b> masuk ke saldo kamu.` +
          `\n🧾 Ref: <code>${esc(tx.ref_id)}</code>` +
          `\n💳 Saldo sekarang: <b>${digi.rp(s.saldo)}</b>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        console.log(`[deposit] ${tx.ref_id} lunas (${gw}) → saldo +${tx.amount} (tg:${tx.telegram_id})`);
      } catch (e) {
        console.error('[deposit] cek gagal:', tx.ref_id, e.message);
      }
    }
  } catch (e) {
    console.error('[deposit] poller error:', e.message);
  }
}, 30 * 1000);

// ---------- Poller order sewa pending (FIXED: previously manual-only) ----------
// Every 60s: orders still pending are checked; paid orders are marked paid
// and registration is attempted. Failed registration stays 'paid' so the
// manual button can retry, it is never marked fulfilled on failure.
setInterval(async () => {
  try {
    const { all, run } = require('./src/db');
    const pending = await all(
      `SELECT payment_ref, payment_id, amount, telegram_id, mismatch_notified FROM sewa_orders WHERE status = 'pending' AND created_at > datetime('now','-7 days')`
    ).catch(() => []);
    for (const o of pending) {
      try {
        const st = await sewa.checkSewaPayment(o.payment_id).catch(() => ({ status: 'unknown', paidAmount: null }));
        if (h2h.isExpiredStatus(st.status)) {
          // QRIS H2H berlaku 5 menit — tandai expired, jangan dipoller selamanya.
          await sewa.markSewaExpired(o.payment_ref).catch(() => {});
          continue;
        }
        if (!h2h.isPaidStatus(st.status)) continue; // masih pending / tak dikenal = belum lunas
        // FASE 1: paid TANPA field amount = TIDAK terverifikasi — jangan
        // aktifkan diam-diam; tandai review (poller hanya memproses
        // pending) + beri tahu user.
        if (st.paidAmount == null) {
          const mv = await sewa.markSewaReview(o.payment_ref).catch(() => 0);
          if (mv) {
            await bot.telegram.sendMessage(
              o.telegram_id,
              `⚠️ <b>Pembayaran sewa tercatat, menunggu verifikasi admin.</b>\n\nPembayaran order sewa kamu sudah tercatat di gateway, tapi nominalnya belum bisa diverifikasi otomatis sehingga lisensi BELUM diaktifkan.\n🧾 Ref: <code>${esc(o.payment_ref)}</code>\nAdmin akan memeriksa manual — jangan bayar ulang.`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
            console.error('[sewa] paid tanpa nominal, ditandai review:', o.payment_ref);
          }
          continue;
        }
        // Verifikasi nominal: toleransi Rp1.000 menutup selisih kode unik.
        // Pesan ke user cukup sekali (mismatch_notified) walau status
        // tetap pending untuk tindak lanjut manual.
        if (Math.abs(Number(st.paidAmount) - Number(o.amount)) > 1000) {
          if (!o.mismatch_notified) {
            await run(`UPDATE sewa_orders SET mismatch_notified = 1 WHERE payment_ref = ?`, [o.payment_ref]).catch(() => {});
            await bot.telegram.sendMessage(
              o.telegram_id,
              `⚠️ <b>Nominal pembayaran sewa tidak cocok.</b>\n\nPembayaran kamu tercatat, tapi nominalnya tidak sama dengan order sewa (<b>${digi.rp(o.amount)}</b>), sehingga lisensi BELUM diaktifkan.\n🧾 Ref: <code>${esc(o.payment_ref)}</code>\nHubungi admin dengan nomor ref ini untuk tindak lanjut (verifikasi/refund). Jangan bayar ulang sebelum ada arahan admin.`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
          console.error('[sewa] nominal tidak cocok, tidak diaktifkan:', o.payment_ref, 'db=', o.amount, 'gateway=', st.paidAmount);
          continue;
        }
        const claimed = await sewa.markSewaPaid(o.payment_ref);
        if (!claimed) continue; // sudah diproses putaran lain (klaim atomik)
        const order = await sewa.getSewaOrder(o.payment_ref).catch(() => null);
        if (!order) continue;
        const reg = await ipregistry.registerIp(order.username, order.days, order.ip).catch(() => ({ success: false }));
        if (reg && reg.success) await sewa.markSewaFulfilled(o.payment_ref, reg.expiry);
      } catch (e) { /* next order */ }
    }
  } catch (e) { /* ignore */ }
}, 60 * 1000);

// ---------- Poller order PPOB pending: cek status otomatis tiap 60 detik ----------
// Order yang masih 'pending' di Digiflazz dicek ulang otomatis; bila sukses user
// dapat notif, bila gagal saldo dikembalikan (lewat ppob.checkOrder).
setInterval(async () => {
  try {
    const { all } = require('./src/db');
    const pending = await all(
      `SELECT ref_id, telegram_id FROM transactions
       WHERE type = 'ppob' AND status = 'pending'
         AND created_at > datetime('now','-24 hours')`
    ).catch(() => []);
    if (!pending.length) return;
    for (const tx of pending) {
      try {
        const r = await ppob.checkOrder(tx.ref_id);
        if (r.status === 'success') {
          await bot.telegram.sendMessage(
            tx.telegram_id,
            `✅ <b>Transaksi PPOB sukses!</b>\n🧾 Ref: <code>${esc(tx.ref_id)}</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        } else if (r.status === 'failed') {
          await bot.telegram.sendMessage(
            tx.telegram_id,
            `❌ <b>Transaksi PPOB gagal.</b>\n🧾 Ref: <code>${esc(tx.ref_id)}</code>\n💰 Saldo dikembalikan.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      } catch (e) { /* lanjut ke order berikutnya */ }
    }
  } catch (e) {
    console.error('[ppob] poller error:', e.message);
  }
}, 60 * 1000);

// ---------- Auto-sync produk Digiflazz (cache lokal, anti rate-limit) ----------
(async () => {
  try {
    const cached = require('./src/db').products();
    const intervalMs = (config.syncMinutes || 60) * 60 * 1000;
    if (!cached.lastSync || Date.now() - cached.lastSync > intervalMs) {
      console.log('[digiflazz] sync produk awal...');
      await digi.sync().catch((e) => console.error('[digiflazz] sync awal gagal:', e.message));
    }
  } catch (e) { console.error('[digiflazz] cek cache gagal:', e.message); }
})();
setInterval(async () => {
  try {
    await digi.sync();
    console.log('[digiflazz] auto-sync produk OK', new Date().toISOString());
  } catch (e) { console.error('[digiflazz] auto-sync produk gagal:', e.message); }
}, (config.syncMinutes || 60) * 60 * 1000);

bot.command('syncproduk', async (ctx) => {
  if (!await admin.hasAdminAccess(ctx)) return;
  await ctx.reply('⏳ Sinkronisasi produk Digiflazz...');
  try {
    const out = await digi.sync();
    const n = (out.list_prepaid || []).length;
    await ctx.reply(`✅ Sinkronisasi selesai.\n📦 ${n} produk prabayar dimuat.`);
  } catch (e) {
    await ctx.reply(`❌ Gagal sync: ${esc(e.message)}`);
  }
});

// ---------- Error handler ----------
bot.catch(async (err, ctx) => {
  console.error('Bot error:', err.message);
  let msg = '❌ Terjadi kesalahan. Coba lagi.';
  try { if (ctx && await admin.hasAdminAccess(ctx)) msg = `❌ Terjadi kesalahan: ${esc(String(err.message || err)).slice(0, 200)}`; } catch (_) {}
  ctx?.reply?.(msg).catch(() => {});
});

// ---------- Start ----------
(async () => {
  await initDb();
  await vpn.seedVpnPrices().catch((e) => console.error('seed vpn prices:', e.message));
  await sewa.initTable().catch((e) => console.error('sewa table:', e.message));
  console.log('✅ Database siap');
  await 
// ---------- Backup & Restore Database (admin) ----------
bot.command('riwayat', async (ctx) => {
  await ensureUser(ctx);
  const msg = await ppob.getHistory(ctx.from.id, 10);
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('backupdb', async (ctx) => {
  if (!(await admin.hasAdminAccess(ctx))) return ctx.reply('❌ Khusus admin.');
  const fs = require('fs');
  const path = require('path');
  const dbPath = path.join(__dirname, 'data', 'bot.db');
  const backupDir = path.join(__dirname, 'data', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(backupDir, `bot-backup-${ts}.db`);
  try {
    fs.copyFileSync(dbPath, backupPath);
    await ctx.replyWithDocument({ source: backupPath }, { caption: `✅ Backup database berhasil.\n📁 ${path.basename(backupPath)}` });
  } catch (e) {
    await ctx.reply(`❌ Backup gagal: ${e.message}`);
  }
});

bot.command('restoredb', async (ctx) => {
  if (!(await admin.hasAdminAccess(ctx))) return ctx.reply('❌ Khusus admin.');
  await ctx.reply(
    '⚠️ <b>Restore Database</b>\n\n' +
    'Kirim file <b>.db</b> backup sebagai dokumen ke chat ini untuk restore.\n' +
    'Bot akan restart setelah restore.',
    { parse_mode: 'HTML' }
  );
  sessions.set(ctx.chat.id, { step: 'restore_db' });
});

// Webhook otomatis saat boot (skrip sewa: tanpa input, tanpa tap tombol).
// Bila domain + kunci gateway sudah ada: pastikan URL webhook bot terdaftar.
// - Secret baru dibuat saat boot -> hapus pendaftaran lama (secret lama), daftar baru.
// - Sudah terdaftar -> diam. Gagal (gateway down) -> log saja, poller tetap jalan.
async function ensureWebhook() {
  try {
    const url = apiSettings.webhookUrl();
    if (!url || !config.h2h?.apiKey) return;
    const list = await h2h.listWebhooks();
    const mine = list.filter((w) => w.url === url);
    if (config.webhook?.generated && mine.length) {
      for (const w of mine) { try { await h2h.deleteWebhook(w.id); } catch (_) {} }
    } else if (mine.length) {
      return;
    }
    const r = await h2h.registerWebhook(url);
    console.log(`[webhook] auto-terdaftar: ${url} (already=${r.already})`);
    if (!r.already && config.adminId) {
      try { await bot.telegram.sendMessage(config.adminId, `✅ <b>Webhook deposit terdaftar otomatis.</b>\n<code>${esc(url)}</code>`, { parse_mode: 'HTML' }); } catch (_) {}
    }
  } catch (e) {
    console.error('[webhook] auto-daftar gagal:', e?.message || '');
  }
}

// Receiver webhook deposit (Fase 1) — loopback saja, belum diekspos publik.
require('./src/webhook').start({
  bot, ppob, settings, digi, esc, notifGrup,
  db: require('./src/db'),
  secret: config.webhook.secret, port: config.webhook.port,
});

bot.launch();
setTimeout(() => { ensureWebhook().catch(() => {}); }, 3000);
  console.log('🤖 Bot RIPZZ berjalan (@Notif2Ajibot)');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
