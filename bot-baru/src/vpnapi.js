// Client vpn-api 5890 (gaya BotVPN2 GET, auth via query param).
// Format akun dibuat MENIRU STRUKTUR contoh bot lain yang dikirim user
// (screenshot VMess): box ACCOUNT INFO, SERVER, URL TLS / HTTP / GRPC,
// SAVE ACCOUNT, ACCOUNT BERHASIL DIBUAT — tapi dengan DATA SERVER
// SENDIRI (vpn.outletku.ai.id), bukan domain/Cloudfront/kuota/IP-limit
// contoh itu. Yang TIDAK diklaim karena tidak ada di server ini:
// Cloudfront (tidak dipakai), Kuota 300 GB (Xray di sini tidak
// membatasi kuota), IP Limit 2 (vpn-api Xray tidak mengirim iplimit,
// hanya SSH yang iplimit 1). Mengklaim angka itu = angka palsu.
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');

const validUser = (u) => /^[a-zA-Z0-9]{3,20}$/.test(u || '');
function expiryDate(days) { const d = new Date(); d.setDate(d.getDate() + Number(days)); return d.toISOString().slice(0, 10); }
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtExpiry(iso) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]}, ${d.getFullYear()}`;
}

async function apiGet(pathName, params) {
  const url = new URL(config.vpn.apiBase + pathName);
  url.searchParams.set('auth', config.vpn.apiAuth);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(65000) });
  return res.json();
}
function gate() {
  if (!config.vpnCreateEnabled) return { success: false, message: '❌ Create VPN nonaktif: VPN_DOMAIN / VPN_API_AUTH belum diisi di .env. Hubungi admin.' };
  return null;
}

const PROTO_INFO = {
  vmess: { label: 'VMESS', path: '/vmess', grpc: 'vmess-grpc', security: 'Auto' },
  vless: { label: 'VLESS', path: '/vless', grpc: 'vless-grpc', security: 'TLS' },
  trojan: { label: 'TROJAN', path: '/trojan', grpc: 'trojan-grpc', security: 'TLS' },
  shadowsocks: { label: 'SHADOWSOCKS', path: '/ss-ws', grpc: 'ss-grpc', security: 'TLS' },
};

function buildLinks(proto, username, uuid, password, host) {
  const info = PROTO_INFO[proto];
  if (!info) return null;
  if (proto === 'vmess') {
    const base = { v: '2', ps: username, add: host, id: uuid, aid: '0', scy: 'auto', type: 'none', host };
    const tls = { ...base, port: '443', net: 'ws', path: info.path, tls: 'tls', sni: host };
    const http = { ...base, port: '80', net: 'ws', path: info.path, tls: '' };
    const grpc = { ...base, port: '443', net: 'grpc', path: info.grpc, tls: 'tls', sni: host };
    return {
      tls: 'vmess://' + Buffer.from(JSON.stringify(tls)).toString('base64'),
      http: 'vmess://' + Buffer.from(JSON.stringify(http)).toString('base64'),
      grpc: 'vmess://' + Buffer.from(JSON.stringify(grpc)).toString('base64'),
    };
  }
  if (proto === 'vless') {
    return {
      tls: `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&path=%2F${info.path.slice(1)}&host=${host}#${username}`,
      http: `vless://${uuid}@${host}:80?encryption=none&security=none&type=ws&path=%2F${info.path.slice(1)}&host=${host}#${username}`,
      grpc: `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=grpc&serviceName=${info.grpc}#${username}`,
    };
  }
  if (proto === 'trojan') {
    return {
      tls: `trojan://${password}@${host}:443?security=tls&sni=${host}&type=ws&path=%2F${info.path.slice(1)}&host=${host}#${username}`,
      http: `trojan://${password}@${host}:80?security=none&type=ws&path=%2F${info.path.slice(1)}&host=${host}#${username}`,
      grpc: `trojan://${password}@${host}:443?security=tls&sni=${host}&type=grpc&serviceName=${info.grpc}#${username}`,
    };
  }
  if (proto === 'shadowsocks') {
    const userinfo = Buffer.from(`aes-128-gcm:${password}`).toString('base64');
    const tlsPlugin = encodeURIComponent(`v2ray-plugin;tls;host=${host};path=${info.path}`);
    const httpPlugin = encodeURIComponent(`v2ray-plugin;host=${host};path=${info.path}`);
    const grpcPlugin = encodeURIComponent(`v2ray-plugin;tls;mode=grpc;serviceName=${info.grpc};host=${host}`);
    return {
      tls: `ss://${userinfo}@${host}:443?plugin=${tlsPlugin}#${username}`,
      http: `ss://${userinfo}@${host}:80?plugin=${httpPlugin}#${username}`,
      grpc: `ss://${userinfo}@${host}:443?plugin=${grpcPlugin}#${username}`,
    };
  }
  return null;
}

