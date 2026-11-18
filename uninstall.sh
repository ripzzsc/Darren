#!/usr/bin/env bash
# DARREN_UNINSTALLER_VERSION=fix-total-20261104-01
# Uninstaller script Darren (pasangan install.sh).
# Menghapus stack Darren: bot-js (pm2), vpn-api, Xray, menu utama,
# permission (cek-izin), speedtest, DAN Node.js/npm, PM2 (+ startup +
# ~/.pm2), vnstat, serta service haproxy/nginx yang dipasang installer
# (konfig TLS-nya TIDAK ikut dihapus — lihat daftar tersisa di bawah).
# Ini uninstall TOTAL untuk stack Darren — setelah ini, install ulang
# (install.sh) akan memasang Node/PM2/vnstat lagi dari nol.
# DAFTAR JUJUR — YANG DIHAPUS: bot ripzz-bot-js (pm2) + daemon PM2 +
# startup pm2-root + ~/.pm2, PM2 global, service vpn-api + xray + unitnya
# + drop-in xray + unit/script limit, file /root/bot-js, /root/vpn-api.py,
# /etc/vpn-api, /usr/local/bin/xray, /etc/xray, menu /usr/bin/menu +
# script menu (dari menu.zip bila ada, atau daftar yang diketahui bila
# tidak ada), /usr/bin/ipsave, /usr/bin/cek-izin, /var/log/izin.log,
# /usr/bin/speedtest, /etc/nginx/conf.d/xray.conf, /root/darren-install,
# Node.js + npm (paket apt) dan vnstat (+ data /var/lib/vnstat).
# DAFTAR JUJUR — YANG TERSISA (tidak dihapus, bukan wipe total VPS):
# OS dasar, perkakas generik (curl, git, wget, unzip, python3, sqlite3,
# openssl, ca-certificates, gnupg), konfigurasi/kunci SSH, direktori
# backup (darren-*-backup-* dan *.bak-*), data aplikasi lain di luar
# stack Darren, repo apt NodeSource, paket haproxy/nginx/at (hanya
# service-nya dihentikan; hapus manual via apt bila perlu),
# /etc/haproxy/haproxy.cfg, /etc/nginx/nginx.conf, /var/www/html,
# sertifikat LE (/etc/haproxy/hap.pem, /etc/xray/xray.crt/.key bila ada
# — /etc/xray sendiri dihapus, jadi salin dulu bila perlu), data acme.sh
# (~/.acme.sh), dan — bila menu.zip tidak ditemukan — file menu di luar
# daftar yang diketahui (dicatat di output, periksa manual /usr/bin).
# Backup dulu ke /root/darren-uninstall-backup-<waktu>/ sebelum menghapus
# (mode 700; file secret di dalamnya 600; mencakup bot-js termasuk
# data/bot.db, /etc/bot, /etc/vpn-api, /etc/xray termasuk file .db/limit/
# .txt akun di dalamnya, vpn-api.py, unit systemd, entry point menu,
# dan file stack TLS). Backup GAGAL = uninstall BERHENTI sebelum
# penghapusan apa pun (tidak ada lagi "gagal, lanjut" di jalur backup).
# Restore = kembalikan file dari backup + install ulang Node/PM2/vnstat
# (backup TIDAK mengembalikan Node/PM2/vnstat yang terhapus).
#
# Cara pakai di VPS (sebagai root):
#   curl -fsSL https://raw.githubusercontent.com/bungkangeddeng-cyber/Darren/main/uninstall.sh -o uninstall.sh
#   chmod +x uninstall.sh
#   ./uninstall.sh
#
# Script ini TIDAK berisi secret apapun.
# Daftar hapus di hapus_stack_darren() adalah SATU-SATUNYA sumber kebenaran
# untuk penghapusan stack Darren: install.sh mode --total memakai fungsi yang
# sama (source dari uninstall.sh ini), jadi mengubah daftar di sini otomatis
# mengubah --total — jangan membuat daftar hapus kedua di tempat lain.

