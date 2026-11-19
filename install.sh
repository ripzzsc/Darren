#!/usr/bin/env bash
# DARREN_INSTALLER_VERSION=fix-total-20261119-03
# Installer v4-main (versi perbaikan, LENGKAP) untuk VPS baru.
# Penanda versi yang bisa di-grep: DARREN_INSTALLER_VERSION di atas.
# Xray dipin ke SATU rilis resmi: lihat XRAY_TAG_PIN di bawah (bukan latest mengambang).
# Yang diinstal: VPN API lokal (port 5890, localhost saja),
# Xray (wajib jalan; default YA), menu utama SSH (menu.zip -> /usr/bin), dan vnstat untuk traffic menu.
# Bot Telegram (bot-js) TIDAK diinstal di awal secara default.
# Instal bot nanti lewat menu: menu -> 9 (MENU BOTELE) -> m-bot -> Install Bot,
# atau jalankan langsung: install-botjs
# Pakai flag --with-bot bila mau bot langsung terinstal saat install awal.
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
#   ./install.sh --with-bot # bot Telegram langsung terinstal saat install awal (default: TIDAK)
#   ./install.sh --remote  # server remote: stack VPN saja, tanpa bot Telegram
#                        # (non-interaktif; domain lewat env REMOTE_DOMAIN)
# Repo Darren saat ini PUBLIK, jadi unduhan di atas tidak butuh token.
set -euo pipefail
# F-B1: errtrace — tanpa ini trap ERR tidak diwariskan ke dalam fungsi,
# sehingga kegagalan di dalam fungsi (mis. npm install di pasang_node_pm2)
# mematikan installer tanpa mencetak VERDICT GAGAL.
set -E

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DARREN_INSTALLER_VERSION="fix-total-20261119-03"
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
WITH_BOT=0
for arg in "$@"; do
  case "$arg" in
    --total) TOTAL=1 ;;
    --remote) REMOTE=1 ;;
    --with-bot) WITH_BOT=1 ;;
    --help|-h)
      echo "Pakai: ./install.sh [--total] [--remote] [--with-bot]"
      echo "  --total   Install total: backup lalu hapus semua instalasi SC lama,"
      echo "            termasuk Node/PM2/vnstat, baru install baru."
      echo "  --remote  Server remote: instal stack VPN saja TANPA bot Telegram."
      echo "  --with-bot  Instal bot Telegram langsung saat install awal."
      echo "            Default (tanpa flag ini): bot TIDAK diinstal di awal;"
      echo "            instal nanti lewat menu (menu 9 -> m-bot -> Install Bot)."
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