function buildClash(proto, username, uuid, password, host, links) {
  const info = PROTO_INFO[proto];
  if (!info) return null;
  const lines = [`# Clash config — ${username} (${proto}) — server ${host}`, 'proxies:'];
  if (proto === 'vmess') {
    lines.push(`  - {name: ${username}-TLS, type: vmess, server: ${host}, port: 443, uuid: ${uuid}, alterId: 0, cipher: auto, udp: true, tls: true, skip-cert-verify: true, servername: ${host}, network: ws, ws-opts: {path: ${info.path}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-HTTP, type: vmess, server: ${host}, port: 80, uuid: ${uuid}, alterId: 0, cipher: auto, udp: true, tls: false, servername: ${host}, network: ws, ws-opts: {path: ${info.path}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-GRPC, type: vmess, server: ${host}, port: 443, uuid: ${uuid}, alterId: 0, cipher: auto, udp: true, tls: true, skip-cert-verify: true, servername: ${host}, network: grpc, grpc-opts: {grpc-service-name: ${info.grpc}}}`);
  } else if (proto === 'vless') {
    lines.push(`  - {name: ${username}-TLS, type: vless, server: ${host}, port: 443, uuid: ${uuid}, udp: true, tls: true, skip-cert-verify: true, servername: ${host}, network: ws, ws-opts: {path: ${info.path}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-HTTP, type: vless, server: ${host}, port: 80, uuid: ${uuid}, udp: true, tls: false, network: ws, ws-opts: {path: ${info.path}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-GRPC, type: vless, server: ${host}, port: 443, uuid: ${uuid}, udp: true, tls: true, skip-cert-verify: true, servername: ${host}, network: grpc, grpc-opts: {grpc-service-name: ${info.grpc}}}`);
  } else if (proto === 'trojan') {
    lines.push(`  - {name: ${username}-TLS, type: trojan, server: ${host}, port: 443, password: ${password}, udp: true, tls: true, skip-cert-verify: true, sni: ${host}, network: ws, ws-opts: {path: ${info.path}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-HTTP, type: trojan, server: ${host}, port: 80, password: ${password}, udp: true, tls: false, network: ws, ws-opts: {path: ${info.path}, headers: {Host: ${host}}}}`);
    lines.push(`  - {name: ${username}-GRPC, type: trojan, server: ${host}, port: 443, password: ${password}, udp: true, tls: true, skip-cert-verify: true, sni: ${host}, network: grpc, grpc-opts: {grpc-service-name: ${info.grpc}}}`);
  } else if (proto === 'shadowsocks') {
    lines.push(`  - {name: ${username}-TLS, type: ss, server: ${host}, port: 443, cipher: aes-128-gcm, password: ${password}, udp: true, plugin: v2ray-plugin, plugin-opts: {mode: websocket, tls: true, host: ${host}, path: ${info.path}}}`);
    lines.push(`  - {name: ${username}-HTTP, type: ss, server: ${host}, port: 80, cipher: aes-128-gcm, password: ${password}, udp: true, plugin: v2ray-plugin, plugin-opts: {mode: websocket, tls: false, host: ${host}, path: ${info.path}}}`);
  }
  lines.push('', '# Link (salin dari pesan akun, bukan dari file ini):');
  if (links) lines.push(`# TLS: ${links.tls}`, `# HTTP: ${links.http}`, `# GRPC: ${links.grpc}`);
  return lines.join('\n') + '\n';
}

function buildV2ray(proto, username, uuid, password, host) {
  const info = PROTO_INFO[proto];
  if (!info) return null;
  let outbound;
  if (proto === 'vmess') {
    outbound = { protocol: 'vmess', settings: { vnext: [{ address: host, port: 443, users: [{ id: uuid, alterId: 0, security: 'auto' }] }] }, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: host }, wsSettings: { path: info.path, headers: { Host: host } } }, tag: 'proxy' };
  } else if (proto === 'vless') {
    outbound = { protocol: 'vless', settings: { vnext: [{ address: host, port: 443, users: [{ id: uuid, encryption: 'none', flow: '' }] }] }, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: host }, wsSettings: { path: info.path, headers: { Host: host } } }, tag: 'proxy' };
  } else if (proto === 'trojan') {
    outbound = { protocol: 'trojan', settings: { servers: [{ address: host, port: 443, password, email: username }] }, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: host }, wsSettings: { path: info.path, headers: { Host: host } } }, tag: 'proxy' };
  } else if (proto === 'shadowsocks') {
    outbound = { protocol: 'shadowsocks', settings: { servers: [{ address: host, port: 443, method: 'aes-128-gcm', password, email: username, ota: false }] }, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: host }, wsSettings: { path: info.path, headers: { Host: host } } }, tag: 'proxy' };
  } else return null;
  return JSON.stringify({ log: { loglevel: 'warning' }, inbounds: [{ port: 1080, protocol: 'socks', settings: { auth: 'noauth', udp: true } }], outbounds: [outbound, { protocol: 'freedom', tag: 'direct' }] }, null, 2) + '\n';
}

