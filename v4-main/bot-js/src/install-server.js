'use strict';
// ============================================================
// Install Server Baru — instalasi stack VPN (installer --remote)
// ke VPS baru lewat SSH, lalu baca kunci auth vpn-api untuk
// auto-registrasi ke tabel servers (bot utama).
//
// - Tanpa dependensi baru: memakai biner `ssh` (OpenSSH) via child_process.
// - Kunci SSH khusus installer: /root/.ssh/bot-installer (env INSTALL_SSH_KEY).
//   Kunci PUBLIK-nya ditambahkan owner ke VPS baru lewat konsol provider
//   (DigitalOcean) saat membuat droplet — TIDAK PERNAH password root di chat.
// - Host key VPS baru diterima sekali (StrictHostKeyChecking=accept-new);
//   kunci host yang BERUBAH ditolak (perlindungan MITM pada koneksi berikut).
// - Kunci auth vpn-api (VPN_API_AUTH) TIDAK PERNAH dicetak/log — hanya
//   dikembalikan ke pemanggil untuk disimpan ke tabel servers (api_auth).
// - Batasan: instalasi berjalan selama proses bot hidup; bila bot di-restart
//   di tengah instalasi, SSH ikut mati dan instalasi remote ikut berhenti.
//   Jangan restart bot selama instalasi berjalan (5-15 menit).
// ============================================================
const { execFile } = require('child_process');
const fs = require('fs');

const INSTALL_KEY = process.env.INSTALL_SSH_KEY || '/root/.ssh/bot-installer';
// Installer --remote: apt + Node + Xray + PKI OpenVPN bisa 5-15 menit.
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const SSH_BASE = ['-i', INSTALL_KEY, '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=20',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

function validIp(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '')) return false;
  return ip.split('.').every((n) => { const v = Number(n); return v >= 0 && v <= 255; });
}

// IP publik (bukan privat/loopback/link-local) — untuk firewall remote.
function validPublicIp(ip) {
  if (!validIp(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 127 || a === 169) return false;
  return true;
}

function validDomain(d) {
  return /^[A-Za-z0-9.-]+$/.test(d || '');
}

function runLocal(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 15000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
}

// IP publik bot ini (server2) — dipakai sebagai REMOTE_MAIN_IP untuk
// firewall port API 5890 di server remote. Urutan: hostname -I (IP utama
// interface; pada droplet cloud = IP publik), fallback ifconfig.me.
// Gagal = '' (pemanggil membatalkan instalasi, fail-closed).
async function getMainBotIp() {
  const fromIface = await runLocal('sh', ['-c', "hostname -I 2>/dev/null | awk '{print $1}'"]);
  if (validPublicIp(fromIface)) return fromIface;
  const fromWeb = await runLocal('curl', ['-fsSL', '-m', '8', 'https://ifconfig.me']);
  if (validPublicIp(fromWeb)) return fromWeb;
  return '';
}

function runSsh(ip, remoteCmd, timeoutMs) {
  return new Promise((resolve) => {
    const args = SSH_BASE.concat([`root@${ip}`, remoteCmd]);
    execFile('ssh', args, {
      timeout: timeoutMs || 60000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr ? '\n' + stderr : '');
      if (!err) return resolve({ ok: true, code: 0, output: out });
      resolve({
        ok: false,
        code: (err && err.code != null) ? err.code : -1,
        signal: err.signal || null,
        timedOut: !!err.killed,
        output: out,
      });
    });
  });
}

// Jalankan installer --remote di VPS baru.
// Mengembalikan { ok, message?, tail?, output? }.
async function installRemoteServer({ ip, domain }) {
  if (!fs.existsSync(INSTALL_KEY)) {
    return {
      ok: false,
      message: 'Kunci SSH installer belum dibuat di server bot (' + INSTALL_KEY + ' tidak ada). Buat dulu keypair-nya, lalu tambahkan kunci publik ke VPS baru lewat konsol provider.',
      tail: '',
    };
  }
  // IP publik bot ini wajib diteruskan ke installer (firewall API 5890).
  const mainIp = await getMainBotIp();
  if (!mainIp) {
    return {
      ok: false,
      message: 'IP publik bot utama tidak bisa ditentukan (hostname -I / ifconfig.me gagal). Instalasi dibatalkan — tanpa IP ini, firewall port API 5890 di server remote tidak bisa dibatasi.',
      tail: '',
    };
  }
  const dom = domain ? ` REMOTE_DOMAIN='${domain}'` : '';
  const cmd = `curl -fsSL https://raw.githubusercontent.com/ripzzsc/Darren/main/install.sh -o /tmp/darren-install-remote.sh && chmod +x /tmp/darren-install-remote.sh && REMOTE_MAIN_IP='${mainIp}'${dom} /tmp/darren-install-remote.sh --remote`;
  const r = await runSsh(ip, cmd, INSTALL_TIMEOUT_MS);
  const lines = String(r.output || '').split('\n');
  const tail = lines.slice(-40).join('\n');
  if (!r.ok) {
    const why = r.timedOut
      ? 'waktu habis (20 menit) — instalasi mungkin masih berjalan di VPS; cek lewat SSH manual'
      : `keluar dengan kode ${r.code}`;
    return { ok: false, message: `SSH/install gagal (${why}).`, tail, code: r.code };
  }
  // Installer --remote mencetak "=== Selesai ===" + "Server remote:" bila sukses.
  if (!/=== Selesai ===/.test(r.output) || !/Server remote:/.test(r.output)) {
    return {
      ok: false,
      message: 'Installer selesai tanpa penanda sukses (tidak ada "=== Selesai ===" / "Server remote:"). Periksa log instalasi.',
      tail,
      code: r.code,
    };
  }
  return { ok: true, output: r.output, tail };
}

