// ============================================================
// Modul VPN — SSH / VMess / VLess / Trojan (+ mode CloudFront)
// Membuat akun via API server VPN, format output siap copy.
// ============================================================
const axios = require('axios');
const fs = require('fs');
const config = require('../src/config');
const { run, get, all } = require('../src/db');
const { esc } = require('../src/format');

const { apiBase, apiAuth, domain } = config.vpn;
const cf = config.cloudfront;

const api = axios.create({ baseURL: apiBase, timeout: 60000 });

function apiParams(extra = {}) {
  return { auth: apiAuth, ...extra };
}
// ---------- Multi-server: routing API per server ----------
// Server default (id 0 / null) = apiBase/apiAuth dari .env (perilaku lama).
// Server terdaftar = baris tabel servers (api_base + api_auth + domain).
function apiFor(srv) {
  if (srv && srv.api_base) return axios.create({ baseURL: srv.api_base.replace(/\/$/, ''), timeout: 60000 });
  return api;
}
function apiAuthFor(srv) {
  return (srv && srv.api_auth) || apiAuth;
}
function dispDomain(srv) {
  return (srv && srv.domain) || domain;
}
function apiParamsFor(srv, extra = {}) {
  return { auth: apiAuthFor(srv), ...extra };
}
async function getServer(id) {
  const sid = Number(id) || 0;
  if (!sid) return null;
  return get('SELECT * FROM servers WHERE id = ?', [sid]).catch(() => null);
}
async function listBuyServers() {
  // Hanya server AKTIF (health check lolos saat didaftarkan) dengan
  // api_base terisi yang bisa dipakai membuat akun. Bila kolom active
  // belum ada (DB sangat lama / migrasi gagal), query error -> [] sehingga
  // pemilih server disembunyikan dan alur jatuh ke server utama (aman).
  return all("SELECT * FROM servers WHERE active = 1 AND api_base IS NOT NULL AND api_base != '' ORDER BY id").catch(() => []);
}


const validUser = (u) => /^[a-zA-Z0-9]{3,20}$/.test(u || '');

function expiryDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

// ---------- Format tampilan kotak (fancy) hasil pembuatan akun ----------
// Port yang ditampilkan hanya yang terverifikasi sebagai layanan VPN:
// TLS 443, HTTP 80, OpenSSH 22, Dropbear 109/143. Port contoh lain
// (8443, 8080, 2086, 8880, UDPSSH 1-65535, DNS 53, BadVPN 7300) sengaja
// TIDAK ditampilkan: 8443 tidak mendengarkan di Aji02, 53/7300 hanya
// localhost, dan servis 8080/2086/8880 tidak terverifikasi sebagai
// Save-account berupa file publik sudah dihapus (P0): kredensial akun
// hanya ada di pesan Telegram pribadi user, bukan file di /var/www/html.
const FANCY_TOP = '╭━━━━━━━━━━━━━━━━━━━━━━╮';
const FANCY_BOT = '╰━━━━━━━━━━━━━━━━━━━━━━╯';
const FANCY_SEP = '━━━━━━━━━━━━━━━━━━━━━━';
const FANCY_TITLES = {
  ssh: '🚀 ꜱꜱʜ ᴀᴄᴄᴏᴜɴᴛ',
  vmess: '🚀 ᴠᴍᴇꜱꜱ ᴀᴄᴄᴏᴜɴᴛ',
  vless: '🚀 ᴠʟᴇꜱꜱ ᴀᴄᴄᴏᴜɴᴛ',
  trojan: '🚀 ᴛʀᴏᴊᴀɴ ᴀᴄᴄᴏᴜɴᴛ',
  shadowsocks: '🚀 ꜱʜᴀᴅᴏᴡꜱᴏᴄᴋꜱ ᴀᴄᴄᴏᴜɴᴛ',
};

