# Darren — v4-main (versi perbaikan)

Paket script jualan VPN (Xray/SSH/OpenVPN + bot Telegram) yang sudah
diperbaiki dari audit bug statis 2026-11-01. Lihat `BUGS-v4-main.md`
untuk daftar bug asli, dan `v4-main/CHANGELOG-FIXED.md` untuk daftar
perbaikan yang sudah diterapkan.

Versi installer: `fix-total-20261104-04` — penanda yang bisa di-grep
di header `install.sh` (`DARREN_INSTALLER_VERSION`). Bila isi
`install.sh` yang terunduh belum menyebut penanda itu, berarti cache
GitHub belum segar — tunggu beberapa menit lalu unduh ulang.

## Instalasi di VPS baru (sebagai root)

Repo ini saat ini PUBLIK; migrasi ke private + token masih rencana,
bukan fakta. Setelah repo di-private-kan oleh owner (rencana),
setiap install butuh token baca dari HP owner: GitHub -> token
read-only khusus repo Darren, masa berlaku pendek (buat token baru
per install). Token dipakai lewat env/prompt saat installer meminta —
JANGAN pernah menempel nilai token di perintah curl, chat, atau log
(nilai token di shell history = token bocor). Pola aman bila repo
sudah private: baca token ke variabel lewat prompt tersembunyi,
lalu pakai referensi variabel di header curl (bukan nilainya).

```bash
curl -fsSL https://raw.githubusercontent.com/ripzzsc/Darren/main/install.sh -o install.sh
chmod +x install.sh
./install.sh
```

Installer akan meminta token GitHub baca repo, domain, dan
konfigurasi opsional lewat prompt, membuat auth API acak, menginstal
VPN API + Xray + menu (praktis wajib: menjawab N membuat verifikasi
akhir gagal, jadi install dinyatakan gagal).
Bot Telegram (bot-js) TIDAK diinstal di awal secara default.
Instal bot nanti lewat menu: jalankan `menu`, pilih 9 (MENU BOTELE),
lalu m-bot -> Install Bot, dan isi BOT_TOKEN + ADMIN_ID di sana.
Atau jalankan langsung di VPS: `install-botjs`.
Bila mau bot langsung terinstal saat install awal, jalankan
`./install.sh --with-bot` — baru di mode itu BOT_TOKEN dan ADMIN_ID
ditanya di awal. BotVPN2 lama tidak diinstal secara default.

Bila kamu sudah meng-clone repo ini ke VPS, cukup jalankan
`./install.sh` dari root repo — installer akan memakai source lokal.

Untuk install total (menghapus semua instalasi SC lama dulu, dengan
backup): jalankan `./install.sh --total`. Tanpa flag itu, bila
instalasi lama ditemukan, installer akan bertanya dulu sebelum
menghapus total.

## Uninstall total (sebagai root)

Repo ini saat ini PUBLIK, jadi unduh uninstaller tidak butuh token.
Bila repo sudah di-private-kan (rencana), pakai pola aman yang sama
seperti install (token lewat variabel prompt, bukan nilai di perintah):

```bash
curl -fsSL https://raw.githubusercontent.com/ripzzsc/Darren/main/uninstall.sh -o uninstall.sh
chmod +x uninstall.sh
./uninstall.sh
```

Saat diminta konfirmasi, ketik `YA`. Script akan membackup dulu ke
`/root/darren-uninstall-backup-<waktu>/`, lalu menghapus bot (pm2),
service vpn-api dan xray, file aplikasi, menu utama termasuk
permission (`cek-izin` + log + cache), dan source installer.
Akun-akun ikut terhapus.

Yang JUGA dihapus sejak penguatan uninstall: node, npm, pm2
(global + daemon + startup + ~/.pm2), dan vnstat. Restore total
artinya kembalikan file backup + install ulang (Node/PM2/vnstat
dipasang lagi dari nol oleh installer).

