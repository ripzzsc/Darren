#!/usr/bin/env python3
"""VPN API for v4 bot-js (port 5890).
Default bind localhost only (VPN_API_HOST=127.0.0.1). Server remote
(installer --remote) mengikat 0.0.0.0 supaya bot utama bisa memanggil
API-nya lewat IP publik — dengan UFW yang hanya mengizinkan IP bot utama
ke port 5890, dan semua endpoint (kecuali /health) tetap wajib auth key.
Endpoints (GET, BotVPN2-style): /createshh /createvmess /createvless
/createtrojan /createss /renew /delete /createzivpn /countaccounts /health
Returns JSON {"status":"success"} or {"status":"error","message":...}.
Xray changes use the same marker-insertion pattern as the menu scripts
(#vmess, #vmessgrpc, #vless, #trojanws, #ssws) and are validated with
`xray run -test` before restart; on failure the backup is restored.
SSH uses useradd/chpasswd/chage, same as addssh.
"""
import json, os, re, shutil, subprocess, sys, threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

CFG = os.environ.get("VPN_API_CFG", "/etc/xray/config.json")
XRAY_BIN = os.environ.get("VPN_API_XRAY_BIN", "/usr/local/bin/xray")
RESTART_SCRIPT = os.environ.get("VPN_API_RESTART_SCRIPT", "")
DATA_DIR = os.environ.get("VPN_API_DATA_DIR", "")  # staging: ganti /etc/<proto> dan /etc/ssh, default produksi tetap /etc
AUTH = os.environ.get("VPN_API_AUTH", "")
PORT = int(os.environ.get("VPN_API_PORT", "5890"))
# Bind host: default localhost (aman). Server remote (installer --remote)
# memakai 0.0.0.0 supaya bot utama bisa memanggil API lewat IP publik.
HOST = os.environ.get("VPN_API_HOST", "127.0.0.1")

def run(cmd, **kw):
    # FIXED: never shell=True. Callers must pass a list.
    if isinstance(cmd, str):
        raise ValueError("shell commands are no longer allowed")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120, **kw)

def run_input(cmd, data, **kw):
    if isinstance(cmd, str):
        raise ValueError("shell commands are no longer allowed")
    return subprocess.run(cmd, input=data, capture_output=True, text=True, timeout=120, **kw)

def data_path(*parts):
    if DATA_DIR:
        return os.path.join(DATA_DIR, *parts)
    return os.path.join("/etc", *parts)

def ok():
    return {"status": "success"}

def err(msg):
    return {"status": "error", "message": msg}

def exp_date(days):
    # FIXED: invalid expiry is an error, not a silent 30-day fallback.
    try:
        d = int(days)
    except Exception:
        raise ValueError("exp tidak valid")
    if d <= 0 or d > 3650:
        raise ValueError("exp tidak valid")
    return (date.today() + timedelta(days=d)).isoformat()

def exp_date_from(old, days):
    # FASE 1: renew menambah hari ke expiry LAMA (atau hari ini bila sudah
    # lewat), bukan selalu dari hari ini — renew awal tidak boleh memangkas
    # sisa masa aktif yang sudah dibayar. old=None (tidak terbaca) = error.
    if not old:
        raise ValueError("expiry lama tidak ditemukan, renew gagal")
    try:
        d = int(days)
    except Exception:
        raise ValueError("exp tidak valid")
    if d <= 0 or d > 3650:
        raise ValueError("exp tidak valid")
    today = date.today().isoformat()
    base = old if old > today else today
    return (date.fromisoformat(base) + timedelta(days=d)).isoformat()

def exp_date_or_err(q):
    try:
        return exp_date(q.get("exp"))
    except ValueError as e:
        return None, str(e)

def valid_user(u):
    return bool(re.match(r"^[a-zA-Z0-9]{3,20}$", u or ""))

def valid_password(pw):
    # chpasswd uses user:password lines, so colon/newline would break it.
    return bool(pw) and "\n" not in pw and "\r" not in pw and ":" not in pw

def valid_iplimit(v):
    try:
        n = int(v)
    except Exception:
        return False
    return 1 <= n <= 100

def xray_test():
    r = run([XRAY_BIN, "run", "-test", "-c", CFG])
    return "Configuration OK" in (r.stdout + r.stderr)

def xray_restart():
    # Staging/test override: a script that restarts the staging xray
    # process (PID file) and exits 0 only if xray is alive afterwards.
    # Production default stays systemctl.
    if RESTART_SCRIPT:
        r = run([RESTART_SCRIPT])
        return r.returncode == 0
    run(["systemctl", "restart", "xray"])
    r = run(["systemctl", "is-active", "xray"])
    return r.stdout.strip() == "active"