function fancyBox(d) {
  const lines = [];
  lines.push(FANCY_TOP);
  lines.push((FANCY_TITLES[d.proto] || '🚀 ᴀᴄᴄᴏᴜɴᴛ') + (d.viaCF ? ' ☁️' : ''));
  lines.push(FANCY_BOT);
  lines.push('');
  const info = [
    '┌〔 📄 ᴀᴄᴄᴏᴜɴᴛ ɪɴꜰᴏ 〕',
    `├ 👤 Username : <code>${esc(d.username)}</code>`,
    `├ ${d.secretIcon} ${d.secretLabel} : <code>${esc(d.secret)}</code>`,
    `├ 📅 Expired : <code>${esc(d.exp)}</code>`,
  ];
  if (d.proto === 'ssh') info.push(`├ 🌐 IP Limit : ${d.ipLimit} IP`);
  info.push('└ 🟢 Status : ACTIVE');
  lines.push(info.join('\n'));
  lines.push('');
  lines.push(FANCY_SEP);
  lines.push('');
  const srv = [
    '┌〔 🌍 ꜱᴇʀᴠᴇʀ 〕',
    `├ 🌐 Domain : <code>${esc(d.origin)}</code>`,
  ];
  if (d.cfDomain) srv.push(`└ ☁️ CloudFront : <code>${esc(d.cfDomain)}</code>`);
  else srv[srv.length - 1] = srv[srv.length - 1].replace('├', '└');
  lines.push(srv.join('\n'));
  lines.push('');
  lines.push(FANCY_SEP);
  lines.push('');
  if (d.proto === 'ssh') {
    const ports = d.viaCF
      ? ['┌〔 🔌 ᴘᴏʀᴛ 〕', '└ 🔐 TLS : 443']
      : ['┌〔 🔌 ᴘᴏʀᴛ 〕', '├ 🔐 TLS : 443', '├ 🌐 HTTP : 80', '└ ⚡ OpenSSH : 22'];
    lines.push(ports.join('\n'));
    lines.push('');
    lines.push(FANCY_SEP);
    lines.push('');
    lines.push('📡 ʜᴛᴛᴘ ᴄᴜꜱᴛᴏᴍ');
    lines.push('');
    for (const hc of d.httpCustom) lines.push(`<code>${esc(hc.host)}:${hc.port}@${esc(hc.user)}:${esc(hc.pass)}</code>\n`);
    lines.push(FANCY_SEP);
    lines.push('');
    lines.push('📄 ᴘᴀʏʟᴏᴀᴅ');
    lines.push('');
    lines.push(`<code>${d.payload}</code>`);
  } else {
    lines.push('┌〔 🔌 ᴘᴏʀᴛ 〕');
    lines.push('├ 🔐 TLS : 443');
    lines.push('└ 🌐 HTTP : 80');
    lines.push('');
    lines.push(FANCY_SEP);
    lines.push('');
    const links = d.links || (d.link ? { tls: d.link } : {});
    if (links.tls) { lines.push('🔗 ᴜʀʟ ᴛʟꜱ'); lines.push(''); lines.push(`<pre>${links.tls}</pre>`); lines.push(''); }
    if (links.http) { lines.push('🔗 ᴜʀʟ ʜᴛᴛᴘ'); lines.push(''); lines.push(`<pre>${links.http}</pre>`); lines.push(''); }
    if (links.grpc) { lines.push('🔗 ᴜʀʟ ɢʀᴘᴄ'); lines.push(''); lines.push(`<pre>${links.grpc}</pre>`); lines.push(''); }
    lines.push(FANCY_SEP);
    lines.push('');
    lines.push('┌〔 🌐 ᴡꜱ ᴅᴇᴛᴀɪʟ 〕');
    lines.push(`├ 🌐 Host : <code>${esc(d.host)}</code>`);
    lines.push('├ 🔐 Port TLS : 443');
    lines.push('├ 🌐 Port HTTP : 80');
    lines.push(`├ 🛣️ Path : <code>${esc(d.wsPath)}</code>`);
    lines.push(`└ 🔑 SNI : <code>${esc(d.host)}</code>`);
    if (d.grpcService) {
      lines.push('');
      lines.push('┌〔 🌐 ɢʀᴘᴄ ᴅᴇᴛᴀɪʟ 〕');
      lines.push(`├ 🌐 Host : <code>${esc(d.host)}</code>`);
      lines.push('├ 🔐 Port : 443');
      lines.push(`├ 🛣️ ServiceName : <code>${esc(d.grpcService)}</code>`);
      lines.push(`└ 🔑 SNI : <code>${esc(d.host)}</code>`);
    }
    if (d.method) { lines.push(''); lines.push(`🔐 Method : <code>${esc(d.method)}</code>`); }
  }
  lines.push('');
  lines.push(FANCY_SEP);
  lines.push('');
  lines.push('🎉 ᴀᴋᴜɴ ʙᴇʀʜᴀꜱɪʟ ᴅɪʙᴜᴀᴛ');
  lines.push('');
  lines.push('🤝 ᴛᴇʀɪᴍᴀ ᴋᴀꜱɪʜ');
  lines.push('ꜱᴇʟᴀᴍᴀᴛ ᴍᴇɴɢɢᴜɴᴀᴋᴀɴ');
  lines.push('ʟᴀʏᴀɴᴀɴ ᴋᴀᴍɪ. ❤️');
  return lines.join('\n');
}



const PROTO_WS_PATH = { vmess: '/vmess', vless: '/vless', trojan: '/trojan', shadowsocks: '/ss-ws' };
const PROTO_GRPC = { vmess: 'vmess-grpc', vless: 'vless-grpc', trojan: 'trojan-grpc', shadowsocks: 'ss-grpc' };

function buildXrayLinks(proto, remark, secret, host, wsPath) {
  const wp = wsPath || PROTO_WS_PATH[proto] || '';
  const grpc = PROTO_GRPC[proto] || '';
  if (proto === 'vmess') {
    return {
      tls: vmessLink(secret, remark, host, 443, wp, true),
      http: vmessLink(secret, remark, host, 80, wp, false),
      grpc: vmessLink(secret, remark, host, 443, grpc, true, 'grpc'),
    };
  }
  if (proto === 'vless') {
    return {
      tls: `vless://${secret}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&path=${encodeURIComponent(wp)}&host=${host}#${remark}`,
      http: `vless://${secret}@${host}:80?encryption=none&security=none&type=ws&path=${encodeURIComponent(wp)}&host=${host}#${remark}`,
      grpc: `vless://${secret}@${host}:443?encryption=none&security=tls&sni=${host}&type=grpc&serviceName=${grpc}#${remark}`,
    };
  }
  if (proto === 'trojan') {
    return {
      tls: `trojan://${secret}@${host}:443?security=tls&sni=${host}&type=ws&path=${encodeURIComponent(wp)}&host=${host}#${remark}`,
      http: `trojan://${secret}@${host}:80?security=none&type=ws&path=${encodeURIComponent(wp)}&host=${host}#${remark}`,
      grpc: `trojan://${secret}@${host}:443?security=tls&sni=${host}&type=grpc&serviceName=${grpc}#${remark}`,
    };
  }
  if (proto === 'shadowsocks') {
    const method = 'aes-256-gcm';
    return {
      tls: ssLink(method, secret, host, 443, remark, `v2ray-plugin;tls;host=${host};path=${wp}`),
      http: ssLink(method, secret, host, 80, remark, `v2ray-plugin;host=${host};path=${wp}`),
      grpc: ssLink(method, secret, host, 443, remark, `v2ray-plugin;tls;mode=grpc;serviceName=${grpc};host=${host}`),
    };
  }
  return null;
}

