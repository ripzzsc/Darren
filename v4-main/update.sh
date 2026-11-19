#!/bin/bash
# FIXED: remote overwrite is opt-in only.
if [ "${ALLOW_REMOTE_UPDATE:-0}" != "1" ]; then echo "Update remote ditolak: set ALLOW_REMOTE_UPDATE=1 untuk melanjutkan." >&2; exit 1; fi
# Tulis ulang .profile (timpa langsung, bukan hapus + append, supaya
# update yang diulang tidak menduplikasi isi dan tidak menghapus file
# yang mungkin sudah disesuaikan)
cat > /root/.profile << 'EOF'
if [ "/bin/bash" ]; then
  if [ -f ~/.bashrc ]; then
    . ~/.bashrc
  fi
fi
mesg n || true
welcome
EOF

# F-02: bila /etc/xray/config.json belum ada (VPS instalasi lama), hasilkan
# dari template repo (UUID seed diganti acak); lengkapi geoip.dat /
# geosite.dat bila belum ada, dan ganti geoip.dat bawaan Xray yang kecil
# (19 entri, tanpa US/CA/JP/IN/YT) dengan yang lengkap dari Loyalsoldier.
# Semua langkah idempotent: config yang sudah ada tidak pernah ditimpa.
if [ ! -f /etc/xray/config.json ] && [ -f /root/darren-install/v4-main/Cfg/config.json ]; then
  _uuid_baru="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "11111111-2222-3333-4444-555555555555")"
  sed "s/1d1c1d94-6987-4658-a4dc-8821a30fe7e0/$_uuid_baru/g" /root/darren-install/v4-main/Cfg/config.json > /etc/xray/config.json
  echo "config Xray dibuat di /etc/xray/config.json."
fi
if [ -x /usr/local/bin/xray ] && { [ ! -f /usr/local/bin/geoip.dat ] || [ ! -f /usr/local/bin/geosite.dat ]; }; then
  _xray_ver="$(/usr/local/bin/xray version 2>/dev/null | head -n 1 | awk '{print $2}')"
  if [ -n "$_xray_ver" ]; then
    curl -fsSL --max-time 120 "https://github.com/XTLS/Xray-core/releases/download/v$_xray_ver/Xray-linux-64.zip" -o /tmp/Xray-linux-64.zip 2>/dev/null \
      && unzip -qo -j /tmp/Xray-linux-64.zip geoip.dat geosite.dat -d /usr/local/bin/ 2>/dev/null
    rm -f /tmp/Xray-linux-64.zip
  fi
fi
if [ -f /usr/local/bin/geoip.dat ] && [ "$(stat -c %s /usr/local/bin/geoip.dat 2>/dev/null || echo 0)" -lt 10000000 ]; then
  curl -fsSL --max-time 120 https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat -o /tmp/geoip.dat 2>/dev/null \
    && mv /tmp/geoip.dat /usr/local/bin/geoip.dat
fi
if [ -f /etc/xray/config.json ] && [ -x /usr/local/bin/xray ]; then
  if /usr/local/bin/xray run -test -config /etc/xray/config.json >/dev/null 2>&1; then
    echo "config Xray valid (xray -test OK)."
    systemctl restart xray.service 2>/dev/null || true
  else
    echo "PERINGATAN: /etc/xray/config.json tidak lolos xray -test." >&2
  fi
fi

