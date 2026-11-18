#!/bin/bash

green='\e[32m'
NC='\e[0m'
echo "📦 Mencoba install gdown dengan pip..."
if ! command -v gdown >/dev/null 2>&1 && ! pip install --break-system-packages gdown 2>/dev/null; then
  echo "⚠️ Gagal install gdown pakai pip."

  echo "🔄 Update dan install python3-pip..."
apt update && apt install -y python3-pip pipx

  echo "🔁 Coba ulang install gdown dengan pip3..."
if pip3 install --break-system-packages gdown 2>/dev/null || pipx install gdown 2>/dev/null; then
    echo "✅ Berhasil install gdown dengan pip3."
  else
    echo "❌ Gagal install gdown dengan pip3 juga!"
  fi

  echo "⬇️ Install wget sebagai alternatif..."
  apt install wget -y
else
  echo "✅ gdown berhasil diinstall dengan pip."
fi


 read -rp "Masukkan URL file backup (backup.zip): " backup_url

if [[ ! -f /root/backup.zip ]]; then
  echo -e "[ ${green}INFO${NC} ] • File /root/backup.zip tidak ditemukan. Mencoba download file backup.zip dari URL yang dimasukkan..."

  if [[ "$backup_url" == *"drive.google.com"* ]]; then
    # Ambil file ID dari URL Google Drive
    file_id=$(echo "$backup_url" | grep -oE '[-\w]{25,}' | head -n 1)
    if [[ -z "$file_id" ]]; then
      echo -e "[ ${green}ERROR${NC} ] • Tidak dapat mengambil file ID dari URL Google Drive."
      exit 1
    fi
    gdown --id "$file_id" -O /root/backup.zip
  else
    wget -O /root/backup.zip "$backup_url"
  fi

  _dl_rc=$?
  if [[ $_dl_rc -ne 0 ]]; then
    echo -e "[ ${green}ERROR${NC} ] • Gagal mendownload file backup.zip. Pastikan URL benar dan koneksi internet tersedia."
    exit 1
  fi

  echo -e "[ ${green}INFO${NC} ] • Download file backup.zip berhasil."
fi

BackupFile="/root/backup.zip"
# coba extract tanpa password
if ! command -v 7z >/dev/null 2>&1; then apt-get install -y p7zip-full unzip >/dev/null 2>&1 || true; fi
cd /root || exit 1
if ! 7z x "$BackupFile" >/dev/null 2>&1; then
    echo "Extract tanpa password gagal, mencoba dengan password..."
    if [ -z "$InputPass" ]; then
        read -rp "Masukkan password backup: " InputPass
    fi
    if ! 7z x -p"$InputPass" "$BackupFile" >/dev/null 2>&1; then
        if ! unzip -o -P "$InputPass" "$BackupFile" >/dev/null 2>&1; then
            echo "Gagal extract backup.zip, restore dibatalkan."
            exit 1
        fi
    fi
    echo "Restore berhasil dengan password."
else
    echo "Restore berhasil tanpa password."
fi

sleep 1

echo -e "[ ${green}INFO${NC} ] • Starting to restore data..."

sleep 1

if ! cd /root/backup; then
  echo "Direktori /root/backup tidak ditemukan! Restore dibatalkan, backup.zip dipertahankan."
  exit 1
fi
echo -e "[ ${green}INFO${NC} ] • Please Wait, Restoring In Process Now..."
sleep 1

cp passwd /etc/ &>/dev/null
echo -e "[ ${green}INFO${NC} ] • Restoring passwd data..."

cp group /etc/ &>/dev/null
echo -e "[ ${green}INFO${NC} ] • Restoring group data..."

cp shadow /etc/ &>/dev/null
echo -e "[ ${green}INFO${NC} ] • Restoring shadow data..."

cp gshadow /etc/ &>/dev/null
echo -e "[ ${green}INFO${NC} ] • Restoring gshadow data..."

