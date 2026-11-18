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
pasang_node_pm2() {
  local need_node=0 major=""
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
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg || { echo "ERROR: gagal mengunduh kunci NodeSource." >&2; exit 1; }
    fi
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt-get install -y nodejs
  fi
  echo "Node: $(node -v)"
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
while true; do
  read -r -s -p "BOT_TOKEN Telegram (dari BotFather): " BOT_TOKEN || true
  echo ""
  [ -n "$BOT_TOKEN" ] || { echo "BOT_TOKEN wajib diisi."; continue; }
  if [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then break; fi
  echo "Format BOT_TOKEN salah (angka:token)."
done
while true; do
  read -r -p "ADMIN_ID Telegram (angka saja): " ADMIN_ID || true
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
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "=== INSTALL BOT BERHASIL SELESAI ==="
echo "Bot Telegram jalan di PM2 dengan nama: darren-bot"
echo "Cek status: pm2 status darren-bot"
echo "Kelola dari menu: menu -> 9 (MENU BOTELE) -> m-bot"
