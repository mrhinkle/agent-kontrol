"""akegress191 spike: allowlisting HTTPS CONNECT proxy (Python stdlib only).
Matching model: exact host (case-insensitive, one trailing dot stripped) on the CONNECT authority,
port 443 only, IP literals refused, every non-CONNECT method refused. SNI and Host are not inspected.
Usage: python3 -I akproxy.py <port> <logfile> <host>[,<host>...]
"""
import ipaddress, json, select, socket, subprocess, sys, threading, time

PORT, LOG, ALLOW = int(sys.argv[1]), sys.argv[2], {h.strip().lower() for h in sys.argv[3].split(",") if h.strip()}
lock = threading.Lock()

def log(**rec):
    rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with lock, open(LOG, "a") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")

def client_proc(cport):
    try:
        out = subprocess.run(["sudo", "-n", "ss", "-tnpH", "state", "established",
                              f"( sport = :{cport} and dport = :{PORT} )"],
                             capture_output=True, text=True, timeout=5).stdout
        return out.split("users:")[1].strip() if "users:" in out else "unknown"
    except Exception as e:
        return f"lookup-failed:{type(e).__name__}"

def deny(c, why, rec):
    body = f"akegress191-proxy denied: {why}\n".encode()
    c.sendall(b"HTTP/1.1 403 Forbidden\r\nX-AK-Proxy: deny\r\nContent-Type: text/plain\r\nContent-Length: "
              + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
    log(decision="deny", reason=why, upstream=None, **rec)

def handle(c, addr):
    rec = {"client": f"{addr[0]}:{addr[1]}", "proc": client_proc(addr[1])}
    try:
        c.settimeout(15)
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < 65536:
            d = c.recv(4096)
            if not d:
                return
            buf += d
        line = buf.split(b"\r\n", 1)[0].decode("latin-1")
        parts = line.split()
        method, target = (parts[0], parts[1]) if len(parts) >= 2 else ("?", "?")
        rec.update(method=method, target=target)
        if method != "CONNECT":
            return deny(c, "non-CONNECT method", rec)
        host, _, port = target.rpartition(":")
        host = host.strip("[]").lower().rstrip(".")
        rec["host"] = host
        try:
            ipaddress.ip_address(host)
            return deny(c, "IP literal", rec)
        except ValueError:
            pass
        if port != "443":
            return deny(c, "port not 443", rec)
        if host not in ALLOW:
            return deny(c, "host not in allowlist", rec)
        try:
            u = socket.create_connection((host, 443), timeout=10)
        except OSError as e:
            c.sendall(b"HTTP/1.1 502 Bad Gateway\r\nX-AK-Proxy: upstream-failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return log(decision="allow-upstream-failed", reason=type(e).__name__, upstream=None, **rec)
        rec["upstream"] = u.getpeername()[0]
        c.sendall(b"HTTP/1.1 200 Connection Established\r\nX-AK-Proxy: allow\r\n\r\n")
        log(decision="allow", reason="exact host match", **rec)
        socks = [c, u]
        c.settimeout(None); u.settimeout(None)
        while True:
            r, _, _ = select.select(socks, [], [], 60)
            if not r:
                break
            for s in r:
                d = s.recv(65536)
                if not d:
                    return
                (u if s is c else c).sendall(d)
    except Exception as e:
        log(decision="error", reason=type(e).__name__, upstream=None, **rec)
    finally:
        c.close()

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT)); srv.listen(64)
log(decision="start", reason=f"listening 127.0.0.1:{PORT} allow={sorted(ALLOW)}", upstream=None)
while True:
    conn, a = srv.accept()
    threading.Thread(target=handle, args=(conn, a), daemon=True).start()
