# Cfg — catatan versi perbaikan

File `config.json` di folder ini adalah TEMPLATE, bukan config Xray
yang valid untuk langsung dipakai. File itu mengandung marker
template sehingga parser JSON menolaknya. Jangan menyalinnya
langsung ke `/etc/xray/config.json`.

Pakai config yang dihasilkan menu/API di server, atau generate
config Xray yang valid dari template ini sebelum deploy.

Sejak 2026-11-18 installer (`install.sh`) menghasilkan
`/etc/xray/config.json` dari template ini saat instal baru (UUID seed
diganti acak tiap instalasi), dan melengkapi `geoip.dat` lengkap +
`geosite.dat` di `/usr/local/bin`; `update.sh` melakukan hal yang sama
bila config belum ada di VPS lama. Config yang sudah ada (berisi akun)
tidak pernah ditimpa.