# I-17: update ikut menangani sertifikat + stack SSH-WS, supaya VPS lama
# yang nginx/haproxy-nya mati karena sertifikat belum ada (atau WS :443
# mati karena tls-router tidak ada) bisa sembuh lewat update.
_upd_healed=0
if [ -d /root/darren-install/v4-main/Cfg ] && [ -d /root/darren-install/v4-main/Fls ]; then
  for _py in tls-router ws-shield ws-bridge; do
    if [ -f "/root/darren-install/v4-main/Cfg/$_py.py" ] && [ ! -f "/usr/local/bin/$_py.py" ]; then
      cp "/root/darren-install/v4-main/Cfg/$_py.py" "/usr/local/bin/$_py.py"
      chmod +x "/usr/local/bin/$_py.py"
      echo "Stack WS: $_py.py dipasang."
    fi
    if [ -f "/root/darren-install/v4-main/Cfg/$_py.service" ] && [ ! -f "/etc/systemd/system/$_py.service" ]; then
      cp "/root/darren-install/v4-main/Cfg/$_py.service" "/etc/systemd/system/$_py.service"
    fi
  done
  if [ -f /root/darren-install/v4-main/Fls/ws ] && [ ! -f /usr/bin/ws ]; then
    cp /root/darren-install/v4-main/Fls/ws /usr/bin/ws
    chmod +x /usr/bin/ws
    echo "Stack WS: biner ws dipasang."
  fi
  if [ -f /root/darren-install/v4-main/Cfg/tun.conf ] && [ ! -f /usr/bin/tun.conf ]; then
    cp /root/darren-install/v4-main/Cfg/tun.conf /usr/bin/tun.conf
  fi
  if [ -f /root/darren-install/v4-main/Fls/ws.service ] && [ ! -f /etc/systemd/system/ws.service ]; then
    cp /root/darren-install/v4-main/Fls/ws.service /etc/systemd/system/ws.service
  fi
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable ws-shield.service ws-bridge.service tls-router.service ws.service 2>/dev/null || true
  for _svc in ws-shield ws-bridge ws tls-router; do
    systemctl is-active --quiet "$_svc.service" 2>/dev/null || systemctl restart "$_svc.service" 2>/dev/null || echo "PERINGATAN: $_svc gagal start." >&2
  done
fi
# Sertifikat: bila domain tersimpan dan sertifikat belum ada, terbitkan
# lewat acme.sh (pasang dulu dari sumber resmi bila belum ada).
if [ -f /etc/xray/domain ] && { [ ! -f /etc/xray/xray.crt ] || [ ! -f /etc/xray/xray.key ] || [ ! -f /etc/haproxy/hap.pem ]; }; then
  _upd_domain="$(cat /etc/xray/domain 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$_upd_domain" ]; then
    _upd_vps_ip="$(curl -fsSL --max-time 10 https://ifconfig.me 2>/dev/null | tr -d '[:space:]' || true)"
    _upd_domain_ip="$(nslookup "$_upd_domain" 8.8.8.8 2>/dev/null | awk '/^Address: / {print $2}' | tail -n1)"
    [ -z "$_upd_domain_ip" ] && _upd_domain_ip="$(getent hosts "$_upd_domain" 2>/dev/null | awk '{print $1}' | head -n1)"
    if [ -n "$_upd_vps_ip" ] && [ "$_upd_domain_ip" = "$_upd_vps_ip" ]; then
      if [ ! -x /root/.acme.sh/acme.sh ]; then
        echo "Memasang acme.sh resmi..."
        curl -fsSL --max-time 60 https://get.acme.sh -o /tmp/get.acme.sh 2>/dev/null && sh /tmp/get.acme.sh >/dev/null 2>&1 || echo "PERINGATAN: gagal memasang acme.sh resmi." >&2
        rm -f /tmp/get.acme.sh
      fi
      if [ -x /root/.acme.sh/acme.sh ]; then
        systemctl stop nginx haproxy 2>/dev/null || true
        /root/.acme.sh/acme.sh --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
        if /root/.acme.sh/acme.sh --issue --standalone -d "$_upd_domain" --keylength ec-256 >/dev/null 2>&1; then
          /root/.acme.sh/acme.sh --installcert -d "$_upd_domain" --fullchainpath /etc/xray/xray.crt --keypath /etc/xray/xray.key --ecc >/dev/null 2>&1 || true
          if [ -f "/root/.acme.sh/${_upd_domain}_ecc/fullchain.cer" ] && [ -f "/root/.acme.sh/${_upd_domain}_ecc/${_upd_domain}.key" ]; then
            cat "/root/.acme.sh/${_upd_domain}_ecc/fullchain.cer" "/root/.acme.sh/${_upd_domain}_ecc/${_upd_domain}.key" > /etc/haproxy/hap.pem
            chmod 600 /etc/xray/xray.key /etc/haproxy/hap.pem
            echo "Sertifikat Let's Encrypt untuk $_upd_domain terbit via update."
            _upd_healed=1
          fi
        else
          echo "PERINGATAN: acme.sh gagal menerbitkan sertifikat untuk $_upd_domain." >&2
        fi
      fi
    else
      echo "PERINGATAN: domain $_upd_domain belum mengarah ke IP VPS ini — sertifikat tidak diterbitkan." >&2
    fi
  fi
