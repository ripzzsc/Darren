#!/usr/bin/env bash
# DARREN_INSTALL_BOT=1
# Installer Bot Telegram Darren (bot-js) — dipanggil dari menu, BUKAN saat install awal.
# Dipakai lewat: menu (9) -> m-bot -> Install Bot, atau jalankan langsung: install-botjs
# Sumber bot: /root/darren-install/v4-main/bot-js bila ada dan lengkap,
# bila tidak ada, clone --depth 1 repo Darren ke /tmp lalu pakai itu.
# Satu nama PM2 di semua tempat: darren-bot.
# Keamanan .env: nilai TIDAK ditulis lewat heredoc tanpa quote (temuan K-08).
# .env ditulis dengan printf '%s=%s\n' per baris, jadi nilai berisi $(), backtick,
# spasi, atau karakter khusus lain tidak dieksekusi.
# VPN_API_AUTH: dibaca dari /etc/vpn-api/auth.env bila ada dan dipakai ulang.
# JANGAN generate baru bila auth.env sudah ada — auth baru membuat API
# (fail-closed) menolak bot. Bila auth.env belum ada, generate baru,
# tulis ke /etc/vpn-api/auth.env (600), dan restart vpn-api bila servicenya ada.
set -euo pipefail

REPO_URL="https://github.com/ripzzsc/Darren.git"
BOT_DIR="/root/bot-js"
SRC_BOT=""
TMP_SRC=""
VPN_API_AUTH=""
VPN_API_BASE="http://127.0.0.1:5890"

trap 'rm -rf "${TMP_SRC:-}"' EXIT
trap 'echo "=== INSTALL BOT GAGAL (perbaiki pesan error di atas lalu jalankan ulang) ===" >&2' ERR

if [ "$(id -u)" != "0" ]; then
  echo "Jalankan installer bot ini sebagai root." >&2
  exit 1
fi

# ---------- Node.js >= 18 + PM2 ----------
# I-19: fallback sama seperti install.sh — kunci NodeSource gagal bukan
# berarti install gagal: warning + fallback ke Node.js Ubuntu, dan npm
# dipastikan ada (Node Ubuntu 18 tidak menyertakan npm).
pasang_node_pm2() {
  local need_node=0 major="" nodesource_ok=0
  # Hash command bash bisa basi bila uninstall/reinstall sebelumnya
  # menghapus binary (node/npm) yang masih tersimpan di hash.
  hash -r
  if ! command -v node >/dev/null 2>&1; then
    need_node=1
  else
    major="$(node -v | sed 's/^v//; s/\..*//')"
    if [ "${major:-0}" -lt 18 ]; then need_node=1; fi
  fi
  if [ "$need_node" = "1" ]; then
    echo "Menginstal Node.js 20 dari repo apt resmi NodeSource..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    mkdir -p /etc/apt/keyrings
    if [ ! -s /etc/apt/keyrings/nodesource.gpg ]; then
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg || {
        echo "PERINGATAN: gagal mengunduh kunci NodeSource, fallback ke Node.js Ubuntu." >&2
      }
    fi
    if [ -s /etc/apt/keyrings/nodesource.gpg ]; then
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
      if apt-get update -y && apt-get install -y nodejs; then
        # apt-get update TIDAK gagal bila repo hanya gagal di-fetch;
        # pastikan Node 20 (NodeSource) yang terpasang, bukan Node 18 Ubuntu.
        _nv="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
        if [ "${_nv:-0}" -ge 20 ]; then
          nodesource_ok=1
        fi
      fi
      if [ "$nodesource_ok" != "1" ]; then
        echo "PERINGATAN: repo NodeSource gagal/tidak menyediakan Node 20, fallback ke Node.js Ubuntu." >&2
        rm -f /etc/apt/sources.list.d/nodesource.list
        apt-get update -y
      fi
    fi
    if [ "$nodesource_ok" != "1" ]; then
      echo "Menginstal Node.js + npm dari repo Ubuntu..."
      apt-get install -y nodejs npm
    fi
  fi
  # Node Ubuntu (18) tidak menyertakan npm; pastikan npm ada sebelum pm2.
  hash -r
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm belum ada, menginstal paket npm dari Ubuntu..."
    apt-get update -y && apt-get install -y npm
  fi
  hash -r
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: node/npm tidak tersedia setelah semua percobaan." >&2
    exit 1
  fi
  echo "Node: $(node -v) / npm: $(npm -v)"
  npm install -g pm2
}
pasang_node_pm2