function buildTxt(proto, username, uuid, password, host, expFormatted, links) {
  const info = PROTO_INFO[proto] || { label: proto.toUpperCase(), path: '', grpc: '', security: '' };
  const secretLine = proto === 'vmess' || proto === 'vless' ? `UUID: ${uuid}` : `Password: ${password}`;
  let t = `======================\n${info.label} ACCOUNT — ${username}\n======================\n\nACCOUNT INFO\nUsername: ${username}\n${secretLine}\nExpired: ${expFormatted}\nStatus: ACTIVE\n\nSERVER\nDomain: ${host}\nTLS Port: 443\nHTTP Port: 80\nSecurity: ${info.security}\nPath: ${info.path}\nGRPC Path: ${info.grpc}\n\n`;
  if (links) t += `URL TLS\n${links.tls}\n\nURL HTTP\n${links.http}\n\nURL GRPC\n${links.grpc}\n`;
  return t;
}

// P0: file akun TIDAK LAGI disimpan ke /var/www/html (publik via :81).
// Kredensial lengkap hanya ada di pesan Telegram pribadi user.
function saveAccountFile(proto, username, txt) {
  return null;
}

function formatXrayMessage(proto, username, uuid, password, host, exp, expFormatted, links, saveUrl) {
  const info = PROTO_INFO[proto];
  const secretLine = proto === 'vmess' || proto === 'vless'
    ? `🆔 UUID      : <code>${esc(uuid)}</code>`
    : `🔑 Password  : <code>${esc(password)}</code>`;
  let m = `🚀 <b>${info.label} ACCOUNT</b>\n─────────────────────\n\n📄 <b>ACCOUNT INFO</b>\n👤 USERNAME : <code>${esc(username)}</code>\n${secretLine}\n📅 EXPIRED  : ${esc(expFormatted)}\n🟢 STATUS   : ACTIVE\n\n🌐 <b>SERVER</b>\n🌐 DOMAIN   : <code>${esc(host)}</code>\n🔒 TLS PORT : 443\n🌐 HTTP PORT: 80\n🔐 SECURITY : ${esc(info.security)}\n🛣️ PATH     : <code>${esc(info.path)}</code>\n🚀 GRPC PATH: <code>${esc(info.grpc)}</code>\n\n🔗 <b>URL TLS</b>\n<pre>${esc(links.tls)}</pre>\n\n🔗 <b>URL HTTP</b>\n<pre>${esc(links.http)}</pre>\n\n🔗 <b>URL GRPC</b>\n<pre>${esc(links.grpc)}</pre>\n`;
  if (saveUrl) {
    m += `\n💾 <b>SAVE ACCOUNT</b>\n${esc(saveUrl)}\n<i>Link ini publik — siapa pun yang punya link bisa melihat akun ini.</i>\n`;
  }
  m += `\n🎉 <b>ACCOUNT BERHASIL DIBUAT</b>\n\n🤝 <b>TERIMA KASIH</b>\nSELAMAT MENGGUNAKAN LAYANAN KAMI. ❤️`;
  return m;
}

async function createSSH(username, days) {
  const g = gate(); if (g) return g;
  if (!validUser(username)) return { success: false, message: '❌ Username 3-20 karakter, huruf/angka saja.' };
  const password = crypto.randomUUID().slice(0, 12);
  const data = await apiGet('/createshh', { user: username, password, exp: days, iplimit: 1 }).catch((e) => ({ status: 'error', message: e.message }));
  if (data?.status !== 'success') return { success: false, message: `❌ Gagal membuat SSH: ${esc(data?.message || 'API error')}` };
  const host = config.vpn.domain, exp = expiryDate(days), expFormatted = fmtExpiry(exp);
  const txt = `SSH ACCOUNT — ${username}\nUsername: ${username}\nPassword: ${password}\nExpired: ${expFormatted}\nStatus: ACTIVE\n\nHost: ${host}\nPort SSH: 22\nPort WS: 80, 443\nPath WS: /\nIP Limit: 1 (dari vpn-api)\n`;
  const saveUrl = saveAccountFile('ssh', username, txt);
  const message = `🚀 <b>SSH ACCOUNT</b>\n─────────────────────\n\n📄 <b>ACCOUNT INFO</b>\n👤 USERNAME : <code>${esc(username)}</code>\n🔑 Password  : <code>${esc(password)}</code>\n📅 EXPIRED  : ${esc(expFormatted)}\n🟢 STATUS   : ACTIVE\n\n🌐 <b>SERVER</b>\n🌐 DOMAIN   : <code>${esc(host)}</code>\n🔒 PORT     : 22 (SSH langsung), 80 (WS), 443 (WS + TLS + SSH SSL)\n🛣️ PATH     : <code>/</code>\n\n${saveUrl ? `💾 <b>SAVE ACCOUNT</b>\n${esc(saveUrl)}\n<i>Link ini publik — siapa pun yang punya link bisa melihat akun ini.</i>\n\n` : ''}🎉 <b>ACCOUNT BERHASIL DIBUAT</b>\n\n🤝 <b>TERIMA KASIH</b>\nSELAMAT MENGGUNAKAN LAYANAN KAMI. ❤️`;
  return { success: true, expiry: exp, expiryFormatted: expFormatted, password, txt, saveUrl, message };
}

