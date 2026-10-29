import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_TIMEOUT_MS,
  RETRY_DELAY_MS,
  SUPPRESS_MS,
  createNotifier,
  decideSends,
  evaluateSources,
  freshState,
  interpretSlackResponse,
  interpretTelegramResponse,
  loadConfig,
  parseBeatsResponse,
  parseJsonBody,
  readBeatsWithRetry,
  redact,
  runWatch,
} from "../../scripts/watch-check.mjs";

/**
 * Host watcher (mrhinkle/agent-kontrol#83).
 * Suppression boundary: resend when now >= lastDeliveredAt + 12h.
 * One millisecond earlier stays suppressed.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/watch-check.mjs");
const workflowPath = path.join(root, ".github/workflows/watch.yml");
const configPath = path.join(root, "scripts/watch.config.json");
const T0 = Date.parse("2026-10-29T12:00:00.000Z");

const sources = [
  { source: "mini", max_age_s: 2700, enabled: true },
  { source: "macbook", max_age_s: 93600, enabled: false },
];

function row(overrides: Record<string, unknown> = {}) {
  return {
    source: "mini",
    status: "ok",
    detail: "",
    beat_at: "2026-10-27T12:00:00.000Z",
    received_at: "2026-10-29T12:00:00.000Z",
    age_s: 0,
    ...overrides,
  };
}

function beats(list: Record<string, unknown>[]) {
  return { ok: true as const, beats: list };
}

function delivered(iso: string, pending = false) {
  return { lastDeliveredAt: iso, pending, recoveryPending: false };
}

type Note = { destination: string; text: string; timeoutMs: number };
type Written = { version: number; alerts: Record<string, { lastDeliveredAt: string | null; pending: boolean }> };

function harness(overrides: Record<string, unknown> = {}) {
  const notes: Note[] = [];
  const posts: unknown[] = [];
  const writes: Written[] = [];
  const logs: string[] = [];
  const { stateStore: stateOverride, ...rest } = overrides;
  const options = {
    config: { sources },
    destinations: ["slack"] as string[],
    now: T0,
    secrets: [] as string[],
    log: (line: string) => logs.push(line),
    notify: async (msg: Note) => {
      notes.push(msg);
      return { ok: true };
    },
    postBeat: async (beat: unknown) => {
      posts.push(beat);
      return { ok: true };
    },
    stateStore: {
      read: async () => null as string | null,
      write: async (state: Written) => {
        writes.push(state);
      },
      ...(stateOverride as object | undefined),
    },
    readResult: beats([row()]),
    ...rest,
  };
  return { options, notes, posts, writes, logs };
}

describe("watch response validation", () => {
  it("rejects malformed JSON", () => {
    assert.equal(parseJsonBody("{").ok, false);
    assert.equal(parseJsonBody("").ok, false);
  });

  it("rejects a non-object body", () => {
    assert.equal(parseBeatsResponse(null).ok, false);
    assert.equal(parseBeatsResponse([]).ok, false);
    assert.equal(parseBeatsResponse("beats").ok, false);
  });

  it("rejects beats that are not an array", () => {
    assert.equal(parseBeatsResponse({}).ok, false);
    assert.equal(parseBeatsResponse({ beats: {} }).ok, false);
    assert.equal(parseBeatsResponse({ beats: null }).ok, false);
  });

  it("rejects a row with a bad field type", () => {
    assert.equal(parseBeatsResponse({ beats: [row({ status: 1 })] }).ok, false);
    assert.equal(parseBeatsResponse({ beats: [row({ detail: null })] }).ok, false);
    assert.equal(parseBeatsResponse({ beats: [row({ source: "" })] }).ok, false);
    assert.equal(parseBeatsResponse({ beats: [row({ age_s: "1" })] }).ok, false);
    assert.equal(parseBeatsResponse({ beats: [row({ beat_at: 1 })] }).ok, false);
    assert.equal(parseBeatsResponse({ beats: ["mini"] }).ok, false);
  });

  it("rejects a negative age_s", () => {
    assert.equal(parseBeatsResponse({ beats: [row({ age_s: -1 })] }).ok, false);
  });

  it("rejects a NaN or infinite age_s", () => {
    assert.equal(parseBeatsResponse({ beats: [row({ age_s: Number.NaN })] }).ok, false);
    assert.equal(parseBeatsResponse({ beats: [row({ age_s: Number.POSITIVE_INFINITY })] }).ok, false);
  });

  it("rejects a duplicate source as a read failure", () => {
    const parsed = parseBeatsResponse({ beats: [row({ source: "mini" }), row({ source: "mini", status: "failing" })] });
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.reason, "duplicate-source");
  });
});

describe("watch source evaluation", () => {
  it("loads mini at 2700 enabled and macbook at 93600 disabled", () => {
    const loaded = loadConfig(fs.readFileSync(configPath, "utf8"));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.deepEqual(loaded.config.sources, sources);
  });

  it("alerts when an expected source is missing", () => {
    const findings = evaluateSources([], sources);
    assert.deepEqual(findings, [{ source: "mini", condition: "source-missing" }]);
  });

  it("treats age equal to max_age_s as healthy for ok", () => {
    const findings = evaluateSources([row({ status: "ok", age_s: 2700 })], sources);
    assert.deepEqual(findings, []);
  });

  it("treats age equal to max_age_s as healthy for held", () => {
    const findings = evaluateSources([row({ status: "held", age_s: 2700 })], sources);
    assert.deepEqual(findings, []);
  });

  it("treats ok one second past max_age_s as stale", () => {
    const findings = evaluateSources([row({ status: "ok", age_s: 2701 })], sources);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].condition, "stale");
    assert.equal(findings[0].source, "mini");
  });

  it("treats held one second past max_age_s as stale", () => {
    const findings = evaluateSources([row({ status: "held", age_s: 2701 })], sources);
    assert.equal(findings[0].condition, "stale");
  });

  it("treats status stale as unhealthy at any age", () => {
    const findings = evaluateSources([row({ status: "stale", age_s: 0 })], sources);
    assert.deepEqual(findings, [{ source: "mini", condition: "unhealthy:stale" }]);
    const over = evaluateSources([row({ status: "stale", age_s: 99999 })], sources);
    assert.equal(over[0].condition, "unhealthy:stale");
  });

  it("treats status failing as unhealthy at any age", () => {
    const findings = evaluateSources([row({ status: "failing", age_s: 1 })], sources);
    assert.deepEqual(findings, [{ source: "mini", condition: "unhealthy:failing" }]);
  });

  it("treats status paused as unhealthy at any age", () => {
    const findings = evaluateSources([row({ status: "paused", age_s: 1 })], sources);
    assert.deepEqual(findings, [{ source: "mini", condition: "unhealthy:paused" }]);
  });

  it("treats status unknown as unhealthy at any age", () => {
    const findings = evaluateSources([row({ status: "unknown", age_s: 1 })], sources);
    assert.deepEqual(findings, [{ source: "mini", condition: "unhealthy:unknown" }]);
  });

  it("ignores an unknown extra source", () => {
    const findings = evaluateSources(
      [row({ status: "ok", age_s: 1 }), row({ source: "laptop", status: "failing", age_s: 0 })],
      sources,
    );
    assert.deepEqual(findings, []);
  });

  it("excludes watcher from the host loop", () => {
    const withSelf = [
      ...sources,
      { source: "watcher", max_age_s: 3600, enabled: true },
    ];
    const findings = evaluateSources(
      [row({ status: "ok", age_s: 1 }), row({ source: "watcher", status: "failing", age_s: 99999 })],
      withSelf,
    );
    assert.deepEqual(findings, []);
  });

  it("does not alert on a disabled macbook, present or missing", () => {
    const present = evaluateSources([row({ source: "macbook", status: "failing", age_s: 0 })], sources);
    assert.deepEqual(present, [{ source: "mini", condition: "source-missing" }]);
    const onlyMac = evaluateSources([row({ source: "macbook", status: "ok", age_s: 1 })], sources);
    assert.equal(onlyMac[0].condition, "source-missing");
    assert.equal(onlyMac.some((finding: { source: string }) => finding.source === "macbook"), false);
  });

  it("ignores sender clocks two days behind and two days ahead", () => {
    const behind = evaluateSources(
      [row({ status: "ok", age_s: 10, beat_at: "2026-10-27T12:00:00.000Z" })],
      sources,
    );
    const ahead = evaluateSources(
      [row({ status: "ok", age_s: 10, beat_at: "2026-10-31T12:00:00.000Z" })],
      sources,
    );
    assert.deepEqual(behind, []);
    assert.deepEqual(ahead, []);
    const freshStampOldAge = evaluateSources(
      [row({ status: "ok", age_s: 2701, beat_at: "2026-10-29T12:00:00.000Z" })],
      sources,
    );
    assert.equal(freshStampOldAge[0].condition, "stale");
  });
});

describe("watch alert decisions", () => {
  it("sends the first alert for a new fault", () => {
    const plan = decideSends({
      readOk: true,
      findings: [{ source: "mini", condition: "source-missing" }],
      state: freshState(),
      now: T0,
      destinations: ["slack", "telegram"],
    });
    assert.deepEqual(
      plan.actions.map((action: { key: string; text: string }) => [action.key, action.text]),
      [
        ["slack|mini|source-missing", "watch-source-missing:mini"],
        ["telegram|mini|source-missing", "watch-source-missing:mini"],
      ],
    );
  });

  it("suppresses a repeat inside 12 hours", () => {
    const iso = new Date(T0).toISOString();
    const plan = decideSends({
      readOk: true,
      findings: [{ source: "mini", condition: "stale" }],
      state: { version: 1, alerts: { "slack|mini|stale": delivered(iso) } },
      now: T0 + SUPPRESS_MS - 1,
      destinations: ["slack"],
    });
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.suppressedKeys, ["slack|mini|stale"]);
  });

  it("resends at exactly lastDeliveredAt + 12h and suppresses 1ms earlier", () => {
    const iso = new Date(T0).toISOString();
    const state = { version: 1, alerts: { "slack|mini|stale": delivered(iso) } };
    const finding = [{ source: "mini", condition: "stale" }];
    const before = decideSends({
      readOk: true,
      findings: finding,
      state,
      now: T0 + SUPPRESS_MS - 1,
      destinations: ["slack"],
    });
    const at = decideSends({
      readOk: true,
      findings: finding,
      state,
      now: T0 + SUPPRESS_MS,
      destinations: ["slack"],
    });
    assert.equal(before.actions.length, 0);
    assert.equal(at.actions.length, 1);
    assert.equal(at.actions[0].kind, "alert");
    assert.equal(at.actions[0].key, "slack|mini|stale");
  });

  it("sends one recovery per destination that received the alert, then stops", async () => {
    let stored: string | null = null;
    const notes: Note[] = [];
    const base = {
      config: { sources },
      destinations: ["slack", "telegram"],
      now: T0,
      log: () => {},
      stateStore: {
        read: async () => stored,
        write: async (state: Written) => {
          stored = JSON.stringify(state);
        },
      },
      postBeat: async () => ({ ok: true }),
      notify: async (msg: Note) => {
        notes.push(msg);
        return { ok: msg.destination !== "slack" };
      },
    };
    const fault = await runWatch({
      ...base,
      readResult: beats([row({ status: "failing", age_s: 0 })]),
    });
    assert.equal(fault, 1);
    assert.deepEqual(
      notes.map((note) => note.destination),
      ["slack", "telegram"],
    );
    notes.length = 0;
    const recovered = await runWatch({
      ...base,
      now: T0 + 1000,
      readResult: beats([row({ status: "ok", age_s: 1 })]),
    });
    assert.equal(recovered, 0);
    assert.deepEqual(
      notes.map((note) => [note.destination, note.text]),
      [["telegram", "watch recovered:mini unhealthy:failing"]],
    );
    notes.length = 0;
    const again = await runWatch({
      ...base,
      now: T0 + 2000,
      readResult: beats([row({ status: "ok", age_s: 1 })]),
    });
    assert.equal(again, 0);
    assert.deepEqual(notes, []);
  });

  it("retries only the channel whose delivery failed", async () => {
    let stored: string | null = null;
    const notes: Note[] = [];
    const run = (now: number) =>
      runWatch({
        config: { sources },
        destinations: ["slack", "telegram"],
        now,
        log: () => {},
        readResult: beats([row({ status: "paused", age_s: 0 })]),
        stateStore: {
          read: async () => stored,
          write: async (state: Written) => {
            stored = JSON.stringify(state);
          },
        },
        postBeat: async () => ({ ok: true }),
        notify: async (msg: Note) => {
          notes.push(msg);
          return { ok: msg.destination !== "slack" };
        },
      });
    assert.equal(await run(T0), 1);
    const after = JSON.parse(stored ?? "{}") as Written;
    assert.equal(after.alerts["slack|mini|unhealthy:paused"].pending, true);
    assert.equal(after.alerts["slack|mini|unhealthy:paused"].lastDeliveredAt, null);
    assert.equal(after.alerts["telegram|mini|unhealthy:paused"].pending, false);
    notes.length = 0;
    assert.equal(await run(T0 + 1000), 1);
    assert.deepEqual(
      notes.map((note) => note.destination),
      ["slack"],
    );
  });

  it("treats Telegram HTTP 200 with ok false as delivery failure", async () => {
    const direct = interpretTelegramResponse({ status: 200, body: JSON.stringify({ ok: false, description: "UNIQUEBODY" }) });
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, "not-ok");
    const logs: string[] = [];
    const httpCalls: { timeoutMs: number; url: string }[] = [];
    const notify = createNotifier({
      credentials: { slackWebhook: "https://hooks.slack.com/services/T/B/X", telegramToken: "999:TELEGRAMSECRET83", telegramChat: "1" },
      secrets: ["999:TELEGRAMSECRET83", "https://hooks.slack.com/services/T/B/X"],
      log: (line: string) => logs.push(line),
      http: async (req: { timeoutMs: number; url: string }) => {
        httpCalls.push(req);
        return { status: 200, body: JSON.stringify({ ok: false, description: "UNIQUEBODY" }) };
      },
    });
    const sent = await notify({ destination: "telegram", text: "watch-api-unreachable", timeoutMs: DELIVERY_TIMEOUT_MS });
    assert.equal(sent.ok, false);
    assert.equal(httpCalls[0].timeoutMs, 10_000);
    assert.equal(logs.join("\n").includes("UNIQUEBODY"), false);
    assert.equal(logs.join("\n").includes("TELEGRAMSECRET83"), false);
  });

  it("treats a non-2xx Slack response as delivery failure and hides the body", async () => {
    assert.equal(interpretSlackResponse({ status: 500, body: "UNIQUEBODY" }).ok, false);
    assert.equal(interpretSlackResponse({ status: 204, body: "" }).ok, true);
    const logs: string[] = [];
    const notify = createNotifier({
      credentials: { slackWebhook: "https://hooks.slack.com/services/T83/B83/SECRET83HOOK" },
      secrets: ["https://hooks.slack.com/services/T83/B83/SECRET83HOOK"],
      log: (line: string) => logs.push(line),
      http: async () => ({ status: 500, body: "UNIQUEBODY" }),
    });
    const sent = await notify({ destination: "slack", text: "hi", timeoutMs: 10_000 });
    assert.equal(sent.ok, false);
    assert.equal(logs.join("\n").includes("UNIQUEBODY"), false);
    assert.equal(logs.join("\n").includes("SECRET83HOOK"), false);
  });
});

describe("watch read retry and failed reads", () => {
  it("retries a failed read once after 30 seconds and evaluates the success", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const { options, notes } = harness({
      readResult: undefined,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      request: async () => {
        calls += 1;
        if (calls === 1) return { status: 503, body: "down" };
        return { status: 200, body: JSON.stringify({ beats: [row({ status: "failing", age_s: 3 })] }) };
      },
    });
    const code = await runWatch(options);
    assert.equal(code, 1);
    assert.deepEqual(sleeps, [RETRY_DELAY_MS]);
    assert.equal(RETRY_DELAY_MS, 30_000);
    assert.equal(calls, 2);
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /unhealthy:failing/);
    const direct = await readBeatsWithRetry({
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      request: async () => ({ status: 200, body: JSON.stringify({ beats: [] }) }),
    });
    assert.equal(direct.ok, true);
    assert.equal(sleeps.length, 1);
  });

  it("emits only api-unreachable when both reads fail and keeps prior host state", async () => {
    const sleeps: number[] = [];
    const prior = {
      version: 1,
      alerts: { "slack|mini|stale": delivered(new Date(T0).toISOString()) },
    };
    const { options, notes, writes } = harness({
      state: prior,
      readResult: undefined,
      destinations: ["slack", "telegram"],
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      request: async () => ({ status: 500, body: "no" }),
    });
    const code = await runWatch(options);
    assert.equal(code, 1);
    assert.deepEqual(sleeps, [30_000]);
    assert.deepEqual(
      notes.map((note) => note.text),
      ["watch-api-unreachable", "watch-api-unreachable"],
    );
    const host = writes[0].alerts["slack|mini|stale"];
    assert.equal(host.lastDeliveredAt, new Date(T0).toISOString());
    assert.equal(host.pending, false);
    assert.equal(Object.keys(writes[0].alerts).some((key) => key.includes("source-missing")), false);
  });
});

describe("watch state and exit", () => {
  it("starts from an empty history when the cache is missing and alerts the current fault", async () => {
    const { options, notes, writes } = harness({
      stateStore: { read: async () => null },
      readResult: beats([row({ status: "unknown", age_s: 0 })]),
    });
    const code = await runWatch(options);
    assert.equal(code, 1);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text.includes("recovered"), false);
    assert.equal(writes[0].alerts["slack|mini|unhealthy:unknown"].pending, false);
  });

  it("starts fresh on a corrupt cache and does not invent a recovery", async () => {
    const logs: string[] = [];
    const notes: Note[] = [];
    const code = await runWatch({
      config: { sources },
      destinations: ["slack"],
      now: T0,
      log: (line: string) => logs.push(line),
      stateText: "{",
      readResult: beats([row({ status: "ok", age_s: 1 })]),
      notify: async (msg: Note) => {
        notes.push(msg);
        return { ok: true };
      },
      postBeat: async () => ({ ok: true }),
      stateStore: {
        read: async () => {
          throw new Error("read should not run when stateText is set");
        },
        write: async () => {},
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(notes, []);
    assert.match(logs.join("\n"), /corrupt/);
  });

  it("persists state when the exit code is nonzero", async () => {
    const { options, writes } = harness({
      readResult: beats([row({ status: "failing", age_s: 0, detail: "PAYLOAD_MARKER" })]),
      notify: async () => ({ ok: false }),
    });
    const code = await runWatch(options);
    assert.equal(code, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].alerts["slack|mini|unhealthy:failing"].pending, true);
    assert.equal(JSON.stringify(writes[0]).includes("PAYLOAD_MARKER"), false);
  });

  it("exits nonzero for an unhealthy source even when the message is suppressed", async () => {
    const iso = new Date(T0).toISOString();
    const notes: Note[] = [];
    const writes: Written[] = [];
    const code = await runWatch({
      config: { sources },
      destinations: ["slack"],
      now: T0 + 5_000,
      log: () => {},
      state: { version: 1, alerts: { "slack|mini|stale": delivered(iso) } },
      readResult: beats([row({ status: "ok", age_s: 2701 })]),
      notify: async (msg: Note) => {
        notes.push(msg);
        return { ok: true };
      },
      postBeat: async () => ({ ok: true }),
      stateStore: {
        read: async () => null,
        write: async (state: Written) => {
          writes.push(state);
        },
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(notes, []);
    assert.equal(writes.length, 1);
  });

  it("exits nonzero when delivery fails", async () => {
    const { options } = harness({
      readResult: beats([row({ status: "failing", age_s: 0 })]),
      notify: async () => ({ ok: false }),
    });
    assert.equal(await runWatch(options), 1);
  });

  it("exits nonzero when the watcher beat fails to store and reports it", async () => {
    const notes: Note[] = [];
    const code = await runWatch({
      config: { sources },
      destinations: ["slack"],
      now: T0,
      log: () => {},
      readResult: beats([row({ status: "ok", age_s: 1 })]),
      notify: async (msg: Note) => {
        notes.push(msg);
        return { ok: true };
      },
      postBeat: async () => ({ ok: false }),
      stateStore: { read: async () => null, write: async () => {} },
    });
    assert.equal(code, 1);
    assert.deepEqual(
      notes.map((note) => note.text),
      ["watch beat-post-failed"],
    );
  });

  it("posts the watcher beat from this run's clock with monitor health, not host health", async () => {
    const { options, posts } = harness({
      readResult: beats([row({ status: "failing", age_s: 0 })]),
    });
    await runWatch(options);
    const beat = posts[0] as { source: string; status: string; beat_at: string; detail: string };
    assert.equal(beat.source, "watcher");
    assert.equal(beat.status, "ok");
    assert.equal(beat.beat_at, new Date(T0).toISOString());
    assert.match(beat.detail, /^read=ok delivery=ok$/);
  });
});

describe("watch dry-run and redaction", () => {
  it("dry-run performs no send, beat POST, or state write", async () => {
    let sends = 0;
    let posts = 0;
    let writes = 0;
    const code = await runWatch({
      config: { sources },
      destinations: ["slack", "telegram"],
      now: T0,
      dryRun: true,
      log: () => {},
      readResult: beats([row({ status: "failing", age_s: 0 })]),
      notify: async () => {
        sends += 1;
        return { ok: true };
      },
      postBeat: async () => {
        posts += 1;
        return { ok: true };
      },
      stateStore: {
        read: async () => null,
        write: async () => {
          writes += 1;
        },
      },
    });
    assert.equal(code, 1);
    assert.equal(sends, 0);
    assert.equal(posts, 0);
    assert.equal(writes, 0);
  });

  it("rejects a fixture path argument instead of reading it", async () => {
    const result = await runCli(["--dry-run", "--fixture", "/etc/passwd"], {
      WATCH_STATE_PATH: path.join(os.tmpdir(), "watch83-state-rejected.json"),
    });
    assert.equal(result.code, 1);
    const output = `${result.out}\n${result.err}`;
    assert.match(output, /unknown argument/);
    assert.equal(output.includes("root:"), false);
  });

  it("CLI dry-run writes no state and prints no secret", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch83-"));
    const state = path.join(dir, "missing", "state.json");
    const secret = "akc_watch_check_secret_83_do_not_print";
    const hook = "https://hooks.slack.com/services/T83/B83/SECRET83HOOK";
    const result = await runCli(
      ["--dry-run", "--fixture"],
      {
        WATCH_STATE_PATH: state,
        WATCH_AK_KEY: secret,
        WATCH_SLACK_WEBHOOK: hook,
        WATCH_TELEGRAM_TOKEN: "999:TELEGRAMSECRET83",
        WATCH_TELEGRAM_CHAT: "4242",
      },
      JSON.stringify({ beats: [row({ status: "failing", age_s: 4, detail: secret })] }),
    );
    assert.equal(result.code, 1);
    assert.equal(fs.existsSync(state), false);
    const output = `${result.out}\n${result.err}`;
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes("SECRET83HOOK"), false);
    assert.equal(output.includes("TELEGRAMSECRET83"), false);
    assert.equal(output.includes("Authorization"), false);
  });

  it("redacts secrets from captured logs", async () => {
    const secret = "SECRET83HOOK";
    const token = "999:TELEGRAMSECRET83";
    const logs: string[] = [];
    const notify = createNotifier({
      credentials: {
        slackWebhook: `https://hooks.slack.com/services/T83/B83/${secret}`,
        telegramToken: token,
        telegramChat: "1",
      },
      secrets: [secret, token, `https://hooks.slack.com/services/T83/B83/${secret}`],
      log: (line: string) => logs.push(line),
      http: async () => {
        throw new Error(`connect ${token} Bearer akc_watch_check_secret_83_do_not_print https://hooks.slack.com/services/T83/B83/${secret}`);
      },
    });
    await notify({ destination: "slack", text: "hi", timeoutMs: 10_000 });
    const thrown = logs.join("\n");
    assert.equal(thrown.includes(secret), false);
    assert.equal(thrown.includes(token), false);
    assert.equal(thrown.includes("akc_watch_check_secret_83_do_not_print"), false);
    assert.equal(thrown.includes("hooks.slack.com"), false);
    const redacted = redact(`Authorization: Bearer ${token} ${secret}`, [secret, token]);
    assert.equal(redacted.includes(secret), false);
    assert.equal(redacted.includes(token), false);
  });
});

describe("watch workflow", () => {
  it("parses watch.yml for schedule, gate, concurrency, timeout, permissions, and secret placement", () => {
    const text = fs.readFileSync(workflowPath, "utf8");
    const doc = parseWorkflow(text) as {
      on: Record<string, unknown>;
      permissions: { contents: string; actions: string };
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: {
        watch: {
          "runs-on": string;
          "timeout-minutes": number;
          steps: Array<{ name?: string; if?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }>;
        };
      };
    };
    assert.deepEqual(Object.keys(doc.on).sort(), ["schedule", "workflow_dispatch"]);
    assert.equal(text.includes("pull_request"), false);
    const schedule = doc.on.schedule as Array<{ cron: string }>;
    assert.equal(schedule[0].cron, "7,17,27,37,47,57 * * * *");
    assert.equal(doc.concurrency.group, "watch");
    assert.equal(doc.concurrency["cancel-in-progress"], false);
    assert.equal(doc.jobs.watch["timeout-minutes"], 5);
    assert.equal(doc.jobs.watch["runs-on"], "ubuntu-latest");
    assert.equal(doc.permissions.contents, "read");
    assert.equal(doc.permissions.actions, "write");
    const steps = doc.jobs.watch.steps;
    const setup = steps.find((step) => step.uses === "actions/setup-node@v7");
    assert.equal(setup?.with?.["node-version"], "22");
    const restore = steps.find((step) => step.uses === "actions/cache/restore@v4");
    const save = steps.find((step) => step.uses === "actions/cache/save@v4");
    assert.equal(restore?.with?.key, "watch-state-v1-${{ github.run_id }}-${{ github.run_attempt }}");
    assert.equal(restore?.with?.["restore-keys"], "watch-state-v1-");
    assert.equal(save?.with?.key, "watch-state-v1-${{ github.run_id }}-${{ github.run_attempt }}");
    assert.match(String(save?.if), /always\(\)/);
    const live = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && vars.WATCH_ENABLED == 'true'";
    let secretSteps = 0;
    for (const step of steps) {
      if (!JSON.stringify(step).includes("secrets.")) continue;
      secretSteps += 1;
      assert.equal(step.if, `\${{ ${live} }}`);
    }
    assert.equal(secretSteps, 1);
    assert.equal(text.includes("secrets."), true);
  });
});

function runCli(
  args: string[],
  env: Record<string, string>,
  stdin = "",
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      cwd: root,
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => resolve({ code: code ?? -1, out, err }));
    child.stdin.end(stdin);
  });
}

function parseWorkflow(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const [doc] = parseMap(0, 0);
  return doc;

  function indentAt(line: string): number {
    const match = /^ */.exec(line);
    return match ? match[0].length : 0;
  }
  function isBlank(line: string): boolean {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith("#");
  }
  function scalar(raw: string): unknown {
    const value = raw.trim();
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null" || value === "~") return null;
    if (/^-?\d+$/.test(value)) return Number(value);
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  function parseMap(start: number, indent: number): [Record<string, unknown>, number] {
    const map: Record<string, unknown> = {};
    let j = start;
    while (j < lines.length) {
      while (j < lines.length && isBlank(lines[j] ?? "")) j += 1;
      if (j >= lines.length) break;
      const line = lines[j] ?? "";
      const ind = indentAt(line);
      if (ind < indent) break;
      if (ind !== indent) throw new Error(`indent ${ind} at line ${j + 1}: ${line}`);
      if (line.trimStart().startsWith("- ")) break;
      const rest = line.slice(ind);
      const colon = rest.indexOf(":");
      if (colon < 0) throw new Error(`key at line ${j + 1}`);
      const key = rest.slice(0, colon).trim();
      const inline = rest.slice(colon + 1).trim();
      if (inline !== "") {
        map[key] = scalar(inline);
        j += 1;
        continue;
      }
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k] ?? "")) k += 1;
      if (k >= lines.length || indentAt(lines[k] ?? "") <= indent) {
        map[key] = null;
        j += 1;
        continue;
      }
      const childIndent = indentAt(lines[k] ?? "");
      if ((lines[k] ?? "").trimStart().startsWith("- ")) {
        const [seq, next] = parseSeq(k, childIndent);
        map[key] = seq;
        j = next;
      } else {
        const [child, next] = parseMap(k, childIndent);
        map[key] = child;
        j = next;
      }
    }
    return [map, j];
  }
  function parseSeq(start: number, indent: number): [unknown[], number] {
    const seq: unknown[] = [];
    let j = start;
    while (j < lines.length) {
      while (j < lines.length && isBlank(lines[j] ?? "")) j += 1;
      if (j >= lines.length) break;
      const line = lines[j] ?? "";
      const ind = indentAt(line);
      if (ind < indent) break;
      if (ind !== indent || !line.trimStart().startsWith("- ")) break;
      const after = line.slice(ind + 2);
      const colon = after.indexOf(":");
      if (colon < 0) {
        seq.push(scalar(after.trim()));
        j += 1;
        continue;
      }
      const key = after.slice(0, colon).trim();
      const inline = after.slice(colon + 1).trim();
      const obj: Record<string, unknown> = {};
      obj[key] = inline === "" ? null : scalar(inline);
      j += 1;
      const keyIndent = ind + 2;
      while (j < lines.length) {
        while (j < lines.length && isBlank(lines[j] ?? "")) j += 1;
        if (j >= lines.length) break;
        const next = lines[j] ?? "";
        const nind = indentAt(next);
        if (nind < keyIndent) break;
        if (nind !== keyIndent) throw new Error(`item indent at line ${j + 1}: ${next}`);
        const body = next.slice(nind);
        const c = body.indexOf(":");
        if (c < 0) throw new Error(`item key at line ${j + 1}`);
        const childKey = body.slice(0, c).trim();
        const childInline = body.slice(c + 1).trim();
        if (childInline !== "") {
          obj[childKey] = scalar(childInline);
          j += 1;
          continue;
        }
        let k = j + 1;
        while (k < lines.length && isBlank(lines[k] ?? "")) k += 1;
        if (k >= lines.length || indentAt(lines[k] ?? "") <= keyIndent) {
          obj[childKey] = null;
          j += 1;
          continue;
        }
        const grand = indentAt(lines[k] ?? "");
        if ((lines[k] ?? "").trimStart().startsWith("- ")) {
          const [seqChild, nextIndex] = parseSeq(k, grand);
          obj[childKey] = seqChild;
          j = nextIndex;
        } else {
          const [mapChild, nextIndex] = parseMap(k, grand);
          obj[childKey] = mapChild;
          j = nextIndex;
        }
      }
      seq.push(obj);
    }
    return [seq, j];
  }
}