function stripHtml(x) { return String(x || '').replace(/<[^>]*>/g, ''); }
function isLocalServer(srv) { return dispDomain(srv) === domain; }
// P0: kredensial akun TIDAK LAGI ditulis ke /var/www/html (publik via :81).
// Akun lengkap sudah ada di pesan Telegram pribadi user; tidak ada file publik.
function writeSaveFile(proto, username, txt, hostDomain) {
  return null;
}
function deleteSaveFile(proto, username) {
  // Dulu menghapus file publik di atas; sekarang tidak ada file yang dibuat.
  return;
}
// SAVE ACCOUNT berupa file publik sudah dihapus (lihat writeSaveFile).
// Pesan akun dikirim apa adanya; server remote tidak diubah.
// Pesan gagal / protokol lain tidak diubah.
function attachSave(proto, username, message, srv) {
  if (!['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks'].includes(proto)) return { message, saveUrl: null };
  if (!isLocalServer(srv)) return { message, saveUrl: null };
  const saveUrl = writeSaveFile(proto, username, stripHtml(message), dispDomain(srv));
  if (!saveUrl) return { message, saveUrl: null };
  const section = `💾 ꜱᴀᴠᴇ ᴀᴄᴄᴏᴜɴᴛ\n\n<code>${esc(saveUrl)}</code>\n\n`;
  const marker = '🎉 ᴀᴋᴜɴ ʙᴇʀʜᴀꜱɪʟ ᴅɪʙᴜᴀᴛ';
  const out = message.includes(marker) ? message.replace(marker, section + marker) : message + '\n\n' + section;
  return { message: out, saveUrl };
}

function buildClash(proto, username, secret, host, links) {
  const wp = PROTO_WS_PATH[proto] || '';
  const grpc = PROTO_GRPC[proto] || '';
  const lines = [`# Clash config - ${username} (${proto}) - ${host}`, 'proxies:'];
  if (proto === 'vmess') {
    lines.push(`  - {name: ${username}-TLS, type: vmess, server: ${host}, port: 443, uuid: ${secret}, alterId: 0, cipher: auto, udp: true, tls: true, skip-cert-verify: true, servername: ${host}, network: ws, ws-opts: {path: ${wp}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-HTTP, type: vmess, server: ${host}, port: 80, uuid: ${secret}, alterId: 0, cipher: auto, udp: true, tls: false, network: ws, ws-opts: {path: ${wp}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-GRPC, type: vmess, server: ${host}, port: 443, uuid: ${secret}, alterId: 0, cipher: auto, udp: true, tls: true, skip-cert-verify: true, servername: ${host}, network: grpc, grpc-opts: {grpc-service-name: ${grpc}}}`);
  } else if (proto === 'vless') {
    lines.push(`  - {name: ${username}-TLS, type: vless, server: ${host}, port: 443, uuid: ${secret}, udp: true, tls: true, skip-cert-verify: true, servername: ${host}, network: ws, ws-opts: {path: ${wp}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-HTTP, type: vless, server: ${host}, port: 80, uuid: ${secret}, udp: true, tls: false, network: ws, ws-opts: {path: ${wp}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-GRPC, type: vless, server: ${host}, port: 443, uuid: ${secret}, udp: true, tls: true, skip-cert-verify: true, servername: ${host}, network: grpc, grpc-opts: {grpc-service-name: ${grpc}}}`);
  } else if (proto === 'trojan') {
    lines.push(`  - {name: ${username}-TLS, type: trojan, server: ${host}, port: 443, password: ${secret}, udp: true, tls: true, skip-cert-verify: true, sni: ${host}, network: ws, ws-opts: {path: ${wp}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-HTTP, type: trojan, server: ${host}, port: 80, password: ${secret}, udp: true, tls: false, network: ws, ws-opts: {path: ${wp}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-GRPC, type: trojan, server: ${host}, port: 443, password: ${secret}, udp: true, tls: true, skip-cert-verify: true, sni: ${host}, network: grpc, grpc-opts: {grpc-service-name: ${grpc}}}`);
  } else if (proto === 'shadowsocks') {
    lines.push(`  - {name: ${username}-TLS, type: ss, server: ${host}, port: 443, cipher: aes-256-gcm, password: ${secret}, udp: true, plugin: v2ray-plugin, plugin-opts: {mode: websocket, tls: true, host: ${host}, path: ${wp}}}`);
    lines.push(`  - {name: ${username}-HTTP, type: ss, server: ${host}, port: 80, cipher: aes-256-gcm, password: ${secret}, udp: true, plugin: v2ray-plugin, plugin-opts: {mode: websocket, host: ${host}, path: ${wp}}}`);
  } else return null;
  if (links) lines.push('', '# Link (salin dari pesan akun):', `# TLS: ${links.tls || ''}`, `# HTTP: ${links.http || ''}`, `# GRPC: ${links.grpc || ''}`);
  return lines.join('\n') + '\n';
}

