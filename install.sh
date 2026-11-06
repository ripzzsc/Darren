#!/usr/bin/env bash
# DARREN_INSTALLER_VERSION=fix-total-20261105-08
# Installer v4-main (versi perbaikan, LENGKAP) untuk VPS baru.
# Penanda versi yang bisa di-grep: DARREN_INSTALLER_VERSION di atas.
# Xray dipin ke SATU rilis resmi: lihat XRAY_TAG_PIN di bawah (bukan latest mengambang).
# Yang diinstal: bot-js (Telegram) + VPN API lokal (port 5890, localhost saja),
# Xray (wajib jalan; default YA), menu utama SSH (menu.zip -> /usr/bin), dan vnstat untuk traffic menu.
# Mode --remote: instalasi stack VPN TANPA bot Telegram (server remote yang
# didaftarkan ke bot utama). Cocok untuk "Install Server Baru" lewat bot:
# bot utama SSH ke VPS baru dan menjalankan installer ini dengan --remote.
# Uninstaller pasangannya: uninstall.sh (repo yang sama).
#
# Cara pakai di VPS baru (sebagai root):
#   curl -fsSL https://raw.githubusercontent.com/ripzzsc/Darren/main/install.sh -o install.sh
#   chmod +x install.sh
#   ./install.sh
#   ./install.sh --total   # install total: backup + hapus instalasi lama, lalu install baru
#   ./install.sh --remote  # server remote: stack VPN saja, tanpa bot Telegram
#                        # (non-interaktif; domain lewat env REMOTE_DOMAIN)
# Repo Darren saat ini PUBLIK, jadi unduhan di atas tidak butuh token.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DARREN_INSTALLER_VERSION="fix-total-20261105-08"
XRAY_TAG_PIN="v26.10.31"

trap 'echo "=== VERDICT: INSTALL GAGAL (perintah gagal; perbaiki pesan error di atas lalu jalankan ulang) ===" >&2' ERR

REPO_URL="https://github.com/ripzzsc/Darren.git"
SRC_DIR="/root/darren-install"
BOT_DIR="/root/bot-js"
API_FILE="/root/vpn-api.py"

if [ "$(id -u)" != "0" ]; then
  echo "Jalankan installer ini sebagai root." >&2
  exit 1
fi

# ---------- Argumen ----------
TOTAL=0
REMOTE=0
for arg in "$@"; do
  case "$arg" in
    --total) TOTAL=1 ;;
    --remote) REMOTE=1 ;;
    --help|-h)
      echo "Pakai: ./install.sh [--total] [--remote]"
      echo "  --total   Install total: backup lalu hapus semua instalasi SC lama,"
      echo "            termasuk Node/PM2/vnstat, baru install baru."
      echo "  --remote  Server remote: instal stack VPN saja TANPA bot Telegram."
      exit 0
      ;;
    *) echo "Argumen tidak dikenal: $arg (pakai --help)" >&2; exit 1 ;;
  esac
done