mkdir -p /var/lib/kyt && cp -r kyt/. /var/lib/kyt/ &>/dev/null
mkdir -p /etc/xray && cp -r xray/. /etc/xray/ &>/dev/null
if [ -d html ]; then mkdir -p /var/www/html && cp -r html/. /var/www/html/ &>/dev/null; fi
cp .bot.db /etc/bot/ &>/dev/null
cp crontab /etc/ &>/dev/null
cp .ssh.db /etc/ssh/ &>/dev/null
cp .vmess.db /etc/vmess/ &>/dev/null
cp .vless.db /etc/vless/ &>/dev/null
cp .trojan.db /etc/trojan/ &>/dev/null
if [ -d qt ]; then mkdir -p /etc/limit && cp -rf qt/. /etc/limit/ &>/dev/null; fi
if [ -d limit ]; then mkdir -p /etc/kyt/limit && cp -r limit/. /etc/kyt/limit/ &>/dev/null; fi
cp banner.txt /etc/banner.txt &>/dev/null
mkdir -p /etc/ssh && cp -r ssh/. /etc/ssh/ &>/dev/null
mkdir -p /etc/xray && cp -r xray/. /etc/xray/ &>/dev/null
mkdir -p /etc/vmess && cp -r vmess/. /etc/vmess/ &>/dev/null
mkdir -p /etc/trojan && cp -r trojan/. /etc/trojan/ &>/dev/null
mkdir -p /etc/vless && cp -r vless/. /etc/vless/ &>/dev/null
[ -d shadowsocks ] && { mkdir -p /etc/shadowsocks /etc/shadowsock; cp -r shadowsocks/. /etc/shadowsocks/ &>/dev/null; cp -r shadowsocks/. /etc/shadowsock/ &>/dev/null; }
[ -d shadowsock ] && { mkdir -p /etc/shadowsock; cp -r shadowsock/. /etc/shadowsock/ &>/dev/null; }
[ -d shadowsocks-real ] && { mkdir -p /etc/shadowsocks; cp -r shadowsocks-real/. /etc/shadowsocks/ &>/dev/null; }
if [ -d haproxy ]; then mkdir -p /etc/haproxy && cp -r haproxy/. /etc/haproxy/ &>/dev/null; fi
if [ -d nginx ]; then mkdir -p /etc/nginx && cp -r nginx/. /etc/nginx/ &>/dev/null; fi
if [ -f dropbear-default ]; then mkdir -p /etc/default && cp dropbear-default /etc/default/dropbear &>/dev/null; fi
if [ -d dropbear-keys ]; then mkdir -p /etc/dropbear && cp -r dropbear-keys/. /etc/dropbear/ &>/dev/null; fi
if [ -f ws ]; then cp ws /usr/bin/ws &>/dev/null && chmod +x /usr/bin/ws; fi
if [ -f tun.conf ]; then cp tun.conf /usr/bin/tun.conf &>/dev/null; fi
if [ -d cron.d ]; then mkdir -p /etc/cron.d && cp -r cron.d/. /etc/cron.d/ &>/dev/null; fi
if [ -f bot-db/bot.db ]; then mkdir -p /root/bot-js/data && cp bot-db/bot.db /root/bot-js/data/bot.db && chmod 600 /root/bot-js/data/bot.db; fi
if [ -f bot-js.env ]; then mkdir -p /root/bot-js && cp bot-js.env /root/bot-js/.env && chmod 600 /root/bot-js/.env; fi
if [ -d vpn-api ]; then mkdir -p /etc/vpn-api && cp -r vpn-api/. /etc/vpn-api/ && [ -f /etc/vpn-api/auth.env ] && chmod 600 /etc/vpn-api/auth.env; fi
if [ -f vpn-api.py ]; then cp vpn-api.py /root/vpn-api.py; fi
if [ -f var.txt ]; then mkdir -p /usr/bin/kyt && cp var.txt /usr/bin/kyt/var.txt; fi
if [ -d systemd ]; then mkdir -p /etc/systemd/system && cp systemd/*.service /etc/systemd/system/ 2>/dev/null; systemctl daemon-reload 2>/dev/null || true; fi
chmod 600 /etc/shadow /etc/gshadow 2>/dev/null || true

echo -e "[ ${green}INFO${NC} ] • Restart service agar konfigurasi hasil restore aktif... "
if [ -x /usr/local/bin/xray ] && [ -f /etc/xray/config.json ]; then /usr/local/bin/xray run -test -config /etc/xray/config.json >/dev/null 2>&1 || echo "PERINGATAN: /etc/xray/config.json hasil restore gagal dites, xray tidak di-restart."; fi
for _svc in xray haproxy nginx dropbear ssh vpn-api; do systemctl restart "$_svc" >/dev/null 2>&1 || true; done
if command -v pm2 >/dev/null 2>&1 && [ -f /root/bot-js/app.js ]; then pm2 restart darren-bot >/dev/null 2>&1 || pm2 start /root/bot-js/app.js --name darren-bot >/dev/null 2>&1 || true; pm2 save >/dev/null 2>&1 || true; fi
rm -f /root/backup.zip 2>/dev/null || true
echo -e "[ ${green}INFO${NC} ] • Restore selesai!"
