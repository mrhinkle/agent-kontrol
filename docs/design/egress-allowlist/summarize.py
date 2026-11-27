import json, re, sys, collections
# usage: summarize.py <strace> <stdout> <stderr>
st, so, se = sys.argv[1:4]
pat = re.compile(r'^(\d+) connect\(\d+, \{sa_family=AF_INET6?, sin6?_port=htons\((\d+)\).*?(?:inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)")[^)]*\)?.*?= (-?\d+)(?: (E[A-Z]+))?')
seen = collections.OrderedDict()
for line in open(st, errors="replace"):
    m = pat.match(line)
    if not m:
        continue
    pid, port, v4, v6, rv, err = m.groups()
    ip = v4 or v6
    if port in ("0", "65535"):
        continue
    key = (pid, ip, port, err or rv)
    seen[key] = seen.get(key, 0) + 1
for (pid, ip, port, res), n in list(seen.items())[:25]:
    print(f"  strace pid={pid} connect {ip}:{port} -> {res} x{n}")
out = open(so, errors="replace").read()
try:
    j = json.loads(out.strip().splitlines()[-1]) if out.strip() else None
except Exception:
    j = None
if isinstance(j, dict):
    keep = {k: j.get(k) for k in ("type", "subtype", "is_error", "terminal_reason", "result", "error", "message") if k in j}
    print("  stdout-json:", json.dumps(keep)[:400])
else:
    lines = [l for l in out.splitlines() if l.strip()]
    print("  stdout-tail:", " | ".join(lines[-4:])[:600])
err = " | ".join(l for l in open(se, errors="replace").read().splitlines() if l.strip())
print("  stderr:", err[:600])