if [ "$TOTAL" = 1 ]; then
  script_path="$(readlink -f "$0")"
  case "$script_path" in
    "$SRC_DIR"/*)
      echo "Menjalankan ulang dari /tmp agar source lama bisa dihapus total..."
      cp "$script_path" /tmp/install-total-$$.sh
      exec bash /tmp/install-total-$$.sh --total
      ;;
  esac
fi

# ---------- Token GitHub ----------
if [ -z "${GH_TOKEN:-}" ]; then
  if [ "$REMOTE" = 1 ]; then
    TOKEN_SOURCE="environment"
  else
    read -r -s -p "Token GitHub baca repo Darren (kosongkan bila repo masih publik): " GH_TOKEN || true
    echo ""
    TOKEN_SOURCE="prompt"
  fi
else
  TOKEN_SOURCE="environment"
fi

git_clone_darren() {
  local dest="$1"
  if [ -n "${GH_TOKEN:-}" ]; then
    echo "Memvalidasi token GitHub (sumber: $TOKEN_SOURCE)..."
    if ! GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer $GH_TOKEN" ls-remote "$REPO_URL" >/dev/null 2>&1; then
      echo "ERROR: Token GitHub ditolak (401/403) atau repo tidak terjangkau." >&2
      exit 1
    fi
    GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer $GH_TOKEN" clone --depth 1 "$REPO_URL" "$dest"
  else
    GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$REPO_URL" "$dest" || { echo "ERROR: Clone repo gagal." >&2; exit 1; }
  fi
}

backup_item() {
  local src="$1" dest="$2" base
  [ -e "$src" ] || return 0
  cp -a "$src" "$dest/" || { echo "ERROR: backup $src gagal." >&2; exit 1; }
  base="$(basename "$src")"
  if [ ! -e "$dest/$base" ]; then
    echo "ERROR: verifikasi backup $src gagal." >&2; exit 1
  fi
}

lock_backup_perms() {
  local bak="$1"
  chmod 700 "$bak" 2>/dev/null || true
  find "$bak" -type f \( -name '.env' -o -name 'auth.env' -o -name 'izin-token' -o -name '*.key' -o -name '*.pem' \) -exec chmod 600 {} + 2>/dev/null || true
}

git_remote_head() {
  if [ -n "${GH_TOKEN:-}" ]; then
    GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer $GH_TOKEN" ls-remote "$REPO_URL" HEAD 2>/dev/null | awk '{print $1}'
  else
    GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO_URL" HEAD 2>/dev/null | awk '{print $1}'
  fi
}

hapus_instalasi_lama() {
  command -v unzip >/dev/null 2>&1 || apt-get install -y unzip 2>/dev/null || true
  if [ ! -f "$SRC_DIR/uninstall.sh" ]; then
    echo "ERROR: $SRC_DIR/uninstall.sh tidak ditemukan." >&2
    exit 1
  fi
  bash -n "$SRC_DIR/uninstall.sh" || { echo "ERROR: $SRC_DIR/uninstall.sh gagal cek sintaks." >&2; exit 1; }
  # shellcheck disable=SC1091
  source "$SRC_DIR/uninstall.sh"
  echo "Menghapus stack Darren lama..."
  hapus_stack_darren keep-src
}

siapkan_install_total() {
  local stamp backup tmp_src
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="/root/darren-reinstall-backup-$stamp"
  echo "Install total: membackup instalasi lama ke $backup ..."
  mkdir -p "$backup"
  chmod 700 "$backup"
  backup_item /root/bot-js "$backup"
  backup_item /etc/vpn-api "$backup"
  backup_item /etc/xray "$backup"
  backup_item /etc/systemd/system/xray.service.d "$backup"
  backup_item /etc/bot "$backup"
  backup_item /etc/haproxy "$backup"
  backup_item /root/vpn-api.py "$backup"
  backup_item /etc/nginx/conf.d/xray.conf "$backup"
  backup_item /usr/bin/speedtest "$backup"
  for _unit in vpn-api.service xray.service limitvmess.service limitvless.service limittrojan.service limitshadowsocks.service; do
    backup_item "/etc/systemd/system/$_unit" "$backup"
  done
  for _menu in menu cek-izin xray-restart; do
    backup_item "/usr/bin/$_menu" "$backup"
  done
  lock_backup_perms "$backup"
  
  echo "Mengambil source baru ..."
  tmp_src="/tmp/darren-fresh-$$"
  rm -rf "$tmp_src"
  git_clone_darren "$tmp_src" || { echo "Gagal clone source baru." >&2; exit 1; }
  if [ ! -f "$tmp_src/v4-main/bot-js/app.js" ]; then
    echo "Source baru tidak lengkap." >&2
    rm -rf "$tmp_src"
    exit 1
  fi
  rm -rf "$SRC_DIR"
  mv "$tmp_src" "$SRC_DIR"
  hapus_instalasi_lama
  pasang_node_pm2
}

echo "=== v4-main fixed installer ==="
echo ""

# ---------- 1. Dependensi sistem ----------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg unzip git python3 sqlite3 openssl haproxy nginx iproute2 at socat vnstat

# ---------- 2. Node.js >= 18 + PM2 ----------
pasang_node_pm2() {
  local need_node=0
  local major=""
  if ! command -v node >/dev/null 2>&1; then
    need_node=1
  else
    major="$(node -v | sed 's/^v//; s/\..*//')"
    if [ "${major:-0}" -lt 18 ]; then need_node=1; fi
  fi
  if [ "$need_node" = "1" ]; then
    echo "Menginstal Node.js 20 dari repo apt resmi NodeSource..."
    mkdir -p /etc/apt/keyrings
    if [ ! -s /etc/apt/keyrings/nodesource.gpg ]; then
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg || { echo "ERROR: gagal mengunduh kunci NodeSource." >&2; exit 1; }
    fi
    NODE_MAJOR=20
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt-get install -y nodejs
  fi
  echo "Node: $(node -v)"
  npm install -g pm2
}
pasang_node_pm2