// Baca VPN_API_AUTH dari /etc/vpn-api/auth.env di VPS remote via SSH.
// Mengembalikan kunci (string) atau null. TIDAK PERNAH mencetak nilainya.
async function readRemoteAuth(ip) {
  const r = await runSsh(ip, 'cat /etc/vpn-api/auth.env', 30000);
  if (!r.ok) return null;
  const m = String(r.output || '').match(/^VPN_API_AUTH=([0-9a-fA-F]+)\s*$/m);
  return m ? m[1] : null;
}

// Baca kunci PUBLIK installer (INSTALL_KEY + '.pub') untuk ditampilkan
// di bot agar admin bisa menyalinnya ke VPS baru lewat konsol provider.
// Aman ditampilkan: ini kunci PUBLIK, bukan privat. Mengembalikan string
// kunci atau null bila file tidak ada / tidak terbaca.
function getInstallerPublicKey() {
  try {
    const pub = INSTALL_KEY + '.pub';
    if (!fs.existsSync(pub)) return null;
    const key = fs.readFileSync(pub, 'utf8').trim();
    return key || null;
  } catch (_) { return null; }
}

// Jalankan uninstaller di VPS remote (backup + hapus stack Darren).
// Mengembalikan { ok, message?, tail?, output?, code? }.
const UNINSTALL_TIMEOUT_MS = 10 * 60 * 1000;
async function uninstallRemoteServer(ip) {
  if (!fs.existsSync(INSTALL_KEY)) {
    return {
      ok: false,
      message: 'Kunci SSH installer belum dibuat di server bot (' + INSTALL_KEY + ' tidak ada). Buat dulu keypair-nya, lalu tambahkan kunci publik ke VPS itu lewat konsol provider.',
      tail: '',
    };
  }
  const cmd = `curl -fsSL https://raw.githubusercontent.com/ripzzsc/Darren/main/uninstall.sh -o /tmp/darren-uninstall-remote.sh && chmod +x /tmp/darren-uninstall-remote.sh && echo YA | bash /tmp/darren-uninstall-remote.sh`;
  const r = await runSsh(ip, cmd, UNINSTALL_TIMEOUT_MS);
  const lines = String(r.output || '').split('\n');
  const tail = lines.slice(-40).join('\n');
  if (!r.ok) {
    const why = r.timedOut
      ? 'waktu habis (10 menit) — uninstall mungkin masih berjalan di VPS; cek lewat SSH manual'
      : `keluar dengan kode ${r.code}`;
    return { ok: false, message: `SSH/uninstall gagal (${why}).`, tail, code: r.code };
  }
  // Uninstaller mencetak "=== Selesai uninstall ===" + "Backup: ..." bila sukses.
  if (!/=== Selesai uninstall ===/.test(r.output)) {
    return {
      ok: false,
      message: 'Uninstaller selesai tanpa penanda sukses (tidak ada "=== Selesai uninstall ==="). Periksa log uninstall.',
      tail,
      code: r.code,
    };
  }
  return { ok: true, output: r.output, tail };
}

// Install ulang VPS remote: uninstall (backup + hapus total) lalu
// install --remote fresh. Mengembalikan hasil installRemoteServer,
// atau error dari tahap uninstall (stage: 'uninstall' / 'install').
async function reinstallRemoteServer({ ip, domain }) {
  const un = await uninstallRemoteServer(ip);
  if (!un.ok) return { ok: false, stage: 'uninstall', message: un.message, tail: un.tail, code: un.code };
  const inst = await installRemoteServer({ ip, domain });
  if (!inst.ok) return { ok: false, stage: 'install', message: inst.message, tail: inst.tail, code: inst.code };
  return { ok: true, output: inst.output, tail: inst.tail };
}

// Status layanan di VPS remote via SSH (untuk monitoring mendalam).
// Mengembalikan { reachable, xray, vpnApi, nginx, haproxy, apiHealth }.
// Semua boolean; reachable=false bila SSH tidak nyambung.
async function getRemoteServiceStatus(ip) {
  const cmd = `for s in xray vpn-api nginx haproxy; do printf '%s:%s\\n' "$s" "$(systemctl is-active $s 2>/dev/null || echo unknown)"; done; echo ---; curl -fsS --max-time 8 http://127.0.0.1:5890/health 2>&1 | head -2`;
  const r = await runSsh(ip, cmd, 30000);
  const out = String(r.output || '');
  const parse = (name) => {
    const m = out.match(new RegExp('^' + name + ':(\\S+)', 'm'));
    return m ? m[1] === 'active' : false;
  };
  return {
    reachable: r.ok,
    xray: parse('xray'),
    vpnApi: parse('vpn-api'),
    nginx: parse('nginx'),
    haproxy: parse('haproxy'),
    apiHealth: /"status"\s*:\s*"success"/.test(out),
  };
}

module.exports = { validIp, validDomain, validPublicIp, getMainBotIp, installRemoteServer, readRemoteAuth, getInstallerPublicKey, uninstallRemoteServer, reinstallRemoteServer, getRemoteServiceStatus, INSTALL_KEY };