# ---------- Cari source bot-js ----------
if [ -f /root/darren-install/v4-main/bot-js/app.js ]; then
  SRC_BOT="/root/darren-install/v4-main/bot-js"
  echo "Memakai source bot lokal di $SRC_BOT"
else
  echo "Source bot lokal tidak ditemukan — meng-clone repo Darren..."
  TMP_SRC="/tmp/darren-bot-src-$$"
  rm -rf "$TMP_SRC"
  git clone --depth 1 "$REPO_URL" "$TMP_SRC" || { echo "ERROR: Clone repo gagal." >&2; exit 1; }
  if [ ! -f "$TMP_SRC/v4-main/bot-js/app.js" ]; then
    echo "ERROR: Source bot tidak lengkap di repo yang di-clone." >&2
    exit 1
  fi
  SRC_BOT="$TMP_SRC/v4-main/bot-js"
fi
node --check "$SRC_BOT/app.js"

# ---------- Prompt konfigurasi bot ----------
# Nilai .env lama (bila ada) dipakai sebagai default untuk field opsional.
OLD_ENV=""
[ -f "$BOT_DIR/.env" ] && OLD_ENV="$BOT_DIR/.env"
old_val() {
  local key="$1"
  [ -n "$OLD_ENV" ] && grep "^${key}=" "$OLD_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true
}