Yang sengaja TIDAK dihapus: OS dasar, perkakas generik
(curl, git, wget, unzip, python3, sqlite3, openssl), repo apt
NodeSource, kunci/konfigurasi SSH, dan direktori backup. Entri server di
daftar izin permission tetap ada di repo (tidak mengganggu); hapus
barisnya dari `izin-install.txt` bila server itu tidak
dipakai lagi.

Bila isi `uninstall.sh` yang terunduh belum menyebut `cek-izin`,
berarti cache GitHub belum segar — tunggu beberapa menit lalu
unduh ulang.

## Permission menu (izin)

Izin menu dikendalikan penuh dari repo ini, bukan server luar.
Menu SSH memanggil helper [v4-main/Cdy/cek-izin](v4-main/Cdy/cek-izin)
di awal tiap script; helper yang sama juga ikut di dalam
`v4-main/Cdy/menu.zip` (terpasang ke `/usr/bin/cek-izin`).

Satu allowlist untuk install DAN menu, di
[izin-install.txt](izin-install.txt), format tiap baris: `IP|Nama`
(Nama opsional; IP saja tanpa `|` juga boleh). Baris `#` dan baris
kosong diabaikan. Tanpa tanggal expired, tanpa kolom STATUS.
Tambah server baru cukup tambah satu baris di file itu lalu push;
menu membaca file itu dari GitHub (cache 6 jam di VPS). IP yang
tidak ada di file itu = instalasi dan menu DITOLAK. Alasan penolakan
dicatat jelas, dan log auditnya ada di `/var/log/izin.log` di VPS.
Jangan taruh secret di file ini.
File [v4-main/Cdy/izin-servers.txt](v4-main/Cdy/izin-servers.txt)
berisi allowlist yang sama (cermin, agar menu lama tetap jalan).

Selama repo masih publik, `cek-izin` jalan tanpa token. Setelah repo
di-private-kan (rencana), `cek-izin` membaca allowlist memakai token
baca yang tersimpan di `/etc/xray/izin-token` (mode 600, hanya
root). Tanpa token setelah private, cek-izin gagal dengan pesan
yang menyebut token. VPS yang sudah terpasang sebelum repo private
tidak perlu install ulang; cukup pasang tokennya (input
tersembunyi, tidak tampil saat diketik):

```bash
read -rs -p "Token baca izin: " TOK; printf '%s' "$TOK" > /etc/xray/izin-token; chmod 600 /etc/xray/izin-token; unset TOK
```

Token baca izin bisa dicabut per server dari HP owner (cabut =
menu server itu berhenti setelah cache habis).

## Keamanan — baca dulu

- Repo ini saat ini PUBLIK; private + token adalah rencana migrasi,
  bukan fakta saat ini. Setelah repo di-private-kan, tanpa token baca
  dari owner tidak ada yang bisa mengunduh atau memakai script ini. Jangan pernah menaruh
  token, password, atau kunci privat di dalam repo, chat, atau log.
- Token bersifat revocable: token install pakai masa berlaku
  pendek (buat baru per install); token baca izin dicabut per
  server dari HP owner bila server itu tidak dipakai lagi.
- Kunci privat OpenVPN lama yang ada di zip asli SUDAH DIHAPUS
  dari versi ini, tapi karena zip lama pernah publik, kunci itu
  harus dianggap bocor. Generate PKI baru, jangan pakai kunci lama.
- API VPN hanya bind localhost (port 5890). Jangan dibuka ke publik.
- File zip lama (`v4-main (1).zip`) sengaja tidak lagi ada di
  branch ini, digantikan folder `v4-main/` yang sudah diperbaiki.
  Riwayat git lama masih berisi zip lama; membersihkan riwayat
  adalah langkah force-push terpisah yang butuh persetujuan pemilik.

## Stack TLS (haproxy + nginx) — dipasang installer