# hapus_stack_darren [keep-src]
# Menghapus komponen stack Darren. Argumen opsional:
#   keep-src  = JANGAN hapus /root/darren-install (dipakai install.sh --total,
#               karena source baru sudah ada di sana dan masih dibutuhkan
#               langkah install berikutnya).
# Tanpa argumen, /root/darren-install ikut dihapus (uninstall mandiri).
# Fungsi ini HANYA menghapus; konfirmasi + backup dilakukan pemanggil
# (main() di bawah, atau siapkan_install_total() di install.sh).
# Perintah yang bisa gagal memakai || true supaya satu komponen yang sudah
# tidak ada tidak menghentikan penghapusan komponen lain.
# Fungsi ini TIDAK memanggil exit (penting saat di-source install.sh).
# B18: path diturunkan dari direktori script sendiri, bukan CWD pemanggil.
# Bila di-source install.sh, BASH_SOURCE[0] = path uninstall.sh ini.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# B12: daftar file menu yang diketahui (dari menu.zip repo, untuk
# fallback bila menu.zip tidak ditemukan di VPS saat uninstall).
MENU_KNOWN=(
  Lt-on-off
  about
  add-bot.sh
  add-ssh
  add-ssr
  add-tro
  add-vle
  add-vme
  anti-ddos
  auto-kill
  auto_update
  auto_update2
  autobackup
  autoreboot
  backer
  backup-bot
  backupfile
  bw
  cek-izin
  cek-ssh
  cek-ssr
  cek-tro
  cek-vle
  cek-vme
  ceklim
  cekudp
  change-domain
  change-domain-admin
  change-domain-selowdns
  change-vless-qouta
  change-vmess-qouta
  check-tro
  check-vle
  check-vme
  clearcache
  clearlog
  create-bot-notif
  del-bot-notif
  del-ssh
  del-ssr
  del-tro
  del-vle
  del-vme
  delet-cache-file
  delexp
  enc
  expsc
  fix-add-ssl
  fixcert
  fixhap
  fixhap-admin
  fixngix
  fixws-epro
  fixxray
  ganti-ip-ssh
  ganti-ip-trojan
  ganti-ip-vless
  ganti-ip-vmess
  gbuser
  hapus-bot
  install-bot.sh
  install-botjs
  killtrial
  limit-on-off
  limitspeed
  limitssh-ip
  lock
  lock-tr
  lock-vl
  lock-vm
  m-bkp
  m-bot
  m-ftr
  m-noobz
  m-panel
  m-ssh
  m-ssr
  m-tro
  m-vle
  m-xray
  mbot
  member-ssh
  member-ssr
  member-tro
  member-vle
  member-vme
  menu
  menu-webmin
  mullog
  neo
  prot
  recover
  recover-tr
  recover-vl
  recover-vm
  renew-nob
  renew-ssh
  renew-ssr
  renew-tro
  renew-vle
  renew-vme
  reset
  restart-bot
  restore-bot
  restorefile
  run
  run-old
  run_multi_threading
  sc
  sd
  stop-bot
  tendang
  trial-ssh
  trial-ssr
  trial-tro
  trial-vle
  trial-vme
  trojan-qouta
  unlock
  unlock-tr
  unlock-vl
  unlock-vm
  user-ssh
  welcome
  xp
  xray-restart
)