# I-20: validasi format domain minimal — mengandung titik, bukan IPv4,
# hanya huruf/angka/titik/strip. Dipakai sebelum domain disimpan dan
# sebelum sertifikat diterbitkan.
domain_valid() {
  local d="$1"
  [ -n "$d" ] || return 1
  [[ "$d" == *.* ]] || return 1
  [[ "$d" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && return 1
  [[ "$d" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || return 1
  return 0
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
  backup_item /etc/ssh/.ssh.db "$backup"
  backup_item /etc/vmess "$backup"
  backup_item /etc/vless "$backup"
  backup_item /etc/trojan "$backup"
  backup_item /etc/shadowsocks "$backup"
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
# Repo NodeSource sisa run sebelumnya (kunci hilang/rusak) bisa membuat
# apt-get update gagal di awal; bila gagal, buang repo itu dan coba lagi
# tanpa NodeSource (pasang_node_pm2 akan fallback ke Node.js Ubuntu).
apt-get update -y || { rm -f /etc/apt/sources.list.d/nodesource.list; apt-get update -y; }
apt-get install -y ca-certificates curl gnupg unzip git python3 sqlite3 openssl haproxy nginx iproute2 at socat vnstat dnsutils

# ---------- 2. Node.js >= 18 + PM2 ----------
pasang_node_pm2() {
  local need_node=0
  local major=""
  local nodesource_ok=0
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
    mkdir -p /etc/apt/keyrings
    if [ ! -s /etc/apt/keyrings/nodesource.gpg ]; then
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg || {
        echo "PERINGATAN: gagal mengunduh kunci NodeSource, fallback ke Node.js Ubuntu." >&2
      }
    fi
    if [ -s /etc/apt/keyrings/nodesource.gpg ]; then
      NODE_MAJOR=20
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
      if apt-get update -y && apt-get install -y nodejs; then
        # apt-get update TIDAK gagal bila repo hanya gagal di-fetch
        # (hanya peringatan "Some index files failed"); pastikan Node 20
        # (NodeSource) yang terpasang, bukan Node 18 Ubuntu.
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
  # (Terjadi bila run sebelumnya memasang nodejs Ubuntu tanpa npm.)
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
  # F-B2: npm install bisa gagal sesaat bila jaringan tersendat; coba sampai 3x.
  _pm2_ok=0
  for _i in 1 2 3; do
    if npm install -g pm2; then _pm2_ok=1; break; fi
    echo "PERINGATAN: npm install -g pm2 gagal (percobaan $_i/3), mencoba lagi..." >&2
    sleep 5
  done
  # Bila semua percobaan gagal, test ini gagal -> trap ERR mencetak VERDICT GAGAL.
  test "$_pm2_ok" = "1"
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
# Format izin-install.txt (SATU format untuk install dan menu):
#   satu IP per baris, opsional |Nama. Baris # dan baris kosong diabaikan.
#   Contoh: 203.0.113.10|Budi
#   Tanpa tanggal expired dan tanpa kolom STATUS.
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
  # Cocokkan IP persis di awal baris (titik di-escape agar tidak cocok IP lain).
  local my_ip_esc="${my_ip//./\.}"
  local line=""
  line="$(grep -m1 -E "^${my_ip_esc}(\|.*)?$" "$allow" 2>/dev/null || true)"
  if [ -z "$line" ]; then
    echo "ERROR: IP VPS ini ($my_ip) TIDAK TERDAFTAR di izin-install.txt." >&2
    echo "Tambahkan baris '$my_ip|nama-server' ke izin-install.txt di repo, lalu jalankan ulang." >&2
    exit 1
  fi
  local found_name="${line#*|}"
  [ "$found_name" = "$line" ] && found_name=""
  echo "Izin install OK: $my_ip — ${found_name:-tanpa nama}."
}

if [ "$REMOTE" = 0 ]; then
  check_install_license
else
  echo "Mode remote: cek izin install dilewati."
fi

# ---------- 5. Prompt konfigurasi ----------
# Default: bot Telegram TIDAK diinstal di awal (WITH_BOT=0).
# BOT_TOKEN/ADMIN_ID dan field opsional bot hanya ditanya bila --with-bot.
# Tanpa --with-bot, instal bot nanti lewat menu (install-bot.sh).
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
elif [ "$WITH_BOT" = 1 ]; then
  echo ""
  echo "Isi konfigurasi berikut. Kosongkan yang opsional bila belum ada."
  echo "Mode --with-bot: bot Telegram langsung terinstal saat install awal."
  read -r -p "Domain VPS kamu (contoh: vpn.contoh.com, kosong = localhost saja): " VPN_DOMAIN || true
  # I-09: loop prompt wajib berhenti bila stdin EOF (Ctrl-D / pipe
  # kosong / non-interaktif) — read yang gagal karena EOF langsung batal,
  # bukan mengulang selamanya. Batas 3 percobaan untuk input yang salah.
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
else
  echo ""
  echo "Bot Telegram TIDAK diinstal di awal."
  echo "Instal nanti lewat menu: menu -> 9 (MENU BOTELE) -> m-bot -> Install Bot, atau jalankan: install-botjs"
  read -r -p "Domain VPS kamu (contoh: vpn.contoh.com, kosong = localhost saja): " VPN_DOMAIN || true
  BOT_TOKEN=""; ADMIN_ID=""; H2H_URL=""; H2H_KEY=""
  GH_IP_TOKEN=""; GH_IP_OWNER=""; GH_IP_REPO=""; GH_IP_FILE=""
  SIDOMPUL_API_KEY=""; HC_API_KEY=""
  CF_DOMAIN=""; CF_VMESS_UUID=""; CF_VLESS_UUID=""; CF_TROJAN_PASSWORD=""
  DIGI_USER=""; DIGI_KEY=""
  read -r -p "Instal Xray? [Y/n, kosong = YA] " install_xray || true
fi

# Pakai auth API yang sudah ada bila ada (agar bot lama / bot yang
# diinstal nanti lewat menu tetap cocok dengan API). Bila belum ada, generate baru.
if [ -f /etc/vpn-api/auth.env ]; then
  VPN_API_AUTH="$(grep '^VPN_API_AUTH=' /etc/vpn-api/auth.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
fi
if [ -z "${VPN_API_AUTH:-}" ]; then
  VPN_API_AUTH="$(openssl rand -hex 24)" || { echo "ERROR: gagal mengacak VPN_API_AUTH." >&2; exit 1; }
fi
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

if [ "$WITH_BOT" = 1 ]; then
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

# .env bot ditulis dengan printf per baris (bukan heredoc tanpa quote),
# agar nilai berisi $(), backtick, atau karakter khusus tidak dieksekusi (K-08).
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

# ---------- 6. Salin bot + API & Konfigurasi .env ----------
if [ "$REMOTE" = 1 ] || [ "$WITH_BOT" = 0 ]; then
  # Tanpa bot: hanya salin API. Bot lama yang sudah ada (bila ada) tidak dihapus di sini.
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
      write_bot_env
    fi
  else
    write_bot_env
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
# I-08: mode --remote mengikat API ke 0.0.0.0 supaya bot utama bisa
# memanggil :5890 lewat IP publik (UFW di bawah tetap membatasi ke
# REMOTE_MAIN_IP); mode biasa tetap localhost saja.
if [ "$REMOTE" = 1 ]; then
  _api_host="0.0.0.0"
else
  _api_host="127.0.0.1"
fi
cat << EOF > /etc/vpn-api/auth.env
VPN_API_AUTH=$VPN_API_AUTH
VPN_API_HOST=$_api_host
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
EnvironmentFile=/etc/vpn-api/auth.env
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
# I-01: TLS_OK/TLS_PENDING/XRAY_INSTALLED dipakai gate akhir (verdict jujur).
TLS_OK=0
TLS_PENDING=0
XRAY_INSTALLED=0
if [[ ! "$install_xray" =~ ^[Nn]$ ]]; then
  XRAY_INSTALLED=1
  echo "Menginstal Xray-core versi pin: $XRAY_TAG_PIN ..."
  mkdir -p /etc/xray /var/log/xray

  # I-20: simpan domain yang diketik saat install (bila diisi dan formatnya
  # valid) supaya fixcert/change-domain dan script lain bisa membacanya.
  if [ -n "${VPN_DOMAIN:-}" ]; then
    if domain_valid "$VPN_DOMAIN"; then
      echo "$VPN_DOMAIN" > /etc/xray/domain
      echo "$VPN_DOMAIN" > /root/domain
      mkdir -p /var/lib/kyt
      echo "IP=$VPN_DOMAIN" > /var/lib/kyt/ipvps.conf
      echo "Domain disimpan: $VPN_DOMAIN"
    else
      echo "PERINGATAN: domain '$VPN_DOMAIN' formatnya tidak valid — tidak disimpan, sertifikat tidak diterbitkan." >&2
    fi
  fi
  
  # Unduh rilis resmi Xray
  XRAY_ZIP="Xray-linux-64.zip"
  XRAY_URL="https://github.com/XTLS/Xray-core/releases/download/$XRAY_TAG_PIN/$XRAY_ZIP"
  curl -fsSL "$XRAY_URL" -o "/tmp/$XRAY_ZIP"
  unzip -qo "/tmp/$XRAY_ZIP" -d /tmp/xray-extract
  mv /tmp/xray-extract/xray /usr/local/bin/xray
  chmod +x /usr/local/bin/xray
  # File data geo (dibutuhkan routing geosite/geoip di config.json).
  [ -f /tmp/xray-extract/geoip.dat ] && mv /tmp/xray-extract/geoip.dat /usr/local/bin/geoip.dat
  [ -f /tmp/xray-extract/geosite.dat ] && mv /tmp/xray-extract/geosite.dat /usr/local/bin/geosite.dat
  rm -rf /tmp/$XRAY_ZIP /tmp/xray-extract

  # Service systemd Xray
  cat << EOF > /etc/systemd/system/xray.service
[Unit]
Description=Xray Service
Documentation=https://github.com/xtls
After=network.target nss-lookup.target

[Service]
User=root
Environment=XRAY_LOCATION_ASSET=/usr/local/bin
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

  # I-02/I-03: sertifikat Let's Encrypt via acme.sh RESMI (get.acme.sh),
  # atau fallback "TLS pending" (K16) bila domain/DNS belum siap — nginx
  # :81 jadi HTTP polos supaya nginx -t lolos dan nginx tetap jalan.
  mkdir -p /var/www/html
  if [ -f /etc/xray/xray.crt ] && [ -f /etc/xray/xray.key ] && [ -f /etc/haproxy/hap.pem ]; then
    echo "Sertifikat lama ditemukan — dipakai, tidak diterbitkan ulang."
    TLS_OK=1
  elif [ -n "${VPN_DOMAIN:-}" ] && domain_valid "$VPN_DOMAIN"; then
    _vps_ip="$(curl -fsSL --max-time 10 https://ifconfig.me 2>/dev/null | tr -d '[:space:]' || true)"
    _domain_ip="$(nslookup "$VPN_DOMAIN" 8.8.8.8 2>/dev/null | awk '/^Address: / {print $2}' | tail -n1)"
    [ -z "$_domain_ip" ] && _domain_ip="$(getent hosts "$VPN_DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1)"
    if [ -n "$_vps_ip" ] && [ "$_domain_ip" = "$_vps_ip" ]; then
      echo "Domain $VPN_DOMAIN mengarah ke VPS ini — menerbitkan sertifikat Let's Encrypt..."
      if [ ! -x /root/.acme.sh/acme.sh ]; then
        echo "Memasang acme.sh resmi..."
        if curl -fsSL --max-time 60 https://get.acme.sh -o /tmp/get.acme.sh && sh /tmp/get.acme.sh >/dev/null 2>&1; then
          echo "acme.sh terpasang."
        else
          echo "PERINGATAN: gagal memasang acme.sh resmi — lanjut mode TLS pending." >&2
        fi
        rm -f /tmp/get.acme.sh
      fi
      if [ -x /root/.acme.sh/acme.sh ]; then
        # Port 80 harus bebas untuk tantangan HTTP-01.
        systemctl stop nginx haproxy 2>/dev/null || true
        /root/.acme.sh/acme.sh --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
        if /root/.acme.sh/acme.sh --issue --standalone -d "$VPN_DOMAIN" --keylength ec-256; then
          if /root/.acme.sh/acme.sh --installcert -d "$VPN_DOMAIN" --fullchainpath /etc/xray/xray.crt --keypath /etc/xray/xray.key --ecc \
             && [ -f "/root/.acme.sh/${VPN_DOMAIN}_ecc/fullchain.cer" ] && [ -f "/root/.acme.sh/${VPN_DOMAIN}_ecc/${VPN_DOMAIN}.key" ]; then
            cat "/root/.acme.sh/${VPN_DOMAIN}_ecc/fullchain.cer" "/root/.acme.sh/${VPN_DOMAIN}_ecc/${VPN_DOMAIN}.key" > /etc/haproxy/hap.pem
            chmod 600 /etc/xray/xray.key /etc/haproxy/hap.pem
            echo "Sertifikat Let's Encrypt untuk $VPN_DOMAIN terbit."
            TLS_OK=1
          else
            echo "PERINGATAN: gagal memasang sertifikat ke /etc/xray — lanjut mode TLS pending." >&2
          fi
        else
          echo "PERINGATAN: acme.sh gagal menerbitkan sertifikat untuk $VPN_DOMAIN — lanjut mode TLS pending." >&2
        fi
      fi
    else
      echo "PERINGATAN: domain $VPN_DOMAIN belum mengarah ke IP VPS ini (${_vps_ip:-tidak diketahui}) — sertifikat tidak diterbitkan, lanjut mode TLS pending." >&2
    fi
  else
    echo "Tidak ada domain yang valid — sertifikat tidak diterbitkan, lanjut mode TLS pending."
  fi
  if [ "$TLS_OK" != "1" ]; then
    TLS_PENDING=1
    # K16: :81 jadi HTTP polos (hapus baris ssl) supaya nginx -t lolos.
    if [ -f /etc/nginx/conf.d/xray.conf ]; then
      sed -i 's/^\(\s*\)listen 81 ssl http2 reuseport;/\1listen 81;/; /^\s*ssl_certificate/d; /^\s*ssl_ciphers/d; /^\s*ssl_protocols/d' /etc/nginx/conf.d/xray.conf
    fi
    echo "Status TLS: PENDING — nginx :81 jalan HTTP polos; terbitkan sertifikat lewat menu (change-domain / fix-add-ssl) agar VPN domain jalan."
  fi

  # I-04: pasang stack SSH-WS — tls-router :10019, ws-shield :10017,
  # ws-bridge :10018, biner ws + tun.conf. haproxy :443 meneruskan ke
  # tls-router, jadi tanpa stack ini jalur WS :443 mati walau sertifikat ada.
  if [ -d "$SRC_DIR/v4-main/Cfg" ] && [ -d "$SRC_DIR/v4-main/Fls" ]; then
    for _py in tls-router ws-shield ws-bridge; do
      if [ -f "$SRC_DIR/v4-main/Cfg/$_py.py" ]; then
        cp "$SRC_DIR/v4-main/Cfg/$_py.py" "/usr/local/bin/$_py.py"
        chmod +x "/usr/local/bin/$_py.py"
      else
        echo "PERINGATAN: $SRC_DIR/v4-main/Cfg/$_py.py tidak ada — stack WS tidak lengkap." >&2
      fi
      if [ -f "$SRC_DIR/v4-main/Cfg/$_py.service" ]; then
        cp "$SRC_DIR/v4-main/Cfg/$_py.service" "/etc/systemd/system/$_py.service"
      else
        echo "PERINGATAN: unit $_py.service tidak ada di repo." >&2
      fi
    done
    if [ -f "$SRC_DIR/v4-main/Fls/ws" ]; then
      cp "$SRC_DIR/v4-main/Fls/ws" /usr/bin/ws
      chmod +x /usr/bin/ws
    else
      echo "PERINGATAN: biner ws (Fls/ws) tidak ada — stack WS tidak lengkap." >&2
    fi
    if [ -f "$SRC_DIR/v4-main/Cfg/tun.conf" ]; then
      cp "$SRC_DIR/v4-main/Cfg/tun.conf" /usr/bin/tun.conf
    else
      echo "PERINGATAN: tun.conf tidak ada di repo." >&2
    fi
    if [ -f "$SRC_DIR/v4-main/Fls/ws.service" ]; then
      cp "$SRC_DIR/v4-main/Fls/ws.service" /etc/systemd/system/ws.service
    else
      echo "PERINGATAN: unit ws.service tidak ada di repo." >&2
    fi
  else
    echo "PERINGATAN: folder Cfg/Fls tidak ada — stack WS tidak dipasang." >&2
  fi

  # F-02: geoip.dat bawaan rilis Xray hanya berisi 19 entri (tanpa
  # US/CA/JP/IN/YT) sehingga routing template gagal divalidasi; ganti
  # dengan geoip.dat lengkap dari Loyalsoldier (260 entri). Bila unduhan
  # gagal, pakai yang bawaan dan validasi di bawah akan memberi peringatan.
  if curl -fsSL --max-time 120 https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat -o /tmp/geoip.dat; then
    mv /tmp/geoip.dat /usr/local/bin/geoip.dat
    echo "geoip.dat lengkap (Loyalsoldier) terpasang."
  else
    echo "PERINGATAN: gagal mengunduh geoip.dat lengkap; memakai geoip.dat bawaan Xray (routing geoip:us/ca/jp/in/yt tidak akan valid)." >&2
  fi

  # F-02: hasilkan /etc/xray/config.json dari template repo bila belum ada.
  # Template berisi marker (#vmess, #vless, ...) yang dipakai API/menu
  # untuk menambah akun — markernya JANGAN dihapus. UUID seed diganti
  # dengan UUID acak tiap instalasi (UUID template ada di repo publik).
  # Config yang sudah ada (berisi akun) tidak pernah ditimpa.
  if [ ! -f /etc/xray/config.json ]; then
    if [ -f "$SRC_DIR/v4-main/Cfg/config.json" ]; then
      _uuid_baru="$(cat /proc/sys/kernel/random/uuid)"
      sed "s/1d1c1d94-6987-4658-a4dc-8821a30fe7e0/$_uuid_baru/g" "$SRC_DIR/v4-main/Cfg/config.json" > /etc/xray/config.json
      echo "config Xray dibuat di /etc/xray/config.json (UUID seed baru)."
    else
      echo "PERINGATAN: template $SRC_DIR/v4-main/Cfg/config.json tidak ditemukan; /etc/xray/config.json tidak dibuat." >&2
    fi
  fi
  # Validasi config sebelum service di-restart.
  if [ -f /etc/xray/config.json ] && [ -x /usr/local/bin/xray ]; then
    if /usr/local/bin/xray run -test -config /etc/xray/config.json >/dev/null 2>&1; then
      echo "config Xray valid (xray -test OK)."
    else
      echo "PERINGATAN: /etc/xray/config.json tidak lolos xray -test; xray mungkin tidak bisa start." >&2
    fi
  fi

  systemctl daemon-reload
  systemctl enable xray.service haproxy nginx
  # I-01: restart wajib jalan — kegagalan di sini menggagalkan install
  # (trap ERR mencetak VERDICT GAGAL), bukan ditelan "|| true".
  # haproxy hanya di-restart bila sertifikat ada; bila TLS pending,
  # haproxy sengaja tidak jalan (tidak ada hap.pem).
  systemctl restart xray.service
  systemctl restart nginx
  if [ "$TLS_OK" = "1" ]; then
    systemctl restart haproxy
  fi
  # I-04: nyalakan stack SSH-WS (urutan: shield dulu, bridge Requires shield).
  systemctl enable ws-shield.service ws-bridge.service tls-router.service ws.service 2>/dev/null || true
  systemctl restart ws-shield.service 2>/dev/null || echo "PERINGATAN: ws-shield gagal start — jalur SSH-WS :443 belum jalan." >&2
  systemctl restart ws-bridge.service 2>/dev/null || echo "PERINGATAN: ws-bridge gagal start — jalur SSH-WS :443 belum jalan." >&2
  systemctl restart ws.service 2>/dev/null || echo "PERINGATAN: ws gagal start." >&2
  systemctl restart tls-router.service 2>/dev/null || echo "PERINGATAN: tls-router gagal start — jalur WS :443 belum jalan." >&2
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
  # Installer bot mandiri (dipanggil dari menu). Disalin SETELAH menu.zip,
  # agar /usr/bin/install-botjs berisi installer asli, bukan wrapper dari zip.
  [ -f "$SRC_DIR/v4-main/install-bot.sh" ] && cp "$SRC_DIR/v4-main/install-bot.sh" /usr/bin/install-botjs && chmod +x /usr/bin/install-botjs
  [ -f "$SRC_DIR/v4-main/Cdy/speedtest" ] && cp "$SRC_DIR/v4-main/Cdy/speedtest" /usr/bin/speedtest && chmod +x /usr/bin/speedtest
fi

# Limit kuota/IP Xray (I-11): script limit ada di Fls/ dengan nama
# vmess/vless/trojan/shadowsocks; unit systemd menjalankan
# /etc/xray/limit.<proto>. Loop lama menyalin nama file yang tidak ada
# (limitvmess dst.) sehingga diam-diam tidak ada yang terpasang.
# (limit-ip sengaja tidak dipasang: menu limit-on-off sendiri menyatakan
# fitur LIMIT IP belum tersedia di paket ini.)
if [ -d "$SRC_DIR/v4-main/Fls" ]; then
  mkdir -p /etc/xray
  for _proto in vmess vless trojan shadowsocks; do
    if [ -f "$SRC_DIR/v4-main/Fls/$_proto" ]; then
      cp "$SRC_DIR/v4-main/Fls/$_proto" "/etc/xray/limit.$_proto"
      chmod +x "/etc/xray/limit.$_proto"
    else
      echo "PERINGATAN: script limit $_proto tidak ada di Fls/." >&2
    fi
    if [ -f "$SRC_DIR/v4-main/Fls/limit$_proto.service" ]; then
      cp "$SRC_DIR/v4-main/Fls/limit$_proto.service" "/etc/systemd/system/limit$_proto.service"
    else
      echo "PERINGATAN: unit limit$_proto.service tidak ada di Fls/." >&2
    fi
  done
  systemctl daemon-reload
  systemctl enable limitvmess.service limitvless.service limittrojan.service limitshadowsocks.service 2>/dev/null || true
  for _unit in limitvmess limitvless limittrojan limitshadowsocks; do
    systemctl restart "$_unit.service" 2>/dev/null || echo "PERINGATAN: $_unit gagal start." >&2
  done
fi

# ---------- 10. Start Bot via PM2 (hanya bila --with-bot) ----------
if [ "$WITH_BOT" = 1 ]; then
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
# I-01: gate akhir yang jujur — cek service benar-benar aktif, bukan
# sekadar "restart tidak error". Dua verdict terpisah seperti janji README:
# "Xray aktif" vs "VPN domain jalan".
CORE_OK=1
CORE_FAIL=""
if [ "$XRAY_INSTALLED" = "1" ]; then
  if ! systemctl is-active --quiet xray.service; then CORE_OK=0; CORE_FAIL="$CORE_FAIL xray"; fi
  if ! nginx -t >/dev/null 2>&1; then CORE_OK=0; CORE_FAIL="$CORE_FAIL nginx-config"; fi
  if ! systemctl is-active --quiet nginx; then CORE_OK=0; CORE_FAIL="$CORE_FAIL nginx"; fi
else
  echo "Xray dilewati sesuai pilihan saat prompt (stack TLS tidak dikonfigurasi)."
fi
if ! systemctl is-active --quiet vpn-api.service; then CORE_OK=0; CORE_FAIL="$CORE_FAIL vpn-api"; fi

DOMAIN_OK=1
DOMAIN_FAIL=""
if [ "$XRAY_INSTALLED" = "1" ]; then
  if [ "$TLS_OK" != "1" ]; then
    DOMAIN_OK=0; DOMAIN_FAIL="$DOMAIN_FAIL tls-pending"
  else
    # haproxy hanya bisa jalan bila sertifikat ada; cek konfig + statusnya
    # hanya dalam kondisi itu (bila TLS pending, haproxy mati itu wajar).
    if ! haproxy -c -f /etc/haproxy/haproxy.cfg >/dev/null 2>&1; then DOMAIN_OK=0; DOMAIN_FAIL="$DOMAIN_FAIL haproxy-config"; fi
    if ! systemctl is-active --quiet haproxy; then DOMAIN_OK=0; DOMAIN_FAIL="$DOMAIN_FAIL haproxy"; fi
  fi
  # I-04: port stack SSH-WS harus listen (10017 shield, 10018 bridge, 10019 router).
  for _p in 10017 10018 10019; do
    if ! ss -tln 2>/dev/null | grep -q ":$_p "; then DOMAIN_OK=0; DOMAIN_FAIL="$DOMAIN_FAIL ws:$_p"; fi
  done
  # F-B5: listen saja TIDAK CUKUP — F-B3 lolos gate lama padahal WS mati
  # total. Uji handshake WebSocket sungguhan ke nginx :1010 (harap 101).
  # curl di sini meniru klien WS: Upgrade websocket + Sec-WebSocket-Key.
  _ws_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
    http://127.0.0.1:1010/vmess 2>/dev/null || echo 000)"
  if [ "$_ws_code" != "101" ]; then DOMAIN_OK=0; DOMAIN_FAIL="$DOMAIN_FAIL ws-handshake:$_ws_code"; fi
  # Bila TLS jalan, uji juga rantai penuh :443 (haproxy -> tls-router ->
  # nginx :1010). Gagal di sini berarti WS pelanggan mati walau :1010 lolos.
  if [ "$TLS_OK" = "1" ]; then
    _ws443_code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
      https://127.0.0.1:443/vmess 2>/dev/null || echo 000)"
    if [ "$_ws443_code" != "101" ]; then DOMAIN_OK=0; DOMAIN_FAIL="$DOMAIN_FAIL ws443-handshake:$_ws443_code"; fi
    # Smoke gRPC (peringatan saja, bukan gate): GET h2c ke :1013 harap 415
    # (respons HTTP/2 asli dari lokasi grpc; 415 wajar karena bukan POST gRPC).
    _grpc_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --http2-prior-knowledge http://127.0.0.1:1013/vless-grpc 2>/dev/null || echo 000)"
    if [ "$_grpc_code" != "415" ]; then echo "PERINGATAN: smoke gRPC :1013 mengembalikan $_grpc_code (harap 415) — periksa rute tls-router/gRPC." >&2; fi
  fi
fi

if [ "$CORE_OK" != "1" ]; then
  echo "=== VERDICT: INSTALL GAGAL (service mati:$CORE_FAIL ) ===" >&2
  echo "Periksa pesan error di atas lalu jalankan ulang." >&2
  exit 1
fi
echo "=== VERDICT XRAY: AKTIF ==="
if [ "$XRAY_INSTALLED" = "1" ]; then
  if [ "$DOMAIN_OK" = "1" ]; then
    echo "=== VERDICT VPN DOMAIN: JALAN ==="
  else
    echo "=== VERDICT VPN DOMAIN: TIDAK JALAN ($DOMAIN_FAIL ) ==="
  fi
fi
if [ "$TLS_PENDING" = "1" ]; then
  echo "TLS pending: sertifikat belum ada. Pastikan DNS domain sudah mengarah ke IP VPS,"
  echo "lalu jalankan 'change-domain' dari menu untuk menerbitkan sertifikat."
fi
if [ "$XRAY_INSTALLED" = "1" ] && [ "$DOMAIN_OK" = "1" ]; then
  echo "=== VERDICT: INSTALASI BERHASIL SELESAI ==="
elif [ "$XRAY_INSTALLED" = "1" ]; then
  echo "=== VERDICT: INSTALASI SELESAI — VPN DOMAIN BELUM JALAN ==="
else
  echo "=== VERDICT: INSTALASI SELESAI (Xray dilewati) ==="
fi
if [ "$WITH_BOT" = 1 ]; then
  echo "Bot Telegram (PM2: darren-bot) dan VPN API (port 5890) aktif."
elif [ "$REMOTE" = 1 ]; then
  echo "=== Selesai ==="
  echo "Server remote: ${VPN_DOMAIN:-${REMOTE_MAIN_IP:-}} berhasil diinstal (tanpa bot Telegram)."
else
  echo "VPN API (port 5890), Xray, dan menu berhasil diinstal."
  echo "Bot Telegram BELUM terinstal."
  echo "Instal bot lewat menu: menu -> 9 (MENU BOTELE) -> m-bot -> Install Bot,"
  echo "atau jalankan langsung: install-botjs"
fi