function buildV2ray(proto, username, secret, host, wsPath) {
  const wp = wsPath || PROTO_WS_PATH[proto] || '';
  let outbound;
  if (proto === 'vmess') {
    outbound = { protocol: 'vmess', settings: { vnext: [{ address: host, port: 443, users: [{ id: secret, alterId: 0, security: 'auto' }] }] }, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: host }, wsSettings: { path: wp, headers: { Host: host } } } };
  } else if (proto === 'vless') {
    outbound = { protocol: 'vless', settings: { vnext: [{ address: host, port: 443, users: [{ id: secret, encryption: 'none', flow: '' }] }] }, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: host }, wsSettings: { path: wp, headers: { Host: host } } } };
  } else if (proto === 'trojan') {
    outbound = { protocol: 'trojan', settings: { servers: [{ address: host, port: 443, password: secret, email: username }] }, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: host }, wsSettings: { path: wp, headers: { Host: host } } } };
  } else if (proto === 'shadowsocks') {
    outbound = { protocol: 'shadowsocks', settings: { servers: [{ address: host, port: 443, method: 'aes-256-gcm', password: secret, email: username, ota: false }] }, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: host }, wsSettings: { path: wp, headers: { Host: host } } } };
  } else return null;
  return JSON.stringify({ log: { loglevel: 'warning' }, inbounds: [{ port: 1080, protocol: 'socks', settings: { auth: 'noauth', udp: true } }], outbounds: [outbound, { protocol: 'freedom', tag: 'direct' }] }, null, 2);
}

// ---------- SSH ----------
async function createSSH(username, password, days, ipLimit = 1, srv = null) {
  if (!validUser(username)) return { success: false, message: '❌ Username 3-20 karakter, huruf/angka saja.' };
  const { data } = await apiFor(srv).get('/createshh', {
    params: apiParamsFor(srv, { user: username, password, exp: days, iplimit: ipLimit }),
  });
  if (data?.status !== 'success') return { success: false, message: `❌ Gagal: ${esc(data?.message || 'API error')}` };
  const exp = expiryDate(days);
  return {
    success: true,
    message: fancyBox({ proto: 'ssh', viaCF: false, username, secretIcon: '🔑', secretLabel: 'Password', secret: password, exp, ipLimit, origin: dispDomain(srv), host: dispDomain(srv), cfDomain: cf.domain || '', httpCustom: [{ host: dispDomain(srv), port: 80, user: username, pass: password }, { host: dispDomain(srv), port: 443, user: username, pass: password }], payload: `GET wss://[host]/ HTTP/1.1[crlf]Host: ${dispDomain(srv)}[crlf]Upgrade: websocket[crlf][crlf]` }),
    expiry: exp,
    password,
  };
}

// ---------- SSH via CloudFront (/cf-ssh) ----------
function cfSSHInfo(username, password, days, srv = null) {
  if (!cf.domain) return { success: false, message: '❌ Domain CloudFront belum diset (.env CF_DOMAIN).' };
  if (!validUser(username)) return { success: false, message: '❌ Username 3-20 karakter, huruf/angka saja.' };
  const exp = expiryDate(days);
  const p = cf.paths.ssh;
  // Format untuk HTTP Custom / aplikasi SSH WS
  const message = fancyBox({ proto: 'ssh', viaCF: true, username, secretIcon: '🔑', secretLabel: 'Password', secret: password, exp, ipLimit: 1, origin: dispDomain(srv), host: cf.domain, cfDomain: cf.domain || '', httpCustom: [{ host: cf.domain, port: 443, user: username, pass: password }], payload: `GET ${p} HTTP/1.1[crlf]Host: ${cf.domain}[crlf]Upgrade: websocket[crlf][crlf]` });
  return { success: true, message, expiry: exp, password };
}

// ---------- VMess ----------
function vmessLink(uuid, remark, host, port, path, tls, net = 'ws') {
  const obj = {
    v: '2', ps: remark, add: host, port: String(port),
    id: uuid, aid: '0', scy: 'auto', net,
    type: 'none', host: host, path, tls: tls ? 'tls' : '',
    sni: tls ? host : '',
  };
  return 'vmess://' + Buffer.from(JSON.stringify(obj)).toString('base64');
}

