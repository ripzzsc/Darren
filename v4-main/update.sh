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
cek_versi_baru() {
    # Mendapatkan versi terbaru dari URL update-cek
    versi_terbaru=$(curl -s https://raw.githubusercontent.com/ajijainalganteng-wq/v4/main/update-cek)

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
    if cek_versi_baru; then
        echo "Menjalankan update ke versi terbaru..."
        sleep 3
        fun_bar res1  # Menjalankan fungsi update jika versi baru terdeteksi
    else
        echo "Tidak ada update yang diperlukan."
    fi
}

# Fungsi progress bar
fun_bar() {
    CMD[0]="$1"
    (
        ${CMD[0]} -y >/dev/null 2>&1
        touch /tmp/selesai_update
    ) &
    tput civis
    echo -ne "  \033[0;33mPlease Wait Loading \033[1;37m- \033[0;33m["
    while true; do
        for ((i = 0; i < 18; i++)); do
            echo -ne "\033[0;32m#"
            sleep 0.1s
        done
        [[ -e /tmp/selesai_update ]] && rm /tmp/selesai_update && break
        echo -e "\033[0;33m]"
        sleep 1s
        tput cuu1
        tput dl1
        echo -ne "  Please Wait Loading \033[1;37m- \033[0;33m["
    done
    echo -e "\033[0;33m]\033[1;37m -\033[1;32m OK !\033[1;37m"
    tput cnorm
}

# Fungsi untuk download dan ekstraksi file update
res1() {
# Clear and recreate /usr/local/sbin
rm -r /usr/local/sbin >/dev/null 2>&1
mkdir -p /usr/bin/
wget https://raw.githubusercontent.com/arivpnstores/v4/main/Cdy/speedtest -O /usr/bin/speedtest
# Unduh file dari tautan pertama menggunakan wget
wget https://raw.githubusercontent.com/ajijainalganteng-wq/v4/main/Cdy/menu.zip -O menu.zip >/dev/null 2>&1
rm -rf /usr/bin/menu /usr/bin/welcome
#wget https://raw.githubusercontent.com/ajijainalganteng-wq/v4/main/enc
unzip menu.zip
chmod +x menu/*
#chmod +x enc
#./enc menu/*
#rm -rf menu/*~
mv menu/* /usr/bin/
rm -rf enc menu menu.zip 
# jarang update bash /usr/bin/install-bot.sh >/dev/null 2>&1
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

curl -s --max-time $TIME -d "chat_id=$CHATID&disable_web_page_preview=1&text=$TEXT&parse_mode=html" $URL >/dev/null
}

# Cek dan jalankan update jika ada
jalankan_update