fi
# Bila sertifikat sudah ada tapi xray.conf masih versi TLS-pending
# (baris ssl dihapus installer lama), kembalikan xray.conf asli dari repo.
if [ -f /etc/xray/xray.crt ] && [ -f /etc/xray/xray.key ] && [ -f /root/darren-install/v4-main/Cfg/xray.conf ]; then
  if ! grep -q "ssl_certificate /etc/xray/xray.crt" /etc/nginx/conf.d/xray.conf 2>/dev/null; then
    cp /root/darren-install/v4-main/Cfg/xray.conf /etc/nginx/conf.d/xray.conf
    echo "xray.conf dikembalikan ke versi SSL (sertifikat sudah ada)."
    _upd_healed=1
  fi
fi
if [ "$_upd_healed" = "1" ]; then
  systemctl restart nginx 2>/dev/null || echo "PERINGATAN: nginx gagal restart setelah update." >&2
  if [ -f /etc/haproxy/hap.pem ]; then
    systemctl restart haproxy 2>/dev/null || echo "PERINGATAN: haproxy gagal restart setelah update." >&2
  fi
fi

# Fungsi untuk menambahkan pekerjaan cron ke /etc/cron.d/
    cron_file="/etc/cron.d/auto_update"
    pekerjaan_cron="15 1 * * * root /usr/bin/auto_update"

    # Periksa apakah pekerjaan cron sudah ada di file
    if ! grep -Fq "$pekerjaan_cron" "$cron_file" 2>/dev/null; then
        echo "$pekerjaan_cron" > "$cron_file"
    fi



# Fungsi untuk menambahkan pekerjaan cron ke /etc/cron.d/
    cron_file="/etc/cron.d/backup_otomatis"
    pekerjaan_cron="15 23 * * * root /usr/bin/backupfile"

    # Periksa apakah pekerjaan cron sudah ada di file
    if ! grep -Fq "$pekerjaan_cron" "$cron_file" 2>/dev/null; then
        echo "$pekerjaan_cron" > "$cron_file"
    fi

# Fungsi untuk menambahkan pekerjaan cron ke /etc/cron.d/
    cron_file="/etc/cron.d/delete_exp"
    pekerjaan_cron="0 3 */2 * * root /usr/bin/xp"

    # Periksa apakah pekerjaan cron sudah ada di file
    if ! grep -Fq "$pekerjaan_cron" "$cron_file" 2>/dev/null; then
        echo "$pekerjaan_cron" > "$cron_file"
    fi


# Fungsi untuk mengecek versi terbaru
# I-05/I-06: cek versi dari repo RESMI ripzzsc/Darren, fail-closed —
# gagal cek (jaringan mati/timeout/404) = update dibatalkan, bukan dipicu.
# Return: 0 = ada versi baru, 1 = sudah up-to-date, 2 = cek gagal.
cek_versi_baru() {
    # Mendapatkan versi terbaru dari URL update-cek
    versi_terbaru="$(curl -fsSL --max-time 20 https://raw.githubusercontent.com/ripzzsc/Darren/main/update-cek 2>/dev/null | tr -d '[:space:]' || true)"
    if [ -z "$versi_terbaru" ]; then
        echo "ERROR: gagal mengecek versi terbaru (repo tidak terjangkau). Update dibatalkan." >&2
        return 2
    fi

     # Check if /usr/bin/menu_version exists, if not create with version 1
  if [ ! -f /usr/bin/menu_version ]; then
    echo "1" > /usr/bin/menu_version
    echo "Version not found. Creating with version 1."
  fi
    # Versi saat ini (bisa disesuaikan dengan cara memperoleh versi lokal)
    versi_saat_ini=$(cat /usr/bin/menu_version)

    # Membandingkan versi terbaru dengan versi saat ini
    if [[ "$versi_terbaru" != "$versi_saat_ini" ]]; then
        echo "Versi baru tersedia: $versi_terbaru"
        return 0  # Ada versi baru
    else
        echo "Versi sudah up-to-date: $versi_saat_ini"
        return 1  # Tidak ada versi baru
    fi
}