async function createVMess(username, days, viaCF = false, srv = null) {
  if (!validUser(username)) return { success: false, message: '❌ Username 3-20 karakter, huruf/angka saja.' };
  const uuid = require('crypto').randomUUID();
  const { data } = await apiFor(srv).get('/createvmess', {
    params: apiParamsFor(srv, { user: username, uuid, exp: days }),
  }).catch(() => ({ data: {} }));
  const host = viaCF ? cf.domain : dispDomain(srv);
  if (viaCF && !cf.domain) return { success: false, message: '❌ Domain CloudFront belum diset.' };
  // Mode CF memakai UUID CF yang sudah terdaftar — aman lanjut walau API gagal.
  // Mode biasa: akun harus terdaftar di server; gagal API = gagal jujur (jangan kasih link mati).
  if (!viaCF && data?.status !== 'success')
    return { success: false, message: `❌ Gagal membuat akun: ${esc(data?.message || 'API error')}` };
  const useUuid = viaCF ? cf.vmessUuid || uuid : uuid;
  const path = viaCF ? cf.paths.vmess : '/vmess';
  const remark = viaCF ? `${username}-cf` : username;
  const links = viaCF ? { tls: vmessLink(useUuid, remark, host, 443, path, true) } : buildXrayLinks('vmess', remark, useUuid, host, path);
  const link = links.tls;
  const exp = expiryDate(days);
  return {
    success: true,
    message: fancyBox({ proto: 'vmess', viaCF, username, secretIcon: '🆔', secretLabel: 'UUID', secret: useUuid, exp, origin: dispDomain(srv), host, cfDomain: cf.domain || '', link, links, wsPath: path, grpcService: viaCF ? '' : 'vmess-grpc' }),
    expiry: exp, link, links, uuid: useUuid,
  };
}

// ---------- VLess ----------
async function createVLess(username, days, viaCF = false, srv = null) {
  if (!validUser(username)) return { success: false, message: '❌ Username 3-20 karakter, huruf/angka saja.' };
  const uuid = require('crypto').randomUUID();
  const { data: dataVL } = await apiFor(srv).get('/createvless', { params: apiParamsFor(srv, { user: username, uuid, exp: days }) }).catch(() => ({ data: {} }));
  const host = viaCF ? cf.domain : dispDomain(srv);
  if (viaCF && !cf.domain) return { success: false, message: '❌ Domain CloudFront belum diset.' };
  if (!viaCF && dataVL?.status !== 'success')
    return { success: false, message: `❌ Gagal membuat akun: ${esc(dataVL?.message || 'API error')}` };
  const useUuid = viaCF ? cf.vlessUuid || uuid : uuid;
  const path = encodeURIComponent(viaCF ? cf.paths.vless : '/vless');
  const remark = viaCF ? `${username}-cf` : username;
  const links = viaCF ? { tls: `vless://${useUuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&path=${path}#${remark}` } : buildXrayLinks('vless', remark, useUuid, host, '/vless');
  const link = links.tls;
  const exp = expiryDate(days);
  return {
    success: true,
    message: fancyBox({ proto: 'vless', viaCF, username, secretIcon: '🆔', secretLabel: 'UUID', secret: useUuid, exp, origin: dispDomain(srv), host, cfDomain: cf.domain || '', link, links, wsPath: viaCF ? cf.paths.vless : '/vless', grpcService: viaCF ? '' : 'vless-grpc' }),
    expiry: exp, link, links, uuid: useUuid,
  };
}

// ---------- Trojan ----------
async function createTrojan(username, days, viaCF = false, srv = null) {
  if (!validUser(username)) return { success: false, message: '❌ Username 3-20 karakter, huruf/angka saja.' };
  const password = require('crypto').randomUUID();
  const { data: dataTR } = await apiFor(srv).get('/createtrojan', { params: apiParamsFor(srv, { user: username, password, exp: days }) }).catch(() => ({ data: {} }));
  const host = viaCF ? cf.domain : dispDomain(srv);
  if (viaCF && !cf.domain) return { success: false, message: '❌ Domain CloudFront belum diset.' };
  if (!viaCF && dataTR?.status !== 'success')
    return { success: false, message: `❌ Gagal membuat akun: ${esc(dataTR?.message || 'API error')}` };
  const usePass = viaCF ? cf.trojanPassword || password : password;
  const path = encodeURIComponent(viaCF ? cf.paths.trojan : '/trojan');
  const remark = viaCF ? `${username}-cf` : username;
  const links = viaCF ? { tls: `trojan://${usePass}@${host}:443?security=tls&sni=${host}&type=ws&path=${path}#${remark}` } : buildXrayLinks('trojan', remark, usePass, host, '/trojan');
  const link = links.tls;
  const exp = expiryDate(days);
  return {
    success: true,
    message: fancyBox({ proto: 'trojan', viaCF, username, secretIcon: '🔑', secretLabel: 'Password', secret: usePass, exp, origin: dispDomain(srv), host, cfDomain: cf.domain || '', link, links, wsPath: viaCF ? cf.paths.trojan : '/trojan', grpcService: viaCF ? '' : 'trojan-grpc' }),
    expiry: exp, link, links, password: usePass,
  };
}

// ---------- Shadowsocks ----------
function ssLink(method, password, host, port, remark, plugin = '') {
  const userinfo = Buffer.from(`${method}:${password}`).toString('base64');
  const q = plugin ? `?plugin=${encodeURIComponent(plugin)}` : '';
  return `ss://${userinfo}@${host}:${port}${q}#${encodeURIComponent(remark)}`;
}

