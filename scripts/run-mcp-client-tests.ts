/**
 * Boots Agent Kontrol in demo mode (no DATABASE_URL) and drives /api/mcp
 * with the official MCP client. Assertions live in tests/mcp/client.test.ts.
 *
 * Prior art: scripts/run-pg-tests.ts (a tsx script that owns process
 * lifecycle and fails closed) and tests/ui/mcp-tools.test.ts (the static
 * tool-name inventory). A hand-rolled JSON-RPC POST would skip the
 * initialize / notifications/initialized handshake, the mcp-session-id
 * header, and SSE body parsing, so it can pass while an agent client fails.
 *
 * The dev server is stopped on success, failure, timeout, and SIGINT/SIGTERM.
 * The run fails if the port still accepts connections afterwards.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";

const READY_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;
// Generated per run. The prefix is what makes it obviously fake; the suffix
// only keeps one developer's shell from matching a previous run.
const TOKEN = `ak-mcp-test-token-not-a-secret-${randomBytes(8).toString("hex")}`;

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agent-kontrol-mcp-ci", version: "0" },
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repoRoot(): string {
  const root = process.cwd();
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
  if (pkg.name !== "agent-kontrol") {
    throw new Error(`npm run test:mcp must run from the agent-kontrol repo root (cwd: ${root})`);
  }
  return root;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not bind a free port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (accepts: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(accepts);
    };
    socket.setTimeout(400);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function assertPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!(await portAccepts(port))) return;
    await sleep(100);
  }
  throw new Error(`port ${port} still accepts connections after the dev server was stopped`);
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  if (await waitForExit(child, 5_000)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
  }
  await waitForExit(child, 2_000);
}

function childEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MC_TOKEN: TOKEN,
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // Demo mode is "no DATABASE_URL". Set it empty (falsy, so still demo mode)
  // rather than deleting it: Next.js would otherwise load a developer's
  // .env.local database URL and this run could write to it.
  env.DATABASE_URL = "";
  return env;
}

async function waitUntilReady(url: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "no response yet";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `dev server exited before it was ready (code ${child.exitCode ?? child.signalCode})\n${logs()}`
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: INITIALIZE_BODY,
        signal: AbortSignal.timeout(Math.min(60_000, remaining)),
      });
      await response.arrayBuffer().catch(() => undefined);
      // 401 (auth gate up) or 200 (handler answered) means the route is
      // compiled. Whether that 200 should have been a 401 is the test's job.
      // Anything else, including a compile error, keeps waiting.
      if (response.status === 401 || response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`MCP server was not ready within ${READY_TIMEOUT_MS}ms (${lastError})\n${logs()}`);
}

function startDevServer(root: string, port: number, logs: string[]): ChildProcess {
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: root,
    env: childEnv(port),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const push = (chunk: Buffer | string) => {
    const text = String(chunk).split(TOKEN).join("[redacted-test-token]");
    for (const line of text.split("\n")) {
      if (!line) continue;
      logs.push(line);
    }
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("error", (error) => {
    logs.push(`dev server spawn error: ${error.message}`);
  });
  return child;
}

async function runAssertions(root: string, url: string): Promise<number> {
  const tsxBin = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const testFile = path.join(root, "tests", "mcp", "client.test.ts");
  const child = spawn(process.execPath, [tsxBin, "--test", "--test-timeout=60000", testFile], {
    cwd: root,
    env: { ...process.env, AK_MCP_BASE_URL: url, AK_MCP_TOKEN: TOKEN },
    stdio: "inherit",
  });
  const finished = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
  });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(1);
    }, TEST_TIMEOUT_MS);
  });
  const code = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`MCP client assertions failed (exit ${code})`);
  }
  return code;
}

async function main(): Promise<void> {
  const root = repoRoot();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/api/mcp`;
  const logs: string[] = [];
  const tail = () => logs.join("\n");
  const child = startDevServer(root, port, logs);
  let failure: unknown;
  let stopping = false;

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await stopChild(child);
  };

  const onSignal = () => {
    void shutdown().finally(() => process.exit(1));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await waitUntilReady(url, child, tail);
    await runAssertions(root, url);
  } catch (error) {
    failure = error;
  } finally {
    await shutdown();
    try {
      await assertPortClosed(port);
    } catch (error) {
      failure = failure
        ? new Error(`${failure instanceof Error ? failure.message : String(failure)}\n${error instanceof Error ? error.message : String(error)}`)
        : error;
    }
  }

  if (failure) {
    console.error(tail());
    throw failure;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