# Fungsi untuk menjalankan update jika ada versi terbaru
jalankan_update() {
    local _st=0
    cek_versi_baru || _st=$?
    if [ "$_st" = 0 ]; then
        echo "Menjalankan update ke versi terbaru..."
        sleep 3
        if ! fun_bar res1; then
            echo "ERROR: update gagal — menu lama tetap dipakai." >&2
            return 1
        fi
    elif [ "$_st" = 2 ]; then
        echo "Pengecekan versi gagal — update dibatalkan (fail-closed)." >&2
        return 1
    else
        echo "Tidak ada update yang diperlukan."
    fi
}

# Fungsi progress bar
# I-05: laporkan hasil sebenarnya — "OK !" hanya bila perintah sukses,
# "GAGAL" bila exit code bukan 0. Marker basi dari run lama dihapus dulu.
fun_bar() {
    CMD[0]="$1"
    rm -f /tmp/selesai_update /tmp/selesai_update.rc
    (
        ${CMD[0]} -y >/dev/null 2>&1
        echo "$?" > /tmp/selesai_update.rc
        touch /tmp/selesai_update
    ) &
    tput civis
    echo -ne "  \033[0;33mPlease Wait Loading \033[1;37m- \033[0;33m["
    while true; do
        for ((i = 0; i < 18; i++)); do
            echo -ne "\033[0;32m#"
            sleep 0.1s
        done
        [[ -e /tmp/selesai_update ]] && rm -f /tmp/selesai_update && break
        echo -e "\033[0;33m]"
        sleep 1s
        tput cuu1
        tput dl1
        echo -ne "  Please Wait Loading \033[1;37m- \033[0;33m["
    done
    local _rc=0
    [ -f /tmp/selesai_update.rc ] && _rc="$(cat /tmp/selesai_update.rc)"
    rm -f /tmp/selesai_update.rc
    if [ "$_rc" = "0" ]; then
        echo -e "\033[0;33m]\033[1;37m -\033[1;32m OK !\033[1;37m"
    else
        echo -e "\033[0;33m]\033[1;37m -\033[1;31m GAGAL (kode $_rc) !\033[1;37m"
    fi
    tput cnorm
    return "$_rc"
}