hapus_stack_darren() {
  local keep_src="${1:-}"
  # B12: manifest menu dari menu.zip bila ada — cari dulu di direktori
  # script ini (kasus install --total), lalu di source lama.
  local menu_zip=""
  if [ -f "$SCRIPT_DIR/v4-main/Cdy/menu.zip" ]; then
    menu_zip="$SCRIPT_DIR/v4-main/Cdy/menu.zip"
  elif [ -f "/root/darren-install/v4-main/Cdy/menu.zip" ]; then
    menu_zip="/root/darren-install/v4-main/Cdy/menu.zip"
  fi

  # 1. Bot PM2: hapus proses + matikan daemon + cabut startup.
  #    (pm2 save lama dihapus dari alur: tidak ada gunanya menyimpan dump
  #    kosong tepat sebelum PM2 dan ~/.pm2 dihapus total di bawah.)
  pm2 delete ripzz-bot-js 2>/dev/null || true
  pm2 kill 2>/dev/null || true
  pm2 unstartup systemd -u root --hp /root 2>/dev/null || true
  systemctl disable pm2-root 2>/dev/null || true
  rm -f /etc/systemd/system/pm2-root.service

  # 2. Service Darren: vpn-api + xray.
  systemctl disable --now vpn-api 2>/dev/null || true
  systemctl disable --now xray 2>/dev/null || true
  rm -f /etc/systemd/system/vpn-api.service /etc/systemd/system/xray.service
  # FASE 1: hapus juga direktori drop-in Xray (backup dilakukan pemanggil:
  # main() di bawah, atau siapkan_install_total() di install.sh) supaya
  # unit lama yang menimpa ExecStart tidak selamat dari uninstall/--total.
  rm -rf /etc/systemd/system/xray.service.d
  # FASE 2: service + script limit (dipasang installer dari Fls lokal) ikut dihapus.
  systemctl disable --now limitvmess limitvless limittrojan limitshadowsocks 2>/dev/null || true
  rm -f /etc/systemd/system/limitvmess.service /etc/systemd/system/limitvless.service /etc/systemd/system/limittrojan.service /etc/systemd/system/limitshadowsocks.service
  rm -f /etc/xray/limit.vmess /etc/xray/limit.vless /etc/xray/limit.trojan /etc/xray/limit.shadowsocks
  # FASE 2b: stack SSH-WS (ws + ws-shield + ws-bridge + tls-router) ikut
  # dihapus supaya uninstall benar-benar fresh — sebelumnya tertinggal
  # (hanya di-overwrite saat install ulang). Semua file ini ada di repo
  # GitHub, jadi tidak perlu di-backup; install.sh 10c memasangnya lagi.
  systemctl disable --now ws ws-shield ws-bridge tls-router 2>/dev/null || true
  rm -f /etc/systemd/system/ws.service /etc/systemd/system/ws-shield.service /etc/systemd/system/ws-bridge.service /etc/systemd/system/tls-router.service
  rm -f /usr/bin/ws /usr/local/bin/ws-shield.py /usr/local/bin/ws-bridge.py /usr/local/bin/tls-router.py
  systemctl daemon-reload 2>/dev/null || true

  # 3. Menu (daftar file persis dari menu.zip bila ada; dibaca SEBELUM
  #    source dihapus pada langkah 6). B12: bila menu.zip tidak ada,
  #    hapus daftar file menu yang diketahui (MENU_KNOWN di atas) dan
  #    CATAT sisanya di output — jangan diam soal file yang mungkin lolos.
  if [ -n "$menu_zip" ]; then
    unzip -Z1 "$menu_zip" 2>/dev/null | while IFS= read -r f; do
      case "$f" in
        */) continue ;;
        *) rm -f "/usr/bin/$(basename "$f")" ;;
      esac
    done || true
  else
    echo "PERHATIAN: menu.zip tidak ditemukan — menghapus daftar file menu yang diketahui saja."
    for _known in "${MENU_KNOWN[@]}"; do
      rm -f "/usr/bin/$_known"
    done
    echo "CATATAN: file menu di luar daftar yang diketahui (bila ada) TIDAK terhapus."
    echo "Periksa manual: ls /usr/bin | grep -i -E 'menu|cek-|xray|vle|vme|tro|ssr|ssh' dan hapus sisanya bila itu milik Darren."
  fi
  rm -f /usr/bin/menu /usr/bin/ipsave

  # 3b. Permission baru (cek-izin): dihapus eksplisit supaya uninstall tetap
  # total walau menu.zip lokal di VPS masih versi lama (tanpa cek-izin).
  # Cache izin ikut terhapus bersama /etc/xray di langkah 4.
  rm -f /usr/bin/cek-izin /var/log/izin.log
  rm -rf /tmp/menu-baru

  # 4. File aplikasi + sisa unduhan Xray + speedtest (K12) + site TLS Darren.
  # Service haproxy/nginx dihentikan (paket + konfig utamanya TERSISA,
  # lihat daftar jujur di header — hanya site Darren yang dihapus).
  systemctl disable --now haproxy nginx 2>/dev/null || true
  rm -f /etc/nginx/conf.d/xray.conf /usr/bin/speedtest /etc/cron.d/darren-xp
  rm -rf /root/bot-js /root/vpn-api.py /etc/vpn-api /usr/local/bin/xray /etc/xray
  rm -f /tmp/xray.zip
  rm -rf /tmp/xray-bin

  # 5. PM2 global + data PM2/npm (SETELAH daemon mati; npm masih ada di
  #    titik ini karena Node baru dihapus di langkah 7).
  if command -v npm >/dev/null 2>&1; then
    npm uninstall -g pm2 2>/dev/null || true
  fi
  rm -rf /usr/lib/node_modules/pm2
  rm -f /usr/bin/pm2 /usr/bin/pm2-dev
  rm -rf /root/.pm2 /root/.npm

  # 6. Source installer (kecuali mode keep-src untuk --total).
  #    Catatan: /tmp/install-total-*.sh (salinan install.sh saat re-exec
  #    --total) SENGAJA tidak dihapus — file itu sedang berjalan saat
  #    fungsi ini dipanggil dari install.sh.
  if [ "$keep_src" != "keep-src" ]; then
    rm -rf /root/darren-install
  fi

  # 7. Node.js/npm + vnstat (TERAKHIR: tidak ada langkah sesudah ini yang
  #    memakai npm/node/pm2 — apt sendiri tidak butuh Node).
  #    Bukti pasang (install.sh): Node 20 dari repo apt NodeSource (langkah 2,
  #    hanya bila node belum ada/<18) → paket `nodejs` (npm ikut di paket
  #    NodeSource); vnstat dari apt (langkah 10, untuk traffic menu).
  #    Repo apt NodeSource SENGAJA tidak dihapus: file repo itu inert dan
  #    dibuat ulang identik oleh install.sh langkah 2 saat install ulang.
  DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge nodejs npm 2>/dev/null \
    || echo "PERINGATAN: hapus paket nodejs/npm gagal, lanjut."
  DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge vnstat 2>/dev/null \
    || echo "PERINGATAN: hapus paket vnstat gagal, lanjut."
  rm -rf /var/lib/vnstat
  systemctl daemon-reload 2>/dev/null || true
}