Installer memasang `haproxy` + `nginx` (plus `at` dan `iproute2`),
menyalin file `Cfg` repo ke lokasi sistem yang benar
(`haproxy.cfg` -> `/etc/haproxy/haproxy.cfg`,
`nginx.conf` -> `/etc/nginx/nginx.conf`,
`xray.conf` -> `/etc/nginx/conf.d/xray.conf`),
membuat `/var/www/html`, dan mengatur nginx `:81` melayani direktori
itu serta haproxy `:443` meneruskan ke backend nginx (WS `127.0.0.1:1010`).
Backend dropbear sudah dihapus dari `haproxy.cfg` (tidak ada fitur
yang memakainya; dropbear tidak diinstal).

Sertifikat Let's Encrypt diusahakan via acme.sh resmi. Bila DNS belum
mengarah, port 80 sibuk, atau unduhan/penerbitan acme gagal, installer
TIDAK gagal total: stack tetap terpasang, nginx `:81` berjalan HTTP
polos, dan status dilaporkan jelas sebagai **TLS pending**. Gate akhir
membedakan dua verdict terpisah: "Xray aktif" vs "VPN domain jalan".
Bila verdict kedua masih TLS pending, selesaikan langkah manual di
bagian "Pasca-install (wajib)" — jangan klaim VPN domain sudah jalan.

Xray dipin ke SATU rilis resmi `v26.10.31` (konstanta `XRAY_TAG_PIN`
di `install.sh`, bukan latest mengambang) dan digest SHA256 rilisnya
wajib lolos — digest tak tersedia/tak terparse = instalasi Xray
BERHENTI, bukan lanjut tanpa verifikasi.

## Kredensial opsional (layanan pihak ketiga)

Installer mem-prompt OPSIONAL (boleh kosong = fitur nonaktif, tidak
menggagalkan install) dan menyimpannya ke `.env` bot (600) bila diisi:

- Lisensi IP sewa (`GH_IP_TOKEN` + `GH_IP_OWNER`/`GH_IP_REPO`/`GH_IP_FILE`)
  — registry IP untuk fitur sewa, dioperasikan di luar VPS.
- `SIDOMPUL_API_KEY` — layanan cek kuota pihak ketiga.
- `HC_API_KEY` — layanan HTTP Custom pihak ketiga.
- CloudFront (`CF_DOMAIN`, `CF_VMESS_UUID`, `CF_VLESS_UUID`,
  `CF_TROJAN_PASSWORD`) — CDN pihak ketiga; UUID/password diteruskan
  ke origin sesuai setup server.

Semua itu BUKAN layanan Darren; kredensialnya milik penyedia
pihak ketiga tersebut, dan kekosongannya hanya menonaktifkan fitur
yang bersangkutan. `speedtest` disalin dari `v4-main/Cdy/` ke
`/usr/bin/speedtest` bila ada di repo, dan dihapus uninstaller.

Dependensi bot-js dipin lewat `v4-main/bot-js/package-lock.json`
(lockfile dibuat dari dependensi yang tercantum di `package.json`;
verifikasi `npm install`/`npm ci` di VPS live — termasuk build native
`sqlite3` — masih wajib saat tes live, lockfile ini belum diklaim
teruji end-to-end).

## Pasca-install (wajib)

Setelah installer selesai, SEMUA langkah manual yang tersisa ini
masih harus dikerjakan — installer tidak mengklaimnya sudah beres:

1. **TLS pending / change-domain.** Bila verdict "VPN domain" masih
   TLS pending: pastikan DNS domain sudah mengarah ke IP VPS,
   bebaskan port 80, lalu jalankan `change-domain` dari menu dan
   pastikan sertifikat terbit + haproxy `:443` aktif. Ulangi gate
   (nginx `-t`, haproxy `-c`, Xray listen) sampai verdict domain JALAN.