# Fungsi untuk download dan ekstraksi file update
# I-05/I-06: unduh dari repo RESMI ripzzsc/Darren, VERIFIKASI dulu
# (zip valid + berisi file yang diharapkan) — BARU hapus yang lama.
# Gagal di langkah mana pun = batal, menu lama tetap utuh.
res1() {
local _tmpdir=""
_tmpdir="$(mktemp -d /tmp/darren-update-XXXXXX)" || { echo "ERROR: gagal membuat direktori sementara." >&2; return 1; }
# speedtest dari repo resmi.
if ! curl -fsSL --max-time 60 https://raw.githubusercontent.com/ripzzsc/Darren/main/v4-main/Cdy/speedtest -o "$_tmpdir/speedtest"; then
    echo "ERROR: gagal mengunduh speedtest dari ripzzsc/Darren." >&2
    rm -rf "$_tmpdir"
    return 1
fi
# Unduh menu.zip dari repo resmi.
if ! curl -fsSL --max-time 120 https://raw.githubusercontent.com/ripzzsc/Darren/main/v4-main/Cdy/menu.zip -o "$_tmpdir/menu.zip"; then
    echo "ERROR: gagal mengunduh menu.zip dari ripzzsc/Darren." >&2
    rm -rf "$_tmpdir"
    return 1
fi
if ! unzip -t "$_tmpdir/menu.zip" >/dev/null 2>&1; then
    echo "ERROR: menu.zip yang diunduh rusak (unzip -t gagal)." >&2
    rm -rf "$_tmpdir"
    return 1
fi
if ! unzip -l "$_tmpdir/menu.zip" | grep -q "menu/menu/menu" || ! unzip -l "$_tmpdir/menu.zip" | grep -q "menu/menu/fix-add-ssl"; then
    echo "ERROR: menu.zip tidak berisi file menu yang diharapkan." >&2
    rm -rf "$_tmpdir"
    return 1
fi
# Unduhan terverifikasi — baru hapus yang lama.
rm -rf /usr/bin/menu /usr/bin/welcome
mkdir -p /usr/bin/
cp "$_tmpdir/speedtest" /usr/bin/speedtest
chmod +x /usr/bin/speedtest
mkdir -p "$_tmpdir/extract"
unzip -qo "$_tmpdir/menu.zip" -d "$_tmpdir/extract"
find "$_tmpdir/extract" -type f -exec chmod +x {} +
find "$_tmpdir/extract" -type f -exec cp {} /usr/bin/ \;
# Izin: segarkan cek-izin dari repo (fail-soft) supaya perbaikan checker
# tidak tertimpa versi lama di menu.zip.
if curl -fsSL --max-time 15 https://raw.githubusercontent.com/ripzzsc/Darren/main/v4-main/Cdy/cek-izin -o "$_tmpdir/cek-izin.baru" 2>/dev/null && bash -n "$_tmpdir/cek-izin.baru" 2>/dev/null; then
  cp "$_tmpdir/cek-izin.baru" /usr/bin/cek-izin
  chmod +x /usr/bin/cek-izin
else
  echo "PERINGATAN: gagal menyegarkan cek-izin dari repo, memakai versi dari menu.zip." >&2
fi
rm -rf "$_tmpdir"
echo "$versi_terbaru" > /usr/bin/menu_version  # Update versi lokal
CHATID=$(grep -E "^#bot# " "/etc/bot/.bot.db" | cut -d ' ' -f 3)
KEY=$(grep -E "^#bot# " "/etc/bot/.bot.db" | cut -d ' ' -f 2)
TIME="10"
URL="https://api.telegram.org/bot$KEY/sendMessage"
TEXT="
<code>◇━━━━━━━━━━━━━━◇</code>
<b>  ⚠️UPDATE NOTIF⚠️</b>
<code>◇━━━━━━━━━━━━━━◇</code>
<code>Auto Update Script Done</code>
<code>Versi : $versi_terbaru</code>
<code>◇━━━━━━━━━━━━━━◇</code>
"'&reply_markup={"inline_keyboard":[[{"text":"ᴏʀᴅᴇʀ","url":"https://wa.me/AJIVPN"},{"text":"Contact","url":"https://wa.me/6287862591220"}]]}'

curl -s --max-time $TIME -d "chat_id=$CHATID&disable_web_page_preview=1&text=$TEXT&parse_mode=html" "$URL" >/dev/null
}

# Cek dan jalankan update jika ada
jalankan_update

# Auto-running: setelah update, pastikan semua service kembali jalan
# (coba restart sekali bila ada yang mati) dan laporkan yang masih mati.
# haproxy hanya dicek bila hap.pem ada (tanpa sertifikat ia memang belum bisa jalan).
_upd_mati=""
for _svc in xray nginx vpn-api tls-router ws ws-shield ws-bridge limitvmess limitvless limittrojan limitshadowsocks; do
  if [ -f "/etc/systemd/system/$_svc.service" ] || [ -f "/usr/lib/systemd/system/$_svc.service" ]; then
    if ! systemctl is-active --quiet "$_svc.service" 2>/dev/null; then
      systemctl restart "$_svc.service" 2>/dev/null || true
      sleep 1
      systemctl is-active --quiet "$_svc.service" 2>/dev/null || _upd_mati="$_upd_mati $_svc"
    fi
  fi
done
if [ -s /etc/haproxy/hap.pem ] && ! systemctl is-active --quiet haproxy 2>/dev/null; then
  systemctl restart haproxy 2>/dev/null || true
  sleep 1
  systemctl is-active --quiet haproxy 2>/dev/null || _upd_mati="$_upd_mati haproxy"
fi
if [ -n "$_upd_mati" ]; then
  echo "PERINGATAN: service masih mati setelah update:$_upd_mati — periksa 'systemctl status' masing-masing." >&2
else
  echo "Semua service jalan setelah update."
fi