# --- Debounced restart: many account changes in one burst must NOT
# restart xray once per account (that drops every connected user).
# change_xray() only edits + validates the file, then schedules ONE
# restart 2 seconds after the LAST change in the burst. If that restart
# fails, the pre-burst backup is restored and xray is restarted again;
# the failure is logged to stderr (API already returned success, so the
# caller must still check that xray is active after ~3s).
_restart_lock = threading.Lock()
_config_lock = threading.Lock()
_restart_timer = None
_restart_backup = None

def schedule_restart():
    global _restart_timer, _restart_backup
    with _restart_lock:
        if _restart_backup is None:
            _restart_backup = CFG + ".bak-api"
        if _restart_timer is not None:
            _restart_timer.cancel()
        _restart_timer = threading.Timer(5.0, _do_restart)
        _restart_timer.daemon = True
        _restart_timer.start()

def _do_restart():
    global _restart_timer, _restart_backup
    with _restart_lock:
        _restart_timer = None
        backup = _restart_backup
        _restart_backup = None
    # Hold config lock so no create/renew/delete can edit the file
    # while xray is restarting from it (previous race: restart loaded
    # a half-written config, failed, and restored the pre-burst backup,
    # wiping accounts created in the same burst).
    with _config_lock:
        try:
            if not xray_restart():
                print("[vpn-api] restart gagal, kembalikan backup", flush=True)
                if backup:
                    shutil.copy(backup, CFG)
                xray_restart()
        except Exception as e:
            print(f"[vpn-api] restart error: {e}", flush=True)

def insert_xray(marker, comment, client_line):
    """Insert comment+client after marker line; return True if marker found."""
    with open(CFG) as f:
        lines = f.readlines()
    for i, line in enumerate(lines):
        if line.strip() == marker:
            lines[i + 1:i + 1] = [comment + "\n", client_line + "\n"]
            with open(CFG, "w") as f:
                f.writelines(lines)
            return True
    return False

def user_absent(user):
    """True jika tak ada lagi komentar maupun klien email user di config."""
    with open(CFG) as f:
        cfg = f.read()
    if re.search(r"(^### |^## |^#& |^#! |^#!! )" + re.escape(user) + r" ", cfg, re.M):
        return False
    return ('"email": "%s"' % user) not in cfg


def remove_xray_user(user):
    """Hapus komentar + baris klien milik user saja (fix 2026-10-27).

    - Baris sesudah komentar hanya dimakan bila benar baris klien user
      itu (mengandung email-nya); kalau bukan, baris itu dipertahankan.
    - Baris klien compact (},{...}) tanpa komentar ikut dihapus.
    - True bila ada baris KLIEN yang dihapus, atau komentar dihapus
      padahal kliennya sudah tidak ada (stale comment). False bila
      tidak ada yang bisa dihapus.
    """
    with open(CFG) as f:
        lines = f.readlines()
    email_pat = '"email": "%s"' % user
    has_client = any(email_pat in ln for ln in lines)
    out = []
    skip_next = False
    removed_client = False
    removed_comment = False
    for line in lines:
        if skip_next:
            skip_next = False
            if email_pat in line:
                removed_client = True
                continue
            out.append(line)
            continue
        if re.search(r"(^### |^## |^#& |^#! |^#!! )" + re.escape(user) + r" ", line):
            skip_next = True
            removed_comment = True
            continue
        if line.lstrip().startswith('},{') and email_pat in line:
            removed_client = True
            continue
        out.append(line)
    if removed_client or (removed_comment and not has_client):
        with open(CFG, "w") as f:
            f.writelines(out)
        return True
    return False
def change_xray(fn):
    with _config_lock:
        # Keep the pre-burst backup for the debounced restart thread; do not
        # overwrite it with an intermediate config while a restart is pending.
        with _restart_lock:
            pending = _restart_timer is not None
        if not pending:
            try:
                shutil.copy(CFG, CFG + ".bak-api")
            except OSError:
                # CFG belum ada (instalasi lama sebelum F-02 diperbaiki):
                # kembalikan error JSON, jangan biarkan handler mati
                # tanpa balasan.
                return err("config xray tidak ditemukan")
        try:
            res = fn()
        except Exception as e:
            shutil.copy(CFG + ".bak-api", CFG)
            return err(str(e))
        if res is not True:
            shutil.copy(CFG + ".bak-api", CFG)
            return res if isinstance(res, dict) else err("marker tidak ditemukan")
        if not xray_test():
            shutil.copy(CFG + ".bak-api", CFG)
            return err("validasi xray gagal, config dikembalikan")
        schedule_restart()
        return ok()

