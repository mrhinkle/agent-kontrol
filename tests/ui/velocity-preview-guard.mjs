/** Test-only guard. Armed for the preview CLI and for self-tests.
 *  Network, secret env reads, and capture writes fail the process.
 */
import fs from "node:fs";
import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import path from "node:path";

const MARKER = "velocity-preview-guard";
const SECRET_NAMES = [
  "MC_TOKEN", "MC_URL", "MC_DASHBOARD_PASSWORD", "DATABASE_URL",
  "GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY",
];

function deny(kind) {
  process.stderr.write(`${MARKER}: ${kind}\n`);
  process.exit(97);
}

function shouldArm() {
  const entry = process.argv[1] ?? "";
  if (entry.includes("pnpm")) return false;
  if (process.execArgv.includes("-e") || process.execArgv.includes("--eval")) return true;
  return process.argv.some((arg) => arg.includes("preview-velocity.ts"));
}

function arm() {
  if (!shouldArm()) return;
  if (globalThis[Symbol.for(MARKER)]) return;
  globalThis[Symbol.for(MARKER)] = true;

  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let first = args[0];
    let second = args[1];
    // Node passes the original arguments object through to Socket.prototype.connect.
    if (first && typeof first === "object" && "0" in first && !("port" in first) && !("host" in first) && !("hostname" in first) && !("path" in first)) {
      second = first[1];
      first = first[0];
    }
    let host = "";
    let ipc = false;
    if (typeof first === "string") ipc = true;
    else if (typeof first === "number") host = typeof second === "string" ? second : "127.0.0.1";
    else if (first && typeof first === "object") {
      if (typeof first.path === "string" && first.path.length > 0) ipc = true;
      else host = String(first.host ?? first.hostname ?? "") || "127.0.0.1";
    }
    if (!ipc) deny(`socket.connect ${host || "unknown"}`);
    return origConnect.apply(this, args);
  };
  tls.connect = function guardedTls() {
    deny("tls.connect");
  };
  dns.lookup = function guardedLookup(hostname) {
    deny(`dns.lookup ${String(hostname)}`);
  };
  dns.promises.lookup = function guardedPromiseLookup(hostname) {
    deny(`dns.lookup ${String(hostname)}`);
  };
  http.request = () => deny("http.request");
  http.get = () => deny("http.get");
  https.request = () => deny("https.request");
  https.get = () => deny("https.get");
  globalThis.fetch = () => deny("fetch");

  const secret = new Set(SECRET_NAMES);
  const realEnv = process.env;
  const envProxy = new Proxy(realEnv, {
    get(target, prop) {
      if (typeof prop === "string" && secret.has(prop)) deny(`env ${prop}`);
      return target[prop];
    },
    set(target, prop, value) {
      if (typeof prop === "string" && secret.has(prop)) deny(`env ${prop}`);
      target[prop] = value;
      return true;
    },
    has(target, prop) {
      if (typeof prop === "string" && secret.has(prop)) deny(`env ${prop}`);
      return Reflect.has(target, prop);
    },
  });
  Object.defineProperty(process, "env", { configurable: true, enumerable: true, get() { return envProxy; } });

  const capture = process.env.VELOCITY_PREVIEW_CAPTURE;
  const origOpen = fs.promises.open;
  fs.promises.open = async function guardedOpen(file, flags, ...rest) {
    if (capture && path.resolve(String(file)) === path.resolve(capture)) {
      const mode = String(flags ?? "r");
      const numericWrite = typeof flags === "number" && (flags & 0o3) !== 0;
      if (numericWrite || /[wax+]/.test(mode)) deny("capture write");
    }
    const base = path.basename(String(file ?? ""));
    if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env") || /credential/i.test(base)) deny("config read");
    return origOpen.call(this, file, flags, ...rest);
  };
}

arm();
