import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Mini poster (mrhinkle/agent-kontrol#82). Every failure exits 0.
 * Diagnostics never include the credential or the response body.
 */

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/watch-beat.sh");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/watch-beat.json");
const SECRET = "akc_watch_poster_secret_82_do_not_print";

function runPoster(
  env: Record<string, string | undefined>,
  stdin: string | Buffer,
  timeoutMs = 15000,
): Promise<{ code: number; out: string; err: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn("bash", [script], {
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("watch-beat.sh hung"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err, ms: Date.now() - start });
    });
    child.stdin.end(stdin);
  });
}

function listen(server: http.Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

describe("watch-beat.sh", () => {
  it("documents the env vars and the curl timeouts, and passes the credential by header file", () => {
    const source = fs.readFileSync(script, "utf8");
    assert.match(source, /WATCH_API_URL/);
    assert.match(source, /WATCH_CREDENTIAL/);
    assert.match(source, /--connect-timeout 5/);
    assert.match(source, /--max-time 10/);
    assert.match(source, /--header @"\$hdr"/);
    assert.doesNotMatch(source, /Authorization: Bearer \$\{?WATCH_CREDENTIAL/);
  });

  it("F10 loopback stub receives the exact payload", async () => {
    const payload = fs.readFileSync(fixture);
    const seen: { body: Buffer; authorization: string | undefined; type: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          body: Buffer.concat(chunks),
          authorization: req.headers.authorization,
          type: req.headers["content-type"],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    const port = await listen(server);
    try {
      const result = await runPoster(
        { WATCH_API_URL: `http://127.0.0.1:${port}/api/watch/beat`, WATCH_CREDENTIAL: SECRET },
        payload,
      );
      assert.equal(result.code, 0);
      assert.equal(result.out, "");
      assert.equal(result.err, "");
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].body, payload);
      assert.equal(seen[0].authorization, `Bearer ${SECRET}`);
      assert.equal(seen[0].type, "application/json");
      assert.equal(`${result.out}${result.err}`.includes(SECRET), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("F10 timeout, refused, non-2xx, and invalid success exit 0 without the credential or body", async () => {
    const payload = fs.readFileSync(fixture);

    const hanging = http.createServer(() => {
      /* leave the socket open so curl hits --max-time */
    });
    const hangPort = await listen(hanging);
    const psSamples: string[] = [];
    const sample = setInterval(() => {
      try {
        psSamples.push(execFileSync("ps", ["ax", "-o", "command="], { encoding: "utf8" }));
      } catch {
        /* the process list is a best-effort check */
      }
    }, 200);
    try {
      const timed = await runPoster(
        { WATCH_API_URL: `http://127.0.0.1:${hangPort}/api/watch/beat`, WATCH_CREDENTIAL: SECRET },
        payload,
        20000,
      );
      assert.equal(timed.code, 0);
      assert.equal(timed.err.trim(), "watch-beat: timeout");
      assert.equal(timed.out, "");
      assert.equal(timed.err.includes(SECRET), false);
      assert.ok(timed.ms < 15000, `timeout took ${timed.ms}ms`);
      assert.ok(timed.ms >= 5000, `returned before the connect bound: ${timed.ms}ms`);
      assert.equal(psSamples.join("\n").includes(SECRET), false);
    } finally {
      clearInterval(sample);
      hanging.closeAllConnections?.();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }

    const closed = createServer();
    const closedPort = await new Promise<number>((resolve, reject) => {
      closed.once("error", reject);
      closed.listen(0, "127.0.0.1", () => resolve((closed.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await runPoster(
      { WATCH_API_URL: `http://127.0.0.1:${closedPort}/api/watch/beat`, WATCH_CREDENTIAL: SECRET },
      payload,
    );
    assert.equal(refused.code, 0);
    assert.equal(refused.err.trim(), "watch-beat: connection refused");
    assert.equal(refused.err.includes(SECRET), false);

    const failing = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(SECRET);
    });
    const failPort = await listen(failing);
    try {
      const non2xx = await runPoster(
        { WATCH_API_URL: `http://127.0.0.1:${failPort}/api/watch/beat`, WATCH_CREDENTIAL: SECRET },
        payload,
      );
      assert.equal(non2xx.code, 0);
      assert.equal(non2xx.err.trim(), "watch-beat: non-2xx");
      assert.equal(`${non2xx.out}${non2xx.err}`.includes(SECRET), false);
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }

    const lying = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(SECRET);
    });
    const liePort = await listen(lying);
    try {
      const invalid = await runPoster(
        { WATCH_API_URL: `http://127.0.0.1:${liePort}/api/watch/beat`, WATCH_CREDENTIAL: SECRET },
        payload,
      );
      assert.equal(invalid.code, 0);
      assert.equal(invalid.err.trim(), "watch-beat: invalid success response");
      assert.equal(`${invalid.out}${invalid.err}`.includes(SECRET), false);
    } finally {
      await new Promise<void>((resolve) => lying.close(() => resolve()));
    }
  });

  it("F10 refuses a non-https non-loopback URL and still exits 0", async () => {
    const payload = fs.readFileSync(fixture);
    const started = Date.now();
    const refused = await runPoster(
      { WATCH_API_URL: "http://example.com/api/watch/beat", WATCH_CREDENTIAL: SECRET },
      payload,
      3000,
    );
    assert.equal(refused.code, 0);
    assert.equal(refused.err.trim(), "watch-beat: non-https url refused");
    assert.ok(Date.now() - started < 2000);
    assert.equal(refused.err.includes(SECRET), false);

    const disguised = await runPoster(
      { WATCH_API_URL: "http://127.0.0.1.evil/api/watch/beat", WATCH_CREDENTIAL: SECRET },
      payload,
      3000,
    );
    assert.equal(disguised.code, 0);
    assert.equal(disguised.err.trim(), "watch-beat: non-https url refused");

    const missing = await runPoster({ WATCH_API_URL: "", WATCH_CREDENTIAL: SECRET }, payload);
    assert.equal(missing.code, 0);
    assert.equal(missing.err.trim(), "watch-beat: missing WATCH_API_URL");

    const noCred = await runPoster(
      { WATCH_API_URL: "http://127.0.0.1:9/api/watch/beat", WATCH_CREDENTIAL: "" },
      payload,
    );
    assert.equal(noCred.code, 0);
    assert.equal(noCred.err.trim(), "watch-beat: missing WATCH_CREDENTIAL");

    for (const bad of ["", "[]", "{}{}", "not-json"]) {
      const invalid = await runPoster(
        { WATCH_API_URL: "http://127.0.0.1:9/api/watch/beat", WATCH_CREDENTIAL: SECRET },
        bad,
      );
      assert.equal(invalid.code, 0, bad);
      assert.equal(invalid.err.trim(), "watch-beat: invalid input");
      assert.equal(invalid.err.includes(SECRET), false);
    }
  });
});