def create_ssh(q):
    user, pw, exp, iplimit = q.get("user"), q.get("password"), q.get("exp"), q.get("iplimit", "1")
    if not valid_user(user) or not valid_password(pw):
        return err("user/password tidak valid")
    if not valid_iplimit(iplimit):
        iplimit = "1"
    try:
        expd = exp_date(exp)
    except ValueError as e:
        return err(str(e))
    r = run(["id", user])
    if r.returncode == 0:
        return err("user sudah ada")
    r = run(["useradd", "-e", expd, "-s", "/bin/false", "-M", user])
    if r.returncode != 0:
        return err("useradd gagal: " + (r.stderr or "")[:200])
    r = run_input(["chpasswd"], f"{user}:{pw}\n")
    if r.returncode != 0:
        run(["userdel", "-f", user])
        return err("chpasswd gagal")
    _ssh_dir = data_path("ssh") if DATA_DIR else "/etc/ssh"
    _ip_dir = data_path("kyt/limit/ssh/ip") if DATA_DIR else "/etc/kyt/limit/ssh/ip"
    os.makedirs(_ssh_dir, exist_ok=True)
    os.makedirs(_ip_dir, exist_ok=True)
    with open(os.path.join(_ssh_dir, ".ssh.db"), "a") as f:
        f.write(f"#ssh# {user} {pw} 0 {iplimit} {expd}\n")
    with open(os.path.join(_ip_dir, user), "w") as f:
        f.write(str(iplimit) + "\n")
    return ok()

def create_xray_proto(kind, q):
    user, exp = q.get("user"), q.get("exp")
    if not valid_user(user):
        return err("user tidak valid")
    try:
        expd = exp_date(exp)
    except ValueError as e:
        return err(str(e))
    # FIXED: reject duplicates (previously SSH checked, Xray did not).
    try:
        with open(CFG) as _f:
            _cfg = _f.read()
        if ('"email": "%s"' % user) in _cfg:
            return err("user sudah ada")
    except OSError:
        pass
    if kind == "vmess":
        uuid = q.get("uuid")
        if not uuid:
            return err("uuid kosong")
        # Client line must start with },{ to close the dummy client, as menu does.
        def fn2():
            a = insert_xray("#vmess", f"### {user} {expd}", '},{"id": "%s","alterId": 0,"email": "%s"' % (uuid, user))
            b = insert_xray("#vmessgrpc", f"## {user} {expd}", '},{"id": "%s","alterId": 0,"email": "%s"' % (uuid, user))
            return a  # gRPC optional; WS is the tested path
        res = change_xray(fn2)
        if res.get("status") == "success":
            os.makedirs(data_path("vmess"), exist_ok=True)
            with open(data_path("vmess", ".vmess.db"), "a") as f:
                f.write(f"### {user} {expd} {uuid} 100 1\n")
        return res
    if kind == "vless":
        uuid = q.get("uuid")
        if not uuid:
            return err("uuid kosong")
        def fn():
            return insert_xray("#vless", f"#& {user} {expd}", '},{"id": "%s","email": "%s"' % (uuid, user))
        res = change_xray(fn)
        if res.get("status") == "success":
            os.makedirs(data_path("vless"), exist_ok=True)
            with open(data_path("vless", ".vless.db"), "a") as f:
                f.write(f"### {user} {expd} {uuid} 100 1\n")
        return res
    if kind == "trojan":
        pw = q.get("password")
        if not pw or "\n" in pw or "\r" in pw:
            return err("password tidak valid")
        def fn():
            return insert_xray("#trojanws", f"#! {user} {expd}", '},{"password": "%s","email": "%s"' % (pw, user))
        res = change_xray(fn)
        if res.get("status") == "success":
            os.makedirs(data_path("trojan"), exist_ok=True)
            with open(data_path("trojan", ".trojan.db"), "a") as f:
                f.write(f"### {user} {expd} {pw} 100 1\n")
        return res
    if kind == "ss":
        pw = q.get("password")
        if not pw or "\n" in pw or "\r" in pw:
            return err("password tidak valid")
        def fn():
            return insert_xray("#ssws", f"#!! {user} {expd}", '},{"password": "%s","method": "aes-256-gcm","email": "%s"' % (pw, user))
        res = change_xray(fn)
        if res.get("status") == "success":
            os.makedirs(data_path("shadowsocks"), exist_ok=True)
            with open(data_path("shadowsocks", ".shadowsocks.db"), "a") as f:
                f.write(f"### {user} {expd} {pw}\n")
        return res
    return err("proto tidak dikenal")