echo ""
echo "Isi konfigurasi bot. Kosongkan yang opsional bila belum ada."
# I-09: loop prompt wajib berhenti bila stdin EOF (Ctrl-D / pipe kosong /
# non-interaktif) — read yang gagal karena EOF langsung batal, bukan
# mengulang selamanya. Batas 3 percobaan untuk input yang salah.
_bot_attempts=0
while true; do
  _bot_attempts=$((_bot_attempts + 1))
  if [ "$_bot_attempts" -gt 3 ]; then
    echo "ERROR: BOT_TOKEN gagal diisi 3x — dibatalkan." >&2
    exit 1
  fi
  if ! read -r -s -p "BOT_TOKEN Telegram (dari BotFather): " BOT_TOKEN; then
    echo ""
    echo "ERROR: input dibatalkan (stdin EOF) — BOT_TOKEN wajib diisi." >&2
    exit 1
  fi
  echo ""
  [ -n "$BOT_TOKEN" ] || { echo "BOT_TOKEN wajib diisi."; continue; }
  if [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then break; fi
  echo "Format BOT_TOKEN salah (angka:token)."
done
_admin_attempts=0
while true; do
  _admin_attempts=$((_admin_attempts + 1))
  if [ "$_admin_attempts" -gt 3 ]; then
    echo "ERROR: ADMIN_ID gagal diisi 3x — dibatalkan." >&2
    exit 1
  fi
  if ! read -r -p "ADMIN_ID Telegram (angka saja): " ADMIN_ID; then
    echo "ERROR: input dibatalkan (stdin EOF) — ADMIN_ID wajib diisi." >&2
    exit 1
  fi
  [[ "$ADMIN_ID" =~ ^[0-9]+$ ]] && break
  echo "ADMIN_ID harus angka."
done
read -r -p "H2H Gateway URL (kosong = default): " H2H_URL || true
[ -z "$H2H_URL" ] && H2H_URL="$(old_val H2H_URL)"
read -r -s -p "H2H API key operator (opsional): " H2H_KEY || true
echo ""
[ -z "$H2H_KEY" ] && H2H_KEY="$(old_val H2H_KEY)"
read -r -p "Digiflazz username (opsional): " DIGI_USER || true
[ -z "$DIGI_USER" ] && DIGI_USER="$(old_val DIGI_USER)"
if [ -n "$DIGI_USER" ]; then
  read -r -s -p "Digiflazz API key: " DIGI_KEY || true
  echo ""
  [ -z "$DIGI_KEY" ] && DIGI_KEY="$(old_val DIGI_KEY)"
else
  DIGI_KEY=""
fi
read -r -s -p "SIDOMPUL_API_KEY (opsional): " SIDOMPUL_API_KEY || true
echo ""
[ -z "$SIDOMPUL_API_KEY" ] && SIDOMPUL_API_KEY="$(old_val SIDOMPUL_API_KEY)"
read -r -s -p "HC_API_KEY (opsional): " HC_API_KEY || true
echo ""
[ -z "$HC_API_KEY" ] && HC_API_KEY="$(old_val HC_API_KEY)"
read -r -p "CloudFront domain (CF_DOMAIN, opsional): " CF_DOMAIN || true
[ -z "$CF_DOMAIN" ] && CF_DOMAIN="$(old_val CF_DOMAIN)"
if [ -n "$CF_DOMAIN" ]; then
  read -r -s -p "CloudFront VMess UUID: " CF_VMESS_UUID || true
  echo ""
  [ -z "$CF_VMESS_UUID" ] && CF_VMESS_UUID="$(old_val CF_VMESS_UUID)"
  read -r -s -p "CloudFront VLESS UUID: " CF_VLESS_UUID || true
  echo ""
  [ -z "$CF_VLESS_UUID" ] && CF_VLESS_UUID="$(old_val CF_VLESS_UUID)"
  read -r -s -p "CloudFront Trojan password: " CF_TROJAN_PASSWORD || true
  echo ""
  [ -z "$CF_TROJAN_PASSWORD" ] && CF_TROJAN_PASSWORD="$(old_val CF_TROJAN_PASSWORD)"
else
  CF_VMESS_UUID=""; CF_VLESS_UUID=""; CF_TROJAN_PASSWORD=""
fi
# Registry IP sewa (opsional, seperti di install.sh)
read -r -s -p "Token lisensi IP sewa (GH_IP_TOKEN, opsional): " GH_IP_TOKEN || true
echo ""
[ -z "$GH_IP_TOKEN" ] && GH_IP_TOKEN="$(old_val GH_IP_TOKEN)"
if [ -n "$GH_IP_TOKEN" ]; then
  read -r -p "Registry IP owner (GH_IP_OWNER): " GH_IP_OWNER || true
  [ -z "$GH_IP_OWNER" ] && GH_IP_OWNER="$(old_val GH_IP_OWNER)"
  read -r -p "Registry IP repo (GH_IP_REPO): " GH_IP_REPO || true
  [ -z "$GH_IP_REPO" ] && GH_IP_REPO="$(old_val GH_IP_REPO)"
  read -r -p "Registry IP file (GH_IP_FILE): " GH_IP_FILE || true
  [ -z "$GH_IP_FILE" ] && GH_IP_FILE="$(old_val GH_IP_FILE)"
else
  GH_IP_OWNER=""; GH_IP_REPO=""; GH_IP_FILE=""
fi

# ---------- Backup bot lama, salin bot baru ----------
STEP_BAK=""
if [ -d "$BOT_DIR" ]; then
  STEP_BAK="/root/bot-js.bak-$(date +%Y%m%d-%H%M%S)"
  cp -a "$BOT_DIR" "$STEP_BAK" || { echo "ERROR: backup bot lama gagal." >&2; exit 1; }
  chmod 700 "$STEP_BAK" 2>/dev/null || true
  echo "Bot lama dibackup ke $STEP_BAK"
  rm -rf "$BOT_DIR"
fi
cp -a "$SRC_BOT" "$BOT_DIR"

# I-16: VPN_API_AUTH dirotasi TERAKHIR, sesaat sebelum .env ditulis —
# bukan di awal. Bila user batal (Ctrl-C/EOF) saat prompt di atas, auth
# API tidak berubah dan bot lama tetap jalan.
# ---------- VPN_API_AUTH: pakai yang sudah ada, jangan generate baru ----------
if [ -f /etc/vpn-api/auth.env ]; then
  VPN_API_AUTH="$(grep '^VPN_API_AUTH=' /etc/vpn-api/auth.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
fi
if [ -z "$VPN_API_AUTH" ]; then
  echo "auth.env VPN API belum ada — membuat auth baru."
  VPN_API_AUTH="$(openssl rand -hex 24)" || { echo "ERROR: gagal mengacak VPN_API_AUTH." >&2; exit 1; }
  mkdir -p /etc/vpn-api
  printf '%s=%s\n' "VPN_API_AUTH" "$VPN_API_AUTH" > /etc/vpn-api/auth.env
  chmod 600 /etc/vpn-api/auth.env
  if systemctl list-unit-files vpn-api.service >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart vpn-api.service 2>/dev/null || echo "Peringatan: vpn-api.service tidak bisa di-restart — periksa manual dengan: systemctl status vpn-api.service"
  else
    echo "Peringatan: VPN API belum terinstal di VPS ini — bot tidak bisa membuat akun sampai VPN API terinstal (jalankan install.sh dulu)."
  fi
else
  echo "Memakai VPN_API_AUTH yang sudah ada di /etc/vpn-api/auth.env."
fi

# Tulis .env dengan printf (aman dari injeksi $()/backtick — lihat header).
write_bot_env() {
  {
    printf '%s=%s\n' "BOT_TOKEN" "$BOT_TOKEN"
    printf '%s=%s\n' "ADMIN_ID" "$ADMIN_ID"
    printf '%s=%s\n' "VPN_API_BASE" "$VPN_API_BASE"
    printf '%s=%s\n' "VPN_API_AUTH" "$VPN_API_AUTH"
    printf '%s=%s\n' "H2H_URL" "${H2H_URL:-https://payment-gateway.outletku.ai.id/api/h2h/v1}"
    printf '%s=%s\n' "H2H_KEY" "${H2H_KEY:-}"
    printf '%s=%s\n' "GH_IP_TOKEN" "${GH_IP_TOKEN:-}"
    printf '%s=%s\n' "GH_IP_OWNER" "${GH_IP_OWNER:-}"
    printf '%s=%s\n' "GH_IP_REPO" "${GH_IP_REPO:-}"
    printf '%s=%s\n' "GH_IP_FILE" "${GH_IP_FILE:-}"
    printf '%s=%s\n' "SIDOMPUL_API_KEY" "${SIDOMPUL_API_KEY:-}"
    printf '%s=%s\n' "HC_API_KEY" "${HC_API_KEY:-}"
    printf '%s=%s\n' "CF_DOMAIN" "${CF_DOMAIN:-}"
    printf '%s=%s\n' "CF_VMESS_UUID" "${CF_VMESS_UUID:-}"
    printf '%s=%s\n' "CF_VLESS_UUID" "${CF_VLESS_UUID:-}"
    printf '%s=%s\n' "CF_TROJAN_PASSWORD" "${CF_TROJAN_PASSWORD:-}"
    printf '%s=%s\n' "DIGI_USER" "${DIGI_USER:-}"
    printf '%s=%s\n' "DIGI_KEY" "${DIGI_KEY:-}"
  } > "$BOT_DIR/.env"
  chmod 600 "$BOT_DIR/.env"
}
write_bot_env

# Restore database bot lama bila ada
if [ -n "$STEP_BAK" ] && [ -f "$STEP_BAK/data/bot.db" ]; then
  mkdir -p "$BOT_DIR/data"
  cp -a "$STEP_BAK/data/bot.db" "$BOT_DIR/data/bot.db"
  chmod 600 "$BOT_DIR/data/bot.db"
  echo "Database bot lama (data/bot.db) berhasil dipulihkan."
fi

# Salin installer ini ke /usr/bin/install-botjs agar menu bisa memanggilnya lagi.
INSTALLER_SRC=""
if [ -f /root/darren-install/v4-main/install-bot.sh ]; then
  INSTALLER_SRC="/root/darren-install/v4-main/install-bot.sh"
elif [ -n "$TMP_SRC" ] && [ -f "$TMP_SRC/v4-main/install-bot.sh" ]; then
  INSTALLER_SRC="$TMP_SRC/v4-main/install-bot.sh"
fi
if [ -n "$INSTALLER_SRC" ]; then
  cp "$INSTALLER_SRC" /usr/bin/install-botjs 2>/dev/null || true
  chmod +x /usr/bin/install-botjs 2>/dev/null || true
fi

# ---------- npm install + PM2 (satu nama: darren-bot) ----------
cd "$BOT_DIR"
if [ -f "package.json" ]; then
  npm install --production || npm install
fi
pm2 delete darren-bot 2>/dev/null || true
pm2 start app.js --name "darren-bot"
# I-10: verifikasi bot benar-benar online — PM2 jalan, token valid (getMe),
# dan VPN API merespons. Gagal di salah satu = gagal, bukan "BERHASIL".
sleep 5
_BOT_PID="$(pm2 pid darren-bot 2>/dev/null || true)"
if [ -z "$_BOT_PID" ]; then
  echo "ERROR: bot tidak jalan (PM2: darren-bot tidak punya PID)." >&2
  pm2 show darren-bot || true
  exit 1
fi
if ! curl -fsSL --max-time 15 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" | grep -q '"ok":true'; then
  echo "ERROR: BOT_TOKEN ditolak Telegram (getMe gagal) — periksa tokennya." >&2
  exit 1
fi
if ! curl -fsSL --max-time 10 http://127.0.0.1:5890/health | grep -q success; then
  echo "ERROR: VPN API :5890 tidak merespons (health gagal)." >&2
  exit 1
fi
echo "Verifikasi bot OK: PM2 online (PID $_BOT_PID), token Telegram valid, VPN API :5890 sehat."
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "=== INSTALL BOT BERHASIL SELESAI ==="
echo "Bot Telegram jalan di PM2 dengan nama: darren-bot"
echo "Cek status: pm2 status darren-bot"
echo "Kelola dari menu: menu -> 9 (MENU BOTELE) -> m-bot"