async function createShadowsocks(username, days, viaCF = false, srv = null) {
  if (!validUser(username)) return { success: false, message: '\u274c Username 3-20 karakter, huruf/angka saja.' };
  const password = require('crypto').randomUUID();
  const method = 'aes-256-gcm';
  const { data: dataSS } = await apiFor(srv).get('/createss', { params: apiParamsFor(srv, { user: username, password, exp: days }) }).catch(() => ({ data: {} }));
  const host = viaCF ? cf.domain : dispDomain(srv);
  if (!viaCF && dataSS?.status !== 'success')
    return { success: false, message: `❌ Gagal membuat akun: ${esc(dataSS?.message || 'API error')}` };
  if (viaCF && !cf.domain) return { success: false, message: '\u274c Domain CloudFront belum diset.' };
  const port = 443;
  const remark = `${username}${viaCF ? '-cf' : ''}`;
  const links = viaCF ? { tls: ssLink(method, password, host, port, remark) } : buildXrayLinks('shadowsocks', remark, password, host, '/ss-ws');
  const link = links.tls;
  const exp = expiryDate(days);
  return {
    success: true,
    message: fancyBox({ proto: 'shadowsocks', viaCF, username, secretIcon: '🔑', secretLabel: 'Password', secret: password, exp, origin: dispDomain(srv), host, cfDomain: cf.domain || '', link, links, wsPath: '/ss-ws', grpcService: viaCF ? '' : 'ss-grpc', method }),
    expiry: exp, link, links, password, method,
  };
}

// ---------- Renew / Delete (via API server) ----------
async function renewAccount(proto, username, days, srv = null) {
  const { data } = await apiFor(srv).get('/renew', {
    params: apiParamsFor(srv, { proto, user: username, exp: days }),
  }).catch(() => ({ data: {} }));
  if (data?.status === 'success') {
    // Perpanjang dari expiry saat ini (bila masih aktif), bukan dari hari ini —
    // user tidak kehilangan sisa masa aktif yang sudah dibayar.
    const today = new Date().toISOString().slice(0, 10);
    const row = await get('SELECT expiry FROM vpn_accounts WHERE username = ? AND proto = ? AND server_id = ?', [username, proto, srv?.id || 0]).catch(() => null);
    const base = (row?.expiry && row.expiry > today) ? row.expiry : today;
    const d = new Date(base + 'T00:00:00');
    d.setDate(d.getDate() + Number(days));
    const newExp = d.toISOString().slice(0, 10);
    await run('UPDATE vpn_accounts SET expiry = ? WHERE username = ? AND proto = ? AND server_id = ?', [newExp, username, proto, srv?.id || 0]);
    return { success: true, message: `✅ <b>${username}</b> diperpanjang ${days} hari (s/d <code>${newExp}</code>).` };
  }
  return { success: false, message: `❌ Gagal renew: ${esc(data?.message || 'API error')}` };
}

async function deleteAccount(proto, username, srv = null) {
  // JANGAN hapus baris DB kalau API gagal/ditolak: baris dipertahankan
  // supaya sweeper (dan trial-killer server) mencoba lagi. Menghapus baris
  // padahal akun masih hidup di server adalah bug trial-tidak-mati.
  let data = {};
  try {
    const res = await apiFor(srv).get('/delete', { params: apiParamsFor(srv, { proto, user: username }) });
    data = res.data || {};
  } catch (e) {
    console.error('[trial] delete API gagal, baris dipertahankan:', proto, username, e.message);
    return { success: false, message: 'API delete gagal, dicoba lagi di sweep berikutnya.' };
  }
  if (data.status && data.status !== 'success') {
    console.error('[trial] delete API ditolak, baris dipertahankan:', proto, username, data.message);
    return { success: false, message: 'API delete ditolak, dicoba lagi di sweep berikutnya.' };
  }
  await run('DELETE FROM vpn_accounts WHERE username = ? AND proto = ? AND server_id = ?', [username, proto, srv?.id || 0]);
  deleteSaveFile(proto, username);
  return { success: true, message: `🗑️ Akun <b>${username}</b> (${proto}) dihapus.` };
}

async function saveAccount(telegramId, proto, username, expiry, isTrial = 0, viaCF = 0, trialExpiresAt = null, serverId = 0) {
  if (trialExpiresAt) {
    await run(
      'INSERT INTO vpn_accounts (telegram_id, proto, username, expiry, is_trial, via_cf, trial_expires_at, server_id) VALUES (?,?,?,?,?,?,?,?)',
      [telegramId, proto, username, expiry, isTrial, viaCF, trialExpiresAt, serverId]
    );
  } else {
    await run(
      'INSERT INTO vpn_accounts (telegram_id, proto, username, expiry, is_trial, via_cf, server_id) VALUES (?,?,?,?,?,?,?)',
      [telegramId, proto, username, expiry, isTrial, viaCF, serverId]
    );
  }
}