# ---------- 3. Ambil source ----------
if [ -f "$SCRIPT_DIR/v4-main/bot-js/app.js" ]; then
  echo "Memakai source lokal di $SCRIPT_DIR/v4-main"
  if [ "$(readlink -f "$SCRIPT_DIR")" = "$(readlink -f "$SRC_DIR")" ]; then
    echo "Sudah di dalam $SRC_DIR, penyalinan dilewati."
  else
    mkdir -p "$SRC_DIR"
    rm -rf "$SRC_DIR/v4-main"
    cp -a "$SCRIPT_DIR/v4-main" "$SRC_DIR/v4-main"
  fi
elif [ -d "$SRC_DIR/v4-main/bot-js" ]; then
  echo "Source lama ditemukan di $SRC_DIR — verifikasi kesegaran..."
  _local_head=""; _remote_head=""
  if [ -d "$SRC_DIR/.git" ]; then
    _local_head="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo "")"
    _remote_head="$(git_remote_head)"
  fi
  if [ -z "$_local_head" ] || [ -z "$_remote_head" ] || [ "$_local_head" != "$_remote_head" ]; then
    echo "Clone ulang source segar..."
    rm -rf "$SRC_DIR"
    git_clone_darren "$SRC_DIR"
  else
    echo "Source lama segar — dipakai."
  fi
else
  echo "Meng-clone repo Darren..."
  rm -rf "$SRC_DIR"
  git_clone_darren "$SRC_DIR"
fi