async function createXray(proto, username, days) {
  const g = gate(); if (g) return g;
  if (!validUser(username)) return { success: false, message: '❌ Username 3-20 karakter, huruf/angka saja.' };
  const host = config.vpn.domain, exp = expiryDate(days), expFormatted = fmtExpiry(exp);
  const uuid = crypto.randomUUID(), password = crypto.randomUUID();
  let data;
  if (proto === 'vmess') {
    data = await apiGet('/createvmess', { user: username, uuid, exp: days }).catch((e) => ({ status: 'error', message: e.message }));
    if (data?.status !== 'success') return { success: false, message: `❌ Gagal membuat VMess: ${esc(data?.message || 'API error')}` };
  } else if (proto === 'vless') {
    data = await apiGet('/createvless', { user: username, uuid, exp: days }).catch((e) => ({ status: 'error', message: e.message }));
    if (data?.status !== 'success') return { success: false, message: `❌ Gagal membuat VLess: ${esc(data?.message || 'API error')}` };
  } else if (proto === 'trojan') {
    data = await apiGet('/createtrojan', { user: username, password, exp: days }).catch((e) => ({ status: 'error', message: e.message }));
    if (data?.status !== 'success') return { success: false, message: `❌ Gagal membuat Trojan: ${esc(data?.message || 'API error')}` };
  } else if (proto === 'shadowsocks') {
    data = await apiGet('/createss', { user: username, password, exp: days }).catch((e) => ({ status: 'error', message: e.message }));
    if (data?.status !== 'success') return { success: false, message: `❌ Gagal membuat Shadowsocks: ${esc(data?.message || 'API error')}` };
  } else return { success: false, message: '❌ Protokol tidak dikenal.' };
  const links = buildLinks(proto, username, uuid, password, host);
  const clash = buildClash(proto, username, uuid, password, host, links);
  const v2ray = buildV2ray(proto, username, uuid, password, host);
  const txt = buildTxt(proto, username, uuid, password, host, expFormatted, links);
  const saveUrl = saveAccountFile(proto, username, txt);
  const message = formatXrayMessage(proto, username, uuid, password, host, exp, expFormatted, links, saveUrl);
  return { success: true, expiry: exp, expiryFormatted: expFormatted, uuid, password, links, link: links.tls, clash, v2ray, txt, saveUrl, message };
}
async function createAccount(proto, username, days) {
  return proto === 'ssh' ? createSSH(username, days) : createXray(proto, username, days);
}
async function renewAccount(proto, username, days) {
  const g = gate(); if (g) return g;
  const data = await apiGet('/renew', { proto, user: username, exp: days }).catch((e) => ({ status: 'error', message: e.message }));
  if (data?.status !== 'success') return { success: false, message: `❌ Gagal renew: ${esc(data?.message || 'API error')}` };
  return { success: true, message: `✅ <b>${esc(username)}</b> (${proto}) diperpanjang ${days} hari.` };
}
async function deleteAccount(proto, username) {
  const g = gate(); if (g) return g;
  const data = await apiGet('/delete', { proto, user: username }).catch((e) => ({ status: 'error', message: e.message }));
  if (data?.status !== 'success') return { success: false, message: `❌ Gagal hapus: ${esc(data?.message || 'API error')}` };
  return { success: true, message: `🗑️ Akun <b>${esc(username)}</b> (${proto}) dihapus.` };
}
module.exports = { validUser, expiryDate, esc, fmtExpiry, createAccount, createSSH, createXray, renewAccount, deleteAccount, apiGet, buildLinks, buildClash, buildV2ray, buildTxt, saveAccountFile, PROTO_INFO };