// ---------- Trial 1 jam, 1x/24 jam ----------
// Batas per telegram_id TOTAL (biasa+CF digabung), dicatat di trial_claims
// yang terpisah dari vpn_accounts (baris akun dihapus saat trial habis).
// trial_expires_at disimpan UTC 'YYYY-MM-DD HH:MM:SS' agar sebanding
// dengan datetime('now') SQLite di sweeper.
function trialExpiresAtISO() {
  const d = new Date(Date.now() + 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
async function canClaimTrial(telegramId) {
  // Admin: boleh klaim trial BERKALI-KALI, beda dengan user biasa yang
  // dibatasi 1x/24 jam. Trial admin tetap mati 1 jam via trial_expires_at
  // + sweeper/killer, hanya batas klaimnya yang dibuka.
  try {
    const admins = config.admins || (config.adminId ? [String(config.adminId)] : []);
    if (admins.map(String).includes(String(telegramId))) return true;
    const u = await get('SELECT role FROM users WHERE telegram_id = ?', [telegramId]).catch(() => null);
    if (u && u.role === 'admin') return true;
  } catch {}
  const row = await get(
    `SELECT claimed_at FROM trial_claims WHERE telegram_id = ? AND claimed_at > datetime('now', '-24 hours')`,
    [telegramId]
  ).catch(() => null);
  return !row;
}
async function recordTrialClaim(telegramId) {
  await run(
    `INSERT OR REPLACE INTO trial_claims (telegram_id, claimed_at) VALUES (?, datetime('now'))`,
    [telegramId]
  ).catch(() => {});
}
async function sweepExpiredTrials() {
  const rows = await all(
    `SELECT proto, username, server_id FROM vpn_accounts WHERE is_trial = 1 AND trial_expires_at IS NOT NULL AND trial_expires_at < datetime('now')`
  ).catch(() => []);
  let deleted = 0;
  for (const r of rows) {
    // Hapus lewat API server yang sama dengan tempat trial dibuat
    // (sebelumnya sweeper selalu lewat server utama sehingga trial di
    // server terdaftar tidak pernah mati di server itu).
    try { const srv = await getServer(r.server_id).catch(() => null); const res = await deleteAccount(r.proto, r.username, srv); if (res && res.success) deleted++; } catch {}
  }
  return deleted;
}

async function myAccounts(telegramId) {
  return all('SELECT * FROM vpn_accounts WHERE telegram_id = ? ORDER BY id DESC', [telegramId]);
}


async function createZivpn(username, password, days, srv = null) {
  if (!validUser(username)) return { success: false, message: 'Username 3-20 karakter, huruf/angka saja.' };
  // FASE 2: API menjawab error eksplisit untuk zivpn (API terpisah) —
  // jangan telan error lalu kirim pesan sukses + expiry palsu.
  const { data: dataZ } = await apiFor(srv).get('/createzivpn', { params: apiParamsFor(srv, { user: username, password, exp: days }) }).catch(() => ({ data: {} }));
  if (dataZ?.status !== 'success')
    return { success: false, message: `❌ Gagal membuat akun Zivpn: ${esc(dataZ?.message || 'API error')}` };
  const host = dispDomain(srv);
  const port = 5667;
  const exp = expiryDate(days);
  return {
    success: true,
    message:
      'Zivpn UDP<br><blockquote>' +
      'Username: <code>' + username + '</code><br>' +
      'Password: <code>' + password + '</code><br>' +
      'Host: <code>' + host + '</code><br>' +
      'Port UDP: <code>' + port + '</code><br>' +
      'Expired: <code>' + exp + '</code></blockquote>',
    expiry: exp,
  };
}

// ---------- Harga VPN per role (diatur admin, Rp/hari) ----------
// product_key = jenis akun VPN. Harga disimpan di tabel vpn_prices
// (kolom: product_key, role, price). Role 'admin' selalu harga 0 (modal).
const VPN_PRODUCTS = [
  { key: 'ssh', label: 'SSH' },
  { key: 'vmess', label: 'VMess' },
  { key: 'vless', label: 'VLess' },
  { key: 'trojan', label: 'Trojan' },
  { key: 'shadowsocks', label: 'Shadowsocks' },
  { key: 'zivpn', label: 'Zivpn UDP' },
];
// Default awal (meniru perilaku lama: Rp500/hari, reseller diskon 10%)
const DEFAULT_VPN_PRICE = { member: 500, reseller: 450 };

async function seedVpnPrices() {
  // Migrasi harga CF: kolom cf_price (NULL = fallback ke harga biasa).
  await run('ALTER TABLE vpn_prices ADD COLUMN cf_price INTEGER').catch(() => {});
  for (const p of VPN_PRODUCTS) {
    for (const role of ['member', 'reseller']) {
      await run(
        'INSERT OR IGNORE INTO vpn_prices (product_key, role, price) VALUES (?,?,?)',
        [p.key, role, DEFAULT_VPN_PRICE[role]]
      ).catch(() => {});
    }
  }
}

async function getVpnPrice(productKey, role, viaCF = false) {
  if (role === 'admin') return 0; // harga modal untuk admin
  const row = await get(
    'SELECT price, cf_price FROM vpn_prices WHERE product_key = ? AND role = ?',
    [productKey, role]
  ).catch(() => null);
  const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const biasa = (row && isNum(row.price))
    ? Number(row.price) : (DEFAULT_VPN_PRICE[role] ?? DEFAULT_VPN_PRICE.member);
  // Harga CF: pakai cf_price bila terisi; bila NULL/belum diset, fallback ke harga biasa.
  // (Number(null) = 0, jadi NULL harus dicek eksplisit, bukan via Number.isFinite saja.)
  if (viaCF && row && isNum(row.cf_price)) return Number(row.cf_price);
  return biasa;
}

async function setVpnPrice(productKey, role, price, viaCF = false) {
  if (!VPN_PRODUCTS.some((p) => p.key === productKey)) {
    throw new Error('Produk tidak dikenal: ' + productKey);
  }
  if (!['member', 'reseller'].includes(role)) {
    throw new Error('Harga hanya bisa diatur untuk role member/reseller (admin = 0)');
  }
  price = Math.round(Number(price));
  if (!Number.isFinite(price) || price < 0) throw new Error('Harga tidak valid (angka ≥ 0)');
  // Pastikan baris ada (harga biasa = default bila baru), lalu ubah HANYA kolom yang dipilih,
  // supaya harga Biasa dan CF tidak saling menimpa.
  await run(
    'INSERT OR IGNORE INTO vpn_prices (product_key, role, price) VALUES (?,?,?)',
    [productKey, role, DEFAULT_VPN_PRICE[role] ?? DEFAULT_VPN_PRICE.member]
  ).catch(() => {});
  const col = viaCF ? 'cf_price' : 'price';
  await run(
    `UPDATE vpn_prices SET ${col} = ? WHERE product_key = ? AND role = ?`,
    [price, productKey, role]
  );
  return price;
}

async function listVpnPrices() {
  return all('SELECT product_key, role, price, cf_price FROM vpn_prices ORDER BY product_key, role')
    .catch(() => all('SELECT product_key, role, price FROM vpn_prices ORDER BY product_key, role'));
}


// ---------- Jumlah akun per layanan (hanya angka, tanpa data akun) ----------
// Definisi sama dengan CLI cek-akun: SSH = username unik di .ssh.db yang masih
// ada sebagai user sistem (UID>=1000); Xray = username/email client unik per
// protokol (WS dan gRPC digabung per nama); entri template tanpa nama tidak dihitung.
// config.json Xray bukan JSON murni (baris marker #...), jadi marker dibuang dulu.
async function countAccounts(srv = null) {
  // FASE 2: hitung dari server terpilih via API (/countaccounts), bukan
  // file lokal host bot (salah di multi-server). Fallback baca lokal
  // hanya bila srv null (bot jalan di host server utama); server jauh
  // yang API-nya gagal = nol, bukan angka lokal yang menyesatkan.
  try {
    const { data } = await apiFor(srv).get('/countaccounts', { params: apiParamsFor(srv, {}) });
    if (data?.status === 'success' && data?.counts) {
      const c = data.counts;
      return { ssh: c.ssh || 0, vmess: c.vmess || 0, vless: c.vless || 0, trojan: c.trojan || 0, shadowsocks: c.shadowsocks || 0, total: c.total || 0 };
    }
  } catch (_) {}
  if (srv && srv.id) return { ssh: 0, vmess: 0, vless: 0, trojan: 0, shadowsocks: 0, total: 0 };
  const fs = require("fs");
  const counts = { ssh: 0, vmess: 0, vless: 0, trojan: 0, shadowsocks: 0, total: 0 };
  try {
    const sys = new Set();
    try {
      for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
        const p = line.split(":");
        if (p.length >= 3 && p[0] !== "nobody") {
          const uid = parseInt(p[2], 10);
          if (!isNaN(uid) && uid >= 1000) sys.add(p[0]);
        }
      }
    } catch {}
    try {
      const names = new Set();
      for (const raw of fs.readFileSync("/etc/ssh/.ssh.db", "utf8").split("\n")) {
        const t = raw.trim();
        if (t.startsWith("###") || t.startsWith("#ssh#")) {
          const parts = t.split(/\s+/);
          if (parts.length >= 2 && sys.has(parts[1])) names.add(parts[1]);
        }
      }
      counts.ssh = names.size;
    } catch {}
    try {
      const lines = fs.readFileSync("/etc/xray/config.json", "utf8").split("\n");
      const sets = { vmess: new Set(), vless: new Set(), trojan: new Set(), shadowsocks: new Set() };
      try {
        const clean = lines.filter((l) => !l.trim().startsWith("#")).join("\n");
        const parsed = JSON.parse(clean);
        for (const ib of parsed.inbounds || []) {
          if (sets[ib.protocol]) {
            for (const cl of (ib.settings && ib.settings.clients) || []) {
              if (cl.email) sets[ib.protocol].add(cl.email);
            }
          }
        }
      } catch {}
      const protoRe = /"protocol"\s*:\s*"(vmess|vless|trojan|shadowsocks)"/;
      const markerRe = /^\s*#{1,3}[!&]*\s+(\S+)\s+\d{4}-\d{2}-\d{2}/;
      let proto = null;
      for (const line of lines) {
        const m = protoRe.exec(line);
        if (m) { proto = m[1]; continue; }
        if (!proto) continue;
        const mm = markerRe.exec(line);
        if (mm) sets[proto].add(mm[1]);
      }
      for (const p of Object.keys(sets)) counts[p] = sets[p].size;
    } catch {}
  } catch {}
  counts.total = counts.ssh + counts.vmess + counts.vless + counts.trojan + counts.shadowsocks;
  return counts;
}

module.exports = {
  countAccounts,
  createSSH, cfSSHInfo, createVMess, createVLess, createTrojan, createShadowsocks, createZivpn, fancyBox, buildXrayLinks, buildClash, buildV2ray, attachSave, deleteSaveFile,
  renewAccount, deleteAccount, saveAccount, myAccounts, validUser, expiryDate,
  canClaimTrial, recordTrialClaim, sweepExpiredTrials, trialExpiresAtISO, getServer, listBuyServers, dispDomain,
  VPN_PRODUCTS, DEFAULT_VPN_PRICE, seedVpnPrices, getVpnPrice, setVpnPrice, listVpnPrices,
};