main() {
  if [ "$(id -u)" != "0" ]; then
    echo "Jalankan uninstaller ini sebagai root." >&2
    exit 1
  fi

  echo "=== Uninstaller Darren (TOTAL stack Darren) ==="
  echo "Yang akan dihapus:"
  echo "  - bot ripzz-bot-js (pm2) + daemon PM2 + startup pm2-root + ~/.pm2"
  echo "  - PM2 global (npm uninstall -g pm2 + /usr/lib/node_modules/pm2)"
  echo "  - service vpn-api + xray + file unitnya + direktori drop-in xray"
  echo "  - service limit + stack SSH-WS (ws, ws-shield, ws-bridge, tls-router)"
  echo "  - service haproxy + nginx (dihentikan; paket + konfig utama TERSISA)"
  echo "  - file /root/bot-js, /root/vpn-api.py, /etc/vpn-api, /usr/local/bin/xray,"
  echo "    /etc/xray, menu /usr/bin/menu + script menu, /usr/bin/ipsave,"
  echo "    /usr/bin/cek-izin, /var/log/izin.log, /usr/bin/speedtest,"
  echo "    /etc/nginx/conf.d/xray.conf, /root/darren-install"
  echo "  - Node.js + npm (paket apt nodejs + npm) dan vnstat (+ data /var/lib/vnstat)"
  echo "Backup disalin dulu ke /root/darren-uninstall-backup-<waktu>/ (700;"
  echo "  file secret 600) — mencakup bot-js (termasuk data/bot.db), /etc/bot,"
  echo "  /etc/vpn-api, /etc/xray (termasuk file .db/limit/.txt akun di"
  echo "  dalamnya), drop-in xray, vpn-api.py, unit systemd, entry point"
  echo "  menu, dan file stack TLS. Backup GAGAL = uninstall BERHENTI"
  echo "  sebelum penghapusan apa pun."
  echo "CATATAN: backup TIDAK mengembalikan Node.js/PM2/vnstat yang terhapus."
  echo "  Restore = kembalikan file dari backup + install ulang (install.sh"
  echo "  akan memasang Node/PM2/vnstat lagi dari nol)."
  echo "Yang TIDAK dihapus: OS dasar, perkakas generik (curl, git, wget, unzip,"
  echo "  python3, sqlite3, openssl, ca-certificates, gnupg), konfigurasi/kunci"
  echo "  SSH, direktori backup lama, data aplikasi lain, repo apt NodeSource,"
  echo "  paket haproxy/nginx/at, /etc/haproxy/haproxy.cfg, /etc/nginx/nginx.conf,"
  echo "  /var/www/html, sertifikat LE, dan data acme.sh. Ini BUKAN wipe"
  echo "  total VPS."
  echo ""
  read -r -p "Ketik YA (huruf besar) untuk lanjut uninstall: " confirm || true
  if [ "$confirm" != "YA" ]; then
    echo "Dibatalkan. Tidak ada yang diubah."
    exit 0
  fi

  BAK="/root/darren-uninstall-backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BAK"
  chmod 700 "$BAK"
  # B2/B24/K23: backup fail-closed — TIDAK ada '|| true' / 'gagal, lanjut'
  # di jalur ini. Satu salinan gagal = exit 1 SEBELUM penghapusan apa pun.
  backup_uninstall_item() {
    local _src="$1" _base
    [ -e "$_src" ] || return 0
    cp -a "$_src" "$BAK/" || { echo "ERROR: backup $_src gagal — uninstall DIBATALKAN (tidak ada yang dihapus)." >&2; exit 1; }
    _base="$(basename "$_src")"
    if [ ! -e "$BAK/$_base" ]; then
      echo "ERROR: verifikasi backup $_src gagal — uninstall DIBATALKAN." >&2; exit 1
    fi
  }
  for d in /root/bot-js /etc/vpn-api /etc/xray /etc/systemd/system/xray.service.d /etc/bot /etc/ssh/.ssh.db /etc/vmess /etc/vless /etc/trojan /etc/shadowsocks; do
    backup_uninstall_item "$d"
  done
  # FASE 2: backup lebih lengkap — API, unit systemd, entry point menu, TLS.
  backup_uninstall_item /root/vpn-api.py
  backup_uninstall_item /etc/nginx/conf.d/xray.conf
  backup_uninstall_item /etc/haproxy/haproxy.cfg
  backup_uninstall_item /usr/bin/speedtest
  for _unit in vpn-api.service xray.service limitvmess.service limitvless.service limittrojan.service limitshadowsocks.service; do
    backup_uninstall_item "/etc/systemd/system/$_unit"
  done
  for _menu in menu cek-izin xray-restart; do
    backup_uninstall_item "/usr/bin/$_menu"
  done
  chmod 700 "$BAK" 2>/dev/null || true
  find "$BAK" -type f \( -name '.env' -o -name 'auth.env' -o -name 'izin-token' -o -name '*.db' -o -name '*.key' -o -name '*.pem' \) -exec chmod 600 {} + 2>/dev/null || true
  if [ ! -d "$BAK" ]; then
    echo "ERROR: verifikasi backup gagal (direktori backup hilang) — uninstall DIBATALKAN." >&2; exit 1
  fi
  if { [ -d /root/bot-js ] || [ -d /etc/xray ]; } && [ -z "$(ls -A "$BAK" 2>/dev/null)" ]; then
    echo "ERROR: verifikasi backup gagal (backup kosong padahal instalasi ada) — uninstall DIBATALKAN." >&2; exit 1
  fi
  # FASE 2: retensi — simpan 5 backup terbaru, hapus yang lebih lama.
  # Hanya direktori darren-*-backup-* di /root; tidak pernah yang lain.
  for _old in $(ls -dt /root/darren-*-backup-*/ 2>/dev/null | tail -n +6); do
    rm -rf "$_old"
  done
  echo "Backup di: $BAK"

  hapus_stack_darren

  echo ""
  echo "=== Selesai uninstall ==="
  echo "Backup: $BAK (700; file secret 600)"
  echo "Terhapus: stack Darren + Node.js/npm + PM2 (+startup, ~/.pm2) + vnstat"
  echo "  + speedtest + site TLS Darren (/etc/nginx/conf.d/xray.conf) + service"
  echo "  haproxy/nginx (dihentikan)."
  echo "Tidak dihapus: OS dasar, perkakas generik, konfigurasi/kunci SSH,"
  echo "  direktori backup lama, data aplikasi lain, repo apt NodeSource,"
  echo "  paket haproxy/nginx/at, /etc/haproxy/haproxy.cfg, /etc/nginx/nginx.conf,"
  echo "  /var/www/html, sertifikat LE, data acme.sh (bukan wipe total VPS)."
  echo "  Bila menu.zip tidak ditemukan tadi, periksa /usr/bin untuk sisa file"
  echo "  menu di luar daftar yang diketahui (lihat catatan di atas)."
  echo "Untuk install ulang: jalankan install.sh lagi (Node/PM2/vnstat akan"
  echo "  dipasang lagi dari nol)."
}

# Hanya jalan sebagai program utama; bila di-source (dipakai install.sh
# --total), hanya definisikan hapus_stack_darren tanpa menjalankan main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