def renew(q):
    proto, user, exp = q.get("proto"), q.get("user"), q.get("exp")
    try:
        days = int(exp)
        if days <= 0 or days > 3650:
            raise ValueError("exp tidak valid")
    except Exception:
        return err("exp tidak valid")
    if proto == "ssh":
        if not valid_user(user):
            return err("username tidak valid")
        r = run(["id", user])
        if r.returncode != 0:
            return err("user ssh tidak ada")
        # FASE 1: baca expiry lama dari .ssh.db (sumber yang sama dengan
        # yang ditulis renew ini); bila tidak bisa dibaca, GAGAL eksplisit
        # — jangan diam-diam pakai today+days (itu memangkas sisa masa).
        old = None
        try:
            _p = data_path("ssh", ".ssh.db") if DATA_DIR else "/etc/ssh/.ssh.db"
            for _ln in open(_p).read().splitlines():
                _parts = _ln.split()
                if len(_parts) >= 6 and _parts[0] == "#ssh#" and _parts[1] == user:
                    old = _parts[-1]
                    break
                if len(_parts) >= 5 and _parts[0] == "###" and _parts[1] == user:
                    old = _parts[4]
                    break
        except Exception:
            old = None
        try:
            expd = exp_date_from(old, days)
        except ValueError as e:
            return err(str(e))
        r = run(["usermod", "-e", expd, user])
        if r.returncode != 0:
            return err("user ssh tidak ada")
        try:
            p = data_path("ssh", ".ssh.db") if DATA_DIR else "/etc/ssh/.ssh.db"
            ls = open(p).read().splitlines(True)
            out = []
            for ln in ls:
                parts = ln.split()
                if len(parts) >= 6 and parts[0] == "#ssh#" and parts[1] == user:
                    parts[-1] = expd
                    ln = " ".join(parts) + "\n"
                elif len(parts) >= 5 and parts[0] == "###" and parts[1] == user:
                    parts[4] = expd
                    ln = " ".join(parts) + "\n"
                out.append(ln)
            open(p, "w").writelines(out)
        except Exception:
            pass
        return ok()
    # Xray: update comment date lines for this user (expiry is menu-side only)
    if not os.path.exists(CFG):
        return err("config xray tidak ditemukan")
    with _config_lock:
        with open(CFG) as f:
            txt = f.read()
        # FASE 1: expiry lama dibaca dari baris komentar config yang sama
        # dengan yang ditulis renew ini; tambah hari ke yang TERBESAR
        # antara expiry lama dan hari ini. Bila tidak ditemukan, gagal
        # eksplisit (jangan today+days diam-diam).
        _m = re.search(r"(^### |^## |^#& |^#! |^#!! )" + re.escape(user) + r" (\d{4}-\d{2}-\d{2})", txt, flags=re.M)
        if not _m:
            return err("user tidak ditemukan, renew gagal")
        try:
            expd = exp_date_from(_m.group(2), days)
        except ValueError as e:
            return err(str(e))
        txt2 = re.sub(r"(^### |^## |^#& |^#! |^#!! )" + re.escape(user) + r" \d{4}-\d{2}-\d{2}",
                      r"\g<1>" + user + " " + expd, txt, flags=re.M)
        if txt2 == txt:
            return err("user tidak ditemukan, renew gagal")
        with _restart_lock:
            pending = _restart_timer is not None
        if not pending:
            shutil.copy(CFG, CFG + ".bak-api")
        with open(CFG, "w") as f:
            f.write(txt2)
        if not xray_test():
            shutil.copy(CFG + ".bak-api", CFG)
            return err("validasi xray gagal")
        schedule_restart()
    # FIXED: keep per-protocol db expiry in sync with config comments.
    _dbmap = {"vmess": data_path("vmess", ".vmess.db"), "vless": data_path("vless", ".vless.db"), "trojan": data_path("trojan", ".trojan.db"), "ss": data_path("shadowsocks", ".shadowsocks.db")}
    if proto in _dbmap:
        try:
            _pp = _dbmap[proto]
            _lns = open(_pp).read().splitlines(True)
            _out = []
            for _ln in _lns:
                _parts = _ln.split()
                if len(_parts) >= 3 and _parts[0] == "###" and _parts[1] == user:
                    _parts[2] = expd
                    _ln = " ".join(_parts) + "\n"
                _out.append(_ln)
            open(_pp, "w").writelines(_out)
        except OSError:
            pass
    return ok()

