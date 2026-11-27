# CONNECT to an allowed host through the proxy, then speak TLS with SNI/Host of another host.
import socket, ssl, sys
proxy_port, connect_host, sni_host = int(sys.argv[1]), sys.argv[2], sys.argv[3]
s = socket.create_connection(("127.0.0.1", proxy_port), timeout=10)
s.sendall(f"CONNECT {connect_host}:443 HTTP/1.1\r\nHost: {connect_host}:443\r\n\r\n".encode())
resp = s.recv(4096).split(b"\r\n")[0].decode()
print("proxy:", resp)
if " 200 " not in resp + " ":
    sys.exit(0)
ctx = ssl.create_default_context()
try:
    t = ctx.wrap_socket(s, server_hostname=sni_host)
    t.sendall(f"GET / HTTP/1.1\r\nHost: {sni_host}\r\nConnection: close\r\n\r\n".encode())
    data = t.recv(8192).decode("latin-1")
    print("upstream:", data.split("\r\n")[0], "| example-domain-body:", "Example Domain" in data or "example" in data.lower()[:2000])
except Exception as e:
    print("tls/http error:", type(e).__name__, str(e)[:120])