# ---------- 4b. Izin install (allowlist GitHub) ----------
check_install_license() {
  local allow="$SRC_DIR/izin-install.txt"
  if [ ! -f "$allow" ]; then
    echo "ERROR: File izin install ($allow) tidak ditemukan di repo." >&2
    exit 1
  fi
  local my_ip=""
  my_ip="$(curl -fsSL --max-time 10 https://ifconfig.me 2>/dev/null | tr -d '[:space:]' || true)"
  if ! [[ "$my_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    my_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if ! [[ "$my_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: IP publik VPS ini tidak bisa ditentukan." >&2
    exit 1
  fi
  local today
  today="$(date +%F)"
  local found_name="" found_exp=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    local f_ip f_name f_exp
    f_ip="$(echo "$line" | cut -d'|' -f1 | tr -d '[:space:]')"
    f_name="$(echo "$line" | cut -d'|' -f2 | sed 's/^ *//;s/ *$//')"
    f_exp="$(echo "$line" | cut -d'|' -f3 | tr -d '[:space:]')"
    [ "$f_ip" = "$my_ip" ] || continue
    found_name="$f_name"; found_exp="$f_exp"
    break
  done < "$allow"
  if [ -z "$found_exp" ]; then
    echo "ERROR: IP VPS ini ($my_ip) TIDAK TERDAFTAR di izin-install.txt." >&2
    exit 1
  fi
  if [[ "$today" > "$found_exp" ]]; then
    echo "ERROR: Masa sewa untuk IP $my_ip sudah BERAKHIR pada $found_exp." >&2
    exit 1
  fi
  echo "Izin install OK: $my_ip — ${found_name:-tanpa nama} (berlaku s.d. $found_exp)."
}

if [ "$REMOTE" = 0 ]; then
  check_install_license
else
  echo "Mode remote: cek izin install dilewati."
fi

# ---------- 5. Prompt konfigurasi ----------
if [ "$REMOTE" = 1 ]; then
  VPN_DOMAIN="${REMOTE_DOMAIN:-}"
  BOT_TOKEN=""; ADMIN_ID=""; H2H_URL=""; H2H_KEY=""
  GH_IP_TOKEN=""; GH_IP_OWNER=""; GH_IP_REPO=""; GH_IP_FILE=""
  SIDOMPUL_API_KEY=""; HC_API_KEY=""
  CF_DOMAIN=""; CF_VMESS_UUID=""; CF_VLESS_UUID=""; CF_TROJAN_PASSWORD=""
  DIGI_USER=""; DIGI_KEY=""; install_xray="Y"
  if [ -z "${REMOTE_MAIN_IP:-}" ] || ! [[ "$REMOTE_MAIN_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: mode --remote wajib env REMOTE_MAIN_IP." >&2
    exit 1
  fi
else
  echo ""
  echo "Isi konfigurasi berikut. Kosongkan yang opsional bila belum ada."
  read -r -p "Domain VPS kamu (contoh: vpn.contoh.com, kosong = localhost saja): " VPN_DOMAIN || true
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
  read -r -s -p "H2H API key operator (opsional): " H2H_KEY || true
  echo ""
  read -r -s -p "Token lisensi IP sewa (GH_IP_TOKEN, opsional): " GH_IP_TOKEN || true
  echo ""
  if [ -n "${GH_IP_TOKEN:-}" ]; then
    read -r -p "Registry IP owner (GH_IP_OWNER): " GH_IP_OWNER || true
    read -r -p "Registry IP repo (GH_IP_REPO): " GH_IP_REPO || true
    read -r -p "Registry IP file (GH_IP_FILE): " GH_IP_FILE || true
  else
    GH_IP_OWNER=""; GH_IP_REPO=""; GH_IP_FILE=""
  fi
  read -r -s -p "SIDOMPUL_API_KEY (opsional): " SIDOMPUL_API_KEY || true
  echo ""
  read -r -s -p "HC_API_KEY (opsional): " HC_API_KEY || true
  echo ""
  read -r -p "CloudFront domain (CF_DOMAIN, opsional): " CF_DOMAIN || true
  if [ -n "${CF_DOMAIN:-}" ]; then
    read -r -s -p "CloudFront VMess UUID: " CF_VMESS_UUID || true
    echo ""
    read -r -s -p "CloudFront VLESS UUID: " CF_VLESS_UUID || true
    echo ""
    read -r -s -p "CloudFront Trojan password: " CF_TROJAN_PASSWORD || true
    echo ""
  else
    CF_VMESS_UUID=""; CF_VLESS_UUID=""; CF_TROJAN_PASSWORD=""
  fi
  read -r -p "Digiflazz username (opsional): " DIGI_USER || true
  if [ -n "$DIGI_USER" ]; then
    read -r -s -p "Digiflazz API key: " DIGI_KEY || true
    echo ""
  else
    DIGI_KEY=""
  fi
  read -r -p "Instal Xray? [Y/n, kosong = YA] " install_xray || true
fi

VPN_API_AUTH="$(openssl rand -hex 24)" || { echo "ERROR: gagal mengacak VPN_API_AUTH." >&2; exit 1; }
VPN_API_BASE="http://127.0.0.1:5890"

# ---------- 3b. Install total handling ----------
if [ "$REMOTE" = 1 ]; then
  if [ "$TOTAL" = 1 ] || [ -d "$BOT_DIR" ] || [ -f /usr/bin/menu ]; then
    siapkan_install_total
  fi
elif [ "$TOTAL" = 1 ]; then
  read -r -p "Ketik YA (huruf besar) untuk lanjut install total: " confirm_total || true
  [ "$confirm_total" = "YA" ] || { echo "Dibatalkan."; exit 0; }
  siapkan_install_total
elif [ -d "$BOT_DIR" ] || [ -f /usr/bin/menu ]; then
  read -r -p "Instalasi lama ditemukan. Hapus total dulu? [y/N] " hapus_total || true
  if [[ "$hapus_total" =~ ^[Yy]$ ]]; then
    siapkan_install_total
  fi
fi

if [ "$REMOTE" = 0 ]; then
  node --check "$SRC_DIR/v4-main/bot-js/app.js"
fi
python3 -m py_compile "$SRC_DIR/v4-main/Api/vpn-api.py"

# ---------- 4. Backup instalasi lama ----------
STEP4_BAK=""
if [ -d "$BOT_DIR" ]; then
  bak="/root/bot-js.bak-$(date +%Y%m%d-%H%M%S)"
  cp -a "$BOT_DIR" "$bak" || { echo "ERROR: backup bot lama gagal." >&2; exit 1; }
  lock_backup_perms "$bak"
  STEP4_BAK="$bak"
fi

# ---------- 6. Salin bot + API & Konfigurasi .env ----------
if [ "$REMOTE" = 1 ]; then
  cp "$SRC_DIR/v4-main/Api/vpn-api.py" "$API_FILE"
  EFFECTIVE_DOMAIN="$VPN_DOMAIN"
else
  OLD_ENV_TMP=""
  if [ -f "$BOT_DIR/.env" ]; then
    OLD_ENV_TMP="$(mktemp)"
    cp -a "$BOT_DIR/.env" "$OLD_ENV_TMP" 2>/dev/null || OLD_ENV_TMP=""
  fi
  rm -rf "$BOT_DIR"
  cp -a "$SRC_DIR/v4-main/bot-js" "$BOT_DIR"
  cp "$SRC_DIR/v4-main/Api/vpn-api.py" "$API_FILE"

  if [ -n "$OLD_ENV_TMP" ]; then
    read -r -p ".env lama ditemukan. Timpa dengan konfigurasi baru? [y/N] " overwrite || true
    if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
      cp -a "$OLD_ENV_TMP" "$BOT_DIR/.env"
      chmod 600 "$BOT_DIR/.env"
      OLD_AUTH="$(grep '^VPN_API_AUTH=' "$BOT_DIR/.env" | head -1 | cut -d= -f2-)"
      if [ -n "$OLD_AUTH" ]; then
        VPN_API_AUTH="$OLD_AUTH"
      fi
      rm -f "$OLD_ENV_TMP"
    else
      rm -f "$OLD_ENV_TMP"
      cat << EOF > "$BOT_DIR/.env"
BOT_TOKEN=$BOT_TOKEN
ADMIN_ID=$ADMIN_ID
VPN_API_BASE=$VPN_API_BASE
VPN_API_AUTH=$VPN_API_AUTH
H2H_URL=${H2H_URL:-https://payment-gateway.outletku.ai.id/api/h2h/v1}
H2H_KEY=${H2H_KEY:-}
GH_IP_TOKEN=${GH_IP_TOKEN:-}
GH_IP_OWNER=${GH_IP_OWNER:-}
GH_IP_REPO=${GH_IP_REPO:-}
GH_IP_FILE=${GH_IP_FILE:-}
SIDOMPUL_API_KEY=${SIDOMPUL_API_KEY:-}
HC_API_KEY=${HC_API_KEY:-}
CF_DOMAIN=${CF_DOMAIN:-}
CF_VMESS_UUID=${CF_VMESS_UUID:-}
CF_VLESS_UUID=${CF_VLESS_UUID:-}
CF_TROJAN_PASSWORD=${CF_TROJAN_PASSWORD:-}
DIGI_USER=${DIGI_USER:-}
DIGI_KEY=${DIGI_KEY:-}
EOF
      chmod 600 "$BOT_DIR/.env"
    fi
  else
    cat << EOF > "$BOT_DIR/.env"
BOT_TOKEN=$BOT_TOKEN
ADMIN_ID=$ADMIN_ID
VPN_API_BASE=$VPN_API_BASE
VPN_API_AUTH=$VPN_API_AUTH
H2H_URL=${H2H_URL:-https://payment-gateway.outletku.ai.id/api/h2h/v1}
H2H_KEY=${H2H_KEY:-}
GH_IP_TOKEN=${GH_IP_TOKEN:-}
GH_IP_OWNER=${GH_IP_OWNER:-}
GH_IP_REPO=${GH_IP_REPO:-}
GH_IP_FILE=${GH_IP_FILE:-}
SIDOMPUL_API_KEY=${SIDOMPUL_API_KEY:-}
HC_API_KEY=${HC_API_KEY:-}
CF_DOMAIN=${CF_DOMAIN:-}
CF_VMESS_UUID=${CF_VMESS_UUID:-}
CF_VLESS_UUID=${CF_VLESS_UUID:-}
CF_TROJAN_PASSWORD=${CF_TROJAN_PASSWORD:-}
DIGI_USER=${DIGI_USER:-}
DIGI_KEY=${DIGI_KEY:-}
EOF
    chmod 600 "$BOT_DIR/.env"
  fi

  # Restore database bot lama jika ada backup dari step 4
  if [ -n "$STEP4_BAK" ] && [ -f "$STEP4_BAK/data/bot.db" ]; then
    mkdir -p "$BOT_DIR/data"
    cp -a "$STEP4_BAK/data/bot.db" "$BOT_DIR/data/bot.db"
    chmod 600 "$BOT_DIR/data/bot.db"
    echo "Database bot lama (data/bot.db) berhasil dipulihkan."
  fi
fi

# ---------- 7. Setup VPN API Service ----------
mkdir -p /etc/vpn-api
cat << EOF > /etc/vpn-api/auth.env
VPN_API_AUTH=$VPN_API_AUTH
EOF
chmod 600 /etc/vpn-api/auth.env

cat << EOF > /etc/systemd/system/vpn-api.service
[Unit]
Description=Darren VPN Local Management API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
ExecStart=/usr/bin/python3 /root/vpn-api.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vpn-api.service
systemctl restart vpn-api.service

# Firewall port 5890 (hanya untuk localhost atau REMOTE_MAIN_IP jika remote)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -qw active; then
  ufw allow from 127.0.0.1 to any port 5890 proto tcp
  if [ "$REMOTE" = 1 ] && [ -n "${REMOTE_MAIN_IP:-}" ]; then
    ufw allow from "$REMOTE_MAIN_IP" to any port 5890 proto tcp
  fi
fi

# ---------- 8. Setup Xray & Stack TLS (HAProxy + Nginx) ----------
if [[ ! "$install_xray" =~ ^[Nn]$ ]]; then
  echo "Menginstal Xray-core versi pin: $XRAY_TAG_PIN ..."
  mkdir -p /etc/xray /var/log/xray
  
  # Unduh rilis resmi Xray
  XRAY_ZIP="Xray-linux-64.zip"
  XRAY_URL="https://github.com/XTLS/Xray-core/releases/download/$XRAY_TAG_PIN/$XRAY_ZIP"
  curl -fsSL "$XRAY_URL" -o "/tmp/$XRAY_ZIP"
  unzip -qo "/tmp/$XRAY_ZIP" -d /tmp/xray-extract
  mv /tmp/xray-extract/xray /usr/local/bin/xray
  chmod +x /usr/local/bin/xray
  rm -rf /tmp/$XRAY_ZIP /tmp/xray-extract

  # Service systemd Xray
  cat << EOF > /etc/systemd/system/xray.service
[Unit]
Description=Xray Service
Documentation=https://github.com/xtls
After=network.target nss-lookup.target

[Service]
User=root
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ExecStart=/usr/local/bin/xray run -config /etc/xray/config.json
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  # Salin konfigurasi Cfg jika ada di repo
  if [ -d "$SRC_DIR/v4-main/Cfg" ]; then
    [ -f "$SRC_DIR/v4-main/Cfg/haproxy.cfg" ] && cp "$SRC_DIR/v4-main/Cfg/haproxy.cfg" /etc/haproxy/haproxy.cfg
    [ -f "$SRC_DIR/v4-main/Cfg/nginx.conf" ] && cp "$SRC_DIR/v4-main/Cfg/nginx.conf" /etc/nginx/nginx.conf
    mkdir -p /etc/nginx/conf.d
    [ -f "$SRC_DIR/v4-main/Cfg/xray.conf" ] && cp "$SRC_DIR/v4-main/Cfg/xray.conf" /etc/nginx/conf.d/xray.conf
  fi

  systemctl daemon-reload
  systemctl enable xray.service haproxy nginx
  systemctl restart haproxy nginx xray.service || true
fi

# ---------- 9. Setup Menu Utama & Limit Script ----------
if [ -d "$SRC_DIR/v4-main/Cdy" ]; then
  if [ -f "$SRC_DIR/v4-main/Cdy/menu.zip" ]; then
    mkdir -p /tmp/menu-extract
    unzip -qo "$SRC_DIR/v4-main/Cdy/menu.zip" -d /tmp/menu-extract
    find /tmp/menu-extract -type f -exec cp {} /usr/bin/ \;
    chmod +x /usr/bin/menu /usr/bin/cek-izin /usr/bin/xray-restart 2>/dev/null || true
    rm -rf /tmp/menu-extract
  fi
  [ -f "$SRC_DIR/v4-main/Cdy/cek-izin" ] && cp "$SRC_DIR/v4-main/Cdy/cek-izin" /usr/bin/cek-izin && chmod +x /usr/bin/cek-izin
  [ -f "$SRC_DIR/v4-main/Cdy/speedtest" ] && cp "$SRC_DIR/v4-main/Cdy/speedtest" /usr/bin/speedtest && chmod +x /usr/bin/speedtest
fi

# Limit services dari Fls
if [ -d "$SRC_DIR/v4-main/Fls" ]; then
  for limit_script in limitvmess limitvless limittrojan limitshadowsocks; do
    if [ -f "$SRC_DIR/v4-main/Fls/$limit_script" ]; then
      cp "$SRC_DIR/v4-main/Fls/$limit_script" "/usr/bin/$limit_script"
      chmod +x "/usr/bin/$limit_script"
    fi
  done
fi

# ---------- 10. Start Bot via PM2 (jika bukan mode remote) ----------
if [ "$REMOTE" = 0 ]; then
  cd "$BOT_DIR"
  if [ -f "package.json" ]; then
    npm install --production || npm install
  fi
  pm2 delete darren-bot 2>/dev/null || true
  pm2 start app.js --name "darren-bot"
  pm2 save
  pm2 startup systemd -u root --hp /root 2>/dev/null || true
fi

echo ""
echo "=== VERDICT: INSTALASI BERHASIL SELESAI ==="
if [ "$REMOTE" = 0 ]; then
  echo "Bot Telegram (PM2: darren-bot) dan VPN API (port 5890) aktif."
else
  echo "Stack VPN Remote berhasil diinstal (tanpa bot Telegram)."
fi