2. **Bot Telegram (bila dibutuhkan).** Instal lewat menu (menu 9 ->
   m-bot -> Install Bot) dan isi BOT_TOKEN + ADMIN_ID di sana.
   Kredensial opsional yang dikosongkan saat install bot (lisensi IP
   sewa, `SIDOMPUL_API_KEY`, `HC_API_KEY`, CloudFront) bisa diisi
   ulang dengan menjalankan `install-botjs` lagi — nilai lama yang
   sudah ada dipakai sebagai default bila dikosongkan. Kredensial
   pihak ketiga tidak pernah ditulis di repo/chat/log.
3. **SlowDNS / Noobz / Zivpn manual.** Ketiga stack itu TIDAK
   dipasang installer ini — pasang manual dari menu/script terkait
   bila dibutuhkan, dan uji masing-masing sebelum jualan.
4. **Sync PPOB + margin.** Jalankan Sync PPOB (Digiflazz) dulu,
   lalu set margin penjualan sebelum jualan — harga jual = modal +
   margin; margin yang belum diset berarti harga jual = modal.
5. **GH_TOKEN.** Token baca repo (bila repo sudah private) dibuat
   baru per install dari HP owner, masa berlaku pendek; jangan
   dipakai ulang lintas install dan jangan disimpan di file.
6. **Izin-token.** Token baca izin menu dipasang ke
   `/etc/xray/izin-token` (600) — wajib setelah repo private;
   tanpa itu menu berhenti membaca allowlist setelah cache habis.
7. **Uji live.** Trial di bot, satu akun tiap protokol, dan satu
   pembayaran nominal kecil sebelum jualan (lihat laporan fix-total
   untuk daftar yang masih butuh tes live).

## Dead code (hanya didokumentasikan, TIDAK dihapus)

Dari sudut installer, berikut ini tidak dipanggil/dipasang installer
— didokumentasikan saja, tidak dihapus, karena menu runtime mungkin
masih merujuk sebagian di antaranya (perlu verifikasi live sebelum
penghapusan apa pun):

- `v4-main/BotVPN2/` — bot lama, tidak diinstal secara default.
- `v4-main/Fls/` selain unit/script limit yang dipasang installer
  (limitvmess/vless/trojan/shadowsocks) — mis. `ws`, `openvpn`,
  `udp-mini`, `socks`, `sshd`, `nameserver` tidak dipasang installer.
- `v4-main/Cfg/slowdns.sh`, `v4-main/noobzvpn-install.sh`,
  `v4-main/udp.sh`, `v4-main/cf.sh`, `v4-main/fix-*.sh`,
  `v4-main/update*.sh` — script legacy/manual, bukan bagian installer.
- `v4-main/Bot/` dan `v4-main/Vpn/` — tree lama yang tidak disalin
  installer (yang disalin: `bot-js` + `Api/vpn-api.py` + `Cdy/menu.zip`
  + `Fls` limit + `Cfg` TLS/Xray).

## Struktur

- `install.sh` — installer VPS baru (bot TIDAK diinstal di awal secara default; pakai `--with-bot` bila mau bot langsung terinstal; dukung token repo private + token baca izin menu)
- `uninstall.sh` — uninstall total (backup dulu, lalu hapus bot, API, Xray, menu, permission)
- `v4-main/Cdy/cek-izin` — helper permission menu (juga di dalam menu.zip)
- `izin-install.txt` — daftar server yang diizinkan (IP|Nama, satu format untuk install dan menu)
- `v4-main/Cdy/izin-servers.txt` — cermin allowlist yang sama (untuk menu lama)
- `v4-main/install-bot.sh` — installer bot Telegram mandiri, dipanggil dari menu (juga terpasang sebagai `/usr/bin/install-botjs`)
- `v4-main/` — source yang sudah diperbaiki (bot-js, BotVPN2, Api, Cfg, Fls, Vpn, dll)
- `v4-main/CHANGELOG-FIXED.md` — apa yang diperbaiki dan apa yang belum
- `BUGS-v4-main.md` — laporan audit bug asli