def delete(q):
    proto, user = q.get("proto"), q.get("user")
    if not valid_user(user):
        return err("username tidak valid")
    if proto == "ssh":
        run(["userdel", "-f", user])
        # bersihkan .ssh.db: cocok persis kolom login (kolom ke-2)
        try:
            _db = data_path("ssh", ".ssh.db") if DATA_DIR else "/etc/ssh/.ssh.db"
            with open(_db) as f:
                dblines = f.readlines()
            with open(_db, "w") as f:
                for dl in dblines:
                    parts = dl.split()
                    if len(parts) >= 2 and parts[1] == user:
                        continue
                    f.write(dl)
        except OSError:
            pass
        _ip = data_path("kyt/limit/ssh/ip", user) if DATA_DIR else f"/etc/kyt/limit/ssh/ip/{user}"
        run(["rm", "-f", _ip])
        r = run(["id", user])
        return ok() if r.returncode != 0 else err("user SSH masih ada")
    def fn():
        return remove_xray_user(user)
    res = change_xray(fn)
    # .db per-proto hanya dibersihkan bila config memastikan user tiada
    if user_absent(user):
        dbmap = {"vmess": data_path("vmess", ".vmess.db"), "vless": data_path("vless", ".vless.db"), "trojan": data_path("trojan", ".trojan.db"), "ss": data_path("shadowsocks", ".shadowsocks.db")}
        if proto in dbmap:
            try:
                pp = dbmap[proto]
                lns = open(pp).read().splitlines(True)
                open(pp, "w").writelines([x for x in lns if user not in x.split()])
            except Exception:
                pass
        return ok()
    if res.get("status") == "success":
        return err("klien Xray masih ada sesudah hapus")
    return res

def count_accounts():
    # FASE 2: hitung akun dari config yang dilayani server ini (cerminan
    # logika countAccounts bot-js, dipindah ke sisi server agar benar di
    # multi-server). File hilang/rusak = 0 untuk protokol itu, bukan error.
    counts = {"ssh": 0, "vmess": 0, "vless": 0, "trojan": 0, "shadowsocks": 0, "total": 0}
    try:
        sysusers = set()
        with open("/etc/passwd") as f:
            for line in f:
                p = line.split(":")
                if len(p) >= 3 and p[0] != "nobody":
                    try:
                        uid = int(p[2])
                    except ValueError:
                        continue
                    if uid >= 1000:
                        sysusers.add(p[0])
    except OSError:
        sysusers = set()
    try:
        names = set()
        with open("/etc/ssh/.ssh.db") as f:
            for raw in f:
                t = raw.strip()
                if t.startswith("###") or t.startswith("#ssh#"):
                    parts = t.split()
                    if len(parts) >= 2 and parts[1] in sysusers:
                        names.add(parts[1])
        counts["ssh"] = len(names)
    except OSError:
        pass
    try:
        with open(CFG) as f:
            lines = f.readlines()
        clean = "\n".join(l for l in lines if not l.strip().startswith("#"))
        parsed = json.loads(clean)
        sets = {"vmess": set(), "vless": set(), "trojan": set(), "shadowsocks": set()}
        for ib in parsed.get("inbounds", []):
            if ib.get("protocol") in sets:
                for cl in (ib.get("settings") or {}).get("clients", []):
                    if cl.get("email"):
                        sets[ib["protocol"]].add(cl["email"])
        for k, s in sets.items():
            counts[k] = len(s)
    except Exception:
        pass
    counts["total"] = sum(counts[k] for k in ("ssh", "vmess", "vless", "trojan", "shadowsocks"))
    body = ok()
    body["counts"] = counts
    return body


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        p = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(p.query).items()}
        if p.path != "/health" and (not AUTH or qs.get("auth") != AUTH):
            # FIXED: empty AUTH used to mean "no auth at all". Now it
            # means "refuse everything except health".
            body = err("auth salah / belum dikonfigurasi")
        elif p.path == "/health":
            body = ok()
        elif p.path == "/createshh":
            body = create_ssh(qs)
        elif p.path == "/createvmess":
            body = create_xray_proto("vmess", qs)
        elif p.path == "/createvless":
            body = create_xray_proto("vless", qs)
        elif p.path == "/createtrojan":
            body = create_xray_proto("trojan", qs)
        elif p.path == "/createss":
            body = create_xray_proto("ss", qs)
        elif p.path == "/renew":
            body = renew(qs)
        elif p.path == "/delete":
            body = delete(qs)
        elif p.path == "/countaccounts":
            body = count_accounts()
        elif p.path == "/createzivpn":
            body = err("zivpn memakai API terpisah di port 5888, bukan API ini")
        else:
            body = err("endpoint tidak dikenal")
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
