import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GET } from "../../src/app/api/brief/alerts/route";
import { POST } from "../../src/app/api/brief/alerts/evaluate/route";
import {
  classifyZeroMerge,
  evaluateAlerts,
  readAlerts,
  setBriefSettingsForTests,
  type AlertEvaluation,
} from "../../src/lib/brief-alerts";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row, type SqlTag } from "../../src/lib/db";
import { openApiDocument } from "../../src/lib/openapi";
import { readBriefSettings, type BriefSettings } from "../../src/lib/progress-config";
import { scopeForRoute, TOOL_SCOPES } from "../../src/lib/scopes";

/**
 * Failure cases for threshold alerts. Each one tries to break the
 * implementation: a disabled switch that still sends, a heartbeat that
 * clears silence, a boundary that is off by a minute, a claim that is
 * not atomic, and an unknown read that is treated as "all clear".
 */

const H = 3_600_000;
const M = 60_000;
const D = 24 * H;
const T = new Date("2026-10-28T12:00:00.000Z");

const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  node: env.NODE_ENV,
  password: env.MC_DASHBOARD_PASSWORD,
};

interface Latch {
  first: string;
  last: string;
  cleared: string | null;
  claim_token?: string | null;
}

interface SentMessage {
  agent_id: string;
  body: string;
  created_by: string;
  direction: string;
  actor_type: string | null;
  actor_id: string | null;
}

interface World {
  clock: Date;
  agents: { id: string; last_seen_at: string | null }[];
  events: { agent_id: string; kind: string; created_at: string }[];
  watched: { repo: string; label: string; short: string; color: string; blocked_label: string | null; position: number }[];
  snapshots: { repo: string; collected_at: string; detail: unknown }[];
  decisions: {
    id: number;
    key: string;
    title: string;
    status: string;
    opened_at: string | null;
    first_seen_at: string | null;
  }[];
  alerts: Map<string, Latch>;
  messages: SentMessage[];
  fail: Set<string>;
  failMessageInserts: number;
  stallClaims: boolean;
  claimGateOpen: boolean;
  claimWaiters: Array<() => void>;
  maxClaimWaiters: number;
  claimTexts: string[];
  restoreTexts: string[];
  /** Runs after a claim and before the message insert, so a second evaluate can clear. */
  beforeMessageInsert: (() => void) | null;
}

let world: World;
let tail: Promise<unknown> = Promise.resolve();

function freshWorld(): World {
  return {
    clock: T,
    agents: [],
    events: [],
    watched: [],
    snapshots: [],
    decisions: [],
    alerts: new Map(),
    messages: [],
    fail: new Set(),
    failMessageInserts: 0,
    stallClaims: false,
    claimGateOpen: false,
    claimWaiters: [],
    maxClaimWaiters: 0,
    claimTexts: [],
    restoreTexts: [],
    beforeMessageInsert: null,
  };
}

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["NODE_ENV", saved.node],
    ["MC_DASHBOARD_PASSWORD", saved.password],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
  setBriefSettingsForTests(null);
  world = freshWorld();
  tail = Promise.resolve();
});

afterEach(() => {
  setSqlForTests(null);
  setBriefSettingsForTests(null);
  resetCredentialsForTests();
  restoreEnv();
});

function settings(over: {
  enabled?: boolean;
  agentId?: string | null;
  maxSilenceHours?: number;
  repeat?: number;
  quiet?: number;
  lookback?: number;
  age?: number;
  workKinds?: string[];
} = {}): BriefSettings {
  return {
    decisionLabels: ["needs-owner"],
    stuckPrHours: 48,
    staleIssueDays: 21,
    coordinator: {
      agentId: over.agentId === undefined ? "carmack" : over.agentId,
      maxSilenceHours: over.maxSilenceHours ?? 3,
      workKinds: over.workKinds ?? ["session_end", "milestone", "status"],
    },
    alerts: {
      enabled: over.enabled ?? false,
      coordinatorRepeatHours: over.repeat ?? 12,
      zeroMergeHours: over.quiet ?? 72,
      zeroMergeLookbackDays: over.lookback ?? 7,
      decisionAgeDays: over.age ?? 14,
    },
  };
}

function at(base: Date, deltaMs: number): string {
  return new Date(base.getTime() + deltaMs).toISOString();
}

function isoValues(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value));
}

function alertKey(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (/^(coordinator-silent|zero-merge|decision:|decision-age)/.test(value)) return value;
  }
  return null;
}

function textOf(strings: TemplateStringsArray): string {
  return strings.join(" ");
}

function exclusive<T>(fn: () => T): Promise<T> {
  const run = tail.then(() => fn());
  tail = run.then(() => undefined, () => undefined);
  return run;
}

function uuidOf(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return value;
    }
  }
  return null;
}

function notDistinct(left: string | null | undefined, right: unknown): boolean {
  if (left == null && right == null) return true;
  return left === right;
}

function latchRow(key: string, latch: Latch): Row {
  return {
    key,
    first_sent_at: latch.first,
    last_sent_at: latch.last,
    cleared_at: latch.cleared,
  };
}

function applyClaim(text: string, values: unknown[]): Row[] {
  const key = alertKey(values);
  const now = isoValues(values)[0];
  if (!key || !now) throw new Error(`claim missing key or clock: ${text.slice(0, 120)}`);
  const hours = values.find((value) => typeof value === "number");
  const token = uuidOf(values);
  const existing = world.alerts.get(key) ?? null;
  const prior = existing ? { ...existing } : null;
  const claimedRow = (first: string): Latch => ({
    first,
    last: now,
    cleared: null,
    claim_token: token ?? existing?.claim_token ?? null,
  });
  const marker = text.match(/brief-alert-claim:(repeat|episode|once)/);
  const atomic = Boolean(marker)
    && /on conflict\s*\(\s*key\s*\)/i.test(text)
    && /returning/i.test(text);
  let won = false;
  if (!existing || !atomic) {
    world.alerts.set(key, claimedRow(existing?.first ?? now));
    won = true;
  } else if (marker![1] === "once") {
    won = !/do nothing/i.test(text);
    if (won) world.alerts.set(key, claimedRow(existing.first));
  } else {
    const whereCleared = /cleared_at\s+is\s+not\s+null/i.test(text);
    const whereRepeat = /last_sent_at\s*<=/i.test(text)
      && /interval\s+'1 hour'/i.test(text)
      && typeof hours === "number";
    const due = whereRepeat && Date.parse(existing.last) <= Date.parse(now) - (hours as number) * H;
    const rearm = whereCleared && existing.cleared != null;
    if (rearm || due || (!whereCleared && !whereRepeat)) {
      world.alerts.set(key, claimedRow(existing.first));
      won = true;
    }
  }
  world.claimTexts.push(text);
  if (!won) return [];
  return [{
    key,
    prev_first: prior?.first ?? null,
    prev_last: prior?.last ?? null,
    prev_cleared: prior?.cleared ?? null,
  }];
}

async function claim(text: string, values: unknown[]): Promise<Row[]> {
  await Promise.resolve();
  const key = alertKey(values) ?? "?";
  if (world.stallClaims && !world.claimGateOpen) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`claim gate timed out for ${key}`)), 2000);
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      world.claimWaiters.push(go);
      world.maxClaimWaiters = Math.max(world.maxClaimWaiters, world.claimWaiters.length);
      if (world.claimWaiters.length >= 2) {
        const pending = world.claimWaiters.splice(0);
        world.claimGateOpen = true;
        for (const release of pending) release();
      }
    });
  }
  return exclusive(() => applyClaim(text, values));
}

function snapshotsFor(values: unknown[]): Row[] {
  const repos = values.find((value) => Array.isArray(value)) as string[] | undefined;
  const times = isoValues(values).map((value) => Date.parse(value)).filter((value) => !Number.isNaN(value)).sort((a, b) => a - b);
  const sinceMs = times.length >= 2 ? times[0] : null;
  const nowMs = times.length >= 1 ? times[times.length - 1] : null;
  return world.snapshots.filter((snap) => {
    if (repos && !repos.includes(snap.repo)) return false;
    const atMs = Date.parse(snap.collected_at);
    if (sinceMs != null && atMs < sinceMs) return false;
    if (nowMs != null && atMs > nowMs) return false;
    return true;
  }).map((snap) => ({ repo: snap.repo, collected_at: snap.collected_at, detail: snap.detail }));
}

const sqlFake: SqlTag = async (strings, ...values) => {
  await Promise.resolve();
  const text = textOf(strings);
  if (/\bbrief_alerts\b/i.test(text) && world.fail.has("latches")) {
    throw new Error("brief_alerts missing");
  }
  if (/insert\s+into\s+brief_alerts/i.test(text) && world.fail.has("claim")) {
    throw new Error("claim failed");
  }
  if (/insert\s+into\s+messages/i.test(text)) {
    world.beforeMessageInsert?.();
    world.beforeMessageInsert = null;
    if (world.failMessageInserts > 0) {
      world.failMessageInserts -= 1;
      throw new Error("message insert failed");
    }
    const body = values.find((value) => typeof value === "string" && value.startsWith("brief-alert "));
    if (typeof body !== "string") throw new Error("message insert has no brief-alert body");
    world.messages.push({
      agent_id: String(values[0]),
      body,
      created_by: String(values[2]),
      direction: String(values[3]),
      actor_type: values[5] == null ? null : String(values[5]),
      actor_id: values[6] == null ? null : String(values[6]),
    });
    return [{
      id: world.messages.length,
      agent_id: values[0],
      body,
      created_by: values[2],
      actor_type: values[5],
      actor_id: values[6],
      created_at: new Date().toISOString(),
      delivered_at: null,
      acked_at: null,
      direction: values[3],
      in_reply_to: null,
      thread_id: String(world.messages.length),
      read_by_dashboard_at: null,
    }];
  }
  if (/insert\s+into\s+brief_alerts/i.test(text)) return claim(text, values);
  if (/delete\s+from\s+brief_alerts/i.test(text)) {
    world.restoreTexts.push(text);
    const key = alertKey(values);
    if (!key) return [];
    const row = world.alerts.get(key);
    if (!row) return [];
    const guarded = /claim_token\s*=/i.test(text) && /cleared_at\s+is\s+not\s+distinct\s+from/i.test(text);
    if (guarded) {
      const token = uuidOf(values);
      if (!token || row.claim_token !== token) return [];
      if (!notDistinct(row.cleared, values[values.length - 1])) return [];
    } else if (/last_sent_at\s*=/i.test(text)) {
      const now = isoValues(values)[0];
      if (!now || row.last !== now) return [];
    }
    world.alerts.delete(key);
    return [];
  }
  if (/update\s+brief_alerts/i.test(text) && /first_sent_at/i.test(text)) {
    world.restoreTexts.push(text);
    const key = alertKey(values);
    if (!key) return [];
    const row = world.alerts.get(key);
    if (!row) return [];
    const guarded = /claim_token\s*=/i.test(text) && /cleared_at\s+is\s+not\s+distinct\s+from/i.test(text);
    if (guarded) {
      const token = uuidOf(values);
      if (!token || row.claim_token !== token) return [];
      if (!notDistinct(row.cleared, values[values.length - 1])) return [];
    } else {
      const now = isoValues(values).at(-1);
      if (!now || row.last !== now) return [];
    }
    world.alerts.set(key, {
      first: typeof values[0] === "string" ? values[0] : row.first,
      last: typeof values[1] === "string" ? values[1] : row.last,
      cleared: values[2] == null ? null : String(values[2]),
      claim_token: row.claim_token,
    });
    return [];
  }
  if (/update\s+brief_alerts/i.test(text)) {
    if (world.fail.has("clear")) throw new Error("clear failed");
    const key = alertKey(values);
    const now = isoValues(values)[0];
    if (!key || !now) return [];
    const row = world.alerts.get(key);
    if (!row) return [];
    if (row.cleared && /cleared_at\s+is\s+null/i.test(text)) return [];
    world.alerts.set(key, { ...row, cleared: now });
    return [{ key }];
  }
  if (/from\s+agents\b/i.test(text)) {
    if (world.fail.has("agents")) throw new Error("agents down");
    const id = values.find((value) => typeof value === "string");
    const agent = world.agents.find((row) => row.id === id);
    return agent ? [{ id: agent.id, last_seen_at: agent.last_seen_at }] : [];
  }
  if (/from\s+events\b/i.test(text)) {
    if (world.fail.has("events")) throw new Error("events down");
    const ids = values.filter((value): value is string => typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T/.test(value));
    const agentId = ids[0];
    return world.events
      .filter((event) => event.agent_id === agentId)
      .map((event, index) => ({ id: index + 1, kind: event.kind, created_at: event.created_at }));
  }
  if (/from\s+watched_repos\b/i.test(text)) {
    if (world.fail.has("watched")) throw new Error("watched repos down");
    return world.watched
      .slice()
      .sort((a, b) => a.position - b.position || a.repo.localeCompare(b.repo))
      .map((row) => ({
        repo: row.repo,
        label: row.label,
        short: row.short,
        color: row.color,
        blocked_label: row.blocked_label,
      }));
  }
  if (/from\s+repo_snapshots\b/i.test(text)) {
    if (world.fail.has("snapshots")) throw new Error("snapshots down");
    return snapshotsFor(values);
  }
  if (/from\s+decisions\b/i.test(text)) {
    if (world.fail.has("decisions")) throw new Error("decisions down");
    const openOnly = /status\s*=\s*'open'/i.test(text);
    return world.decisions
      .filter((row) => !openOnly || row.status === "open")
      .map((row) => ({
        id: row.id,
        key: row.key,
        title: row.title,
        opened_at: row.opened_at,
        first_seen_at: row.first_seen_at,
      }));
  }
  if (/from\s+brief_alerts\b/i.test(text)) {
    if (world.fail.has("latches")) throw new Error("latches down");
    const keys = values.find((value) => Array.isArray(value)) as string[] | undefined;
    const rows = [...world.alerts.entries()];
    return rows
      .filter(([key]) => !keys || keys.includes(key))
      .map(([key, latch]) => latchRow(key, latch));
  }
  if (/select\s+now\(\)\s+as\s+now/i.test(text)) return [{ now: world.clock }];
  throw new Error(`unhandled sql: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
};

function useDb() {
  env.DATABASE_URL = "postgres://brief-alerts-test/db";
  setSqlForTests(sqlFake);
}

function watch(repo: string, position = 0) {
  world.watched.push({
    repo,
    label: repo.split("/")[1] ?? repo,
    short: repo.split("/")[1] ?? repo,
    color: "#000000",
    blocked_label: null,
    position,
  });
}

function snap(repo: string, collectedAt: string, merged: unknown[] | null) {
  const detail = merged === null ? { stuck_prs: [] } : { merged };
  world.snapshots.push({ repo, collected_at: collectedAt, detail });
}

function cover(repo: string, now: Date) {
  for (const hours of [0, 72, 144]) snap(repo, at(now, -hours * H), []);
}

function decision(id: number, status: string, opened: string | null, firstSeen: string | null = opened) {
  world.decisions.push({
    id,
    key: `github:example-org/app#${id}`,
    title: `decision ${id}`,
    status,
    opened_at: opened,
    first_seen_at: firstSeen,
  });
}

function messagesFor(key: string): SentMessage[] {
  const prefix = `brief-alert ${key}\n`;
  return world.messages.filter((message) => message.body.startsWith(prefix));
}

function hit(report: AlertEvaluation, key: string) {
  const found = report.alerts.find((alert) => alert.key === key);
  assert.ok(found, `missing alert ${key} in ${report.alerts.map((alert) => alert.key).join(",")}`);
  return found;
}

function silence(now: Date, ageMs: number) {
  world.agents = [{ id: "carmack", last_seen_at: at(now, -M) }];
  world.events = [{ agent_id: "carmack", kind: "session_end", created_at: at(now, -ageMs) }];
}

describe("threshold alerts", { concurrency: false }, () => {
  it("F1 default off sends nothing and GET still reports conditions", async () => {
    assert.equal(readBriefSettings({}).alerts.enabled, false);
    assert.equal(readBriefSettings({ brief: { alerts: { enabled: "true" } } }).alerts.enabled, false);
    assert.equal(readBriefSettings({ brief: { alerts: { enabled: 1 } } }).alerts.enabled, false);
    const collapsed = readBriefSettings({
      brief: {
        alerts: {
          enabled: true,
          coordinatorRepeatHours: 0,
          zeroMergeHours: -5,
          zeroMergeLookbackDays: Number.NaN,
          decisionAgeDays: "14",
        },
      },
    });
    assert.equal(collapsed.alerts.enabled, true);
    assert.equal(collapsed.alerts.coordinatorRepeatHours, 12);
    assert.equal(collapsed.alerts.zeroMergeHours, 72);
    assert.equal(collapsed.alerts.zeroMergeLookbackDays, 7);
    assert.equal(collapsed.alerts.decisionAgeDays, 14);
    const file = JSON.parse(fs.readFileSync("progress.config.json", "utf8")) as {
      brief: { alerts: { enabled: boolean } };
    };
    assert.equal(file.brief.alerts.enabled, false);

    const dark = await evaluateAlerts({ now: T });
    assert.equal(dark.enabled, false);
    assert.equal(dark.sent_count, 0);
    assert.equal(dark.alerts.every((alert) => alert.condition === "unknown"), true);
    assert.equal(world.messages.length, 0);

    useDb();
    const off = settings({ enabled: false });
    setBriefSettingsForTests(off);
    silence(T, 4 * H);
    watch("example-org/app-server");
    snap("example-org/app-server", at(T, 0), [{ merged_at: at(T, -80 * H) }]);
    decision(9, "open", at(T, -20 * D));
    world.alerts.set("coordinator-silent:carmack", {
      first: at(T, -D),
      last: at(T, -D),
      cleared: at(T, -H),
    });
    world.alerts.set("decision:9", {
      first: at(T, -D),
      last: at(T, -D),
      cleared: null,
    });
    const before = [...world.alerts.entries()].map(([key, latch]) => [key, { ...latch }]);

    const evaluated = await evaluateAlerts({ now: T, settings: off });
    assert.equal(evaluated.enabled, false);
    assert.equal(evaluated.delivery, "disabled");
    assert.equal(evaluated.sent_count, 0);
    assert.match(evaluated.note ?? "", /enabled is false/);
    assert.equal(hit(evaluated, "coordinator-silent:carmack").condition, "firing");
    assert.equal(hit(evaluated, "zero-merge:example-org/app-server").condition, "firing");
    assert.equal(hit(evaluated, "decision:9").condition, "firing");
    assert.equal(world.messages.length, 0);
    assert.deepEqual([...world.alerts.entries()].map(([key, latch]) => [key, latch]), before);

    const read = await readAlerts({ now: T, settings: settings({ enabled: true }) });
    assert.equal(read.delivery, "read");
    assert.equal(read.sent_count, 0);
    assert.equal(hit(read, "decision:9").condition, "firing");
    assert.equal(hit(read, "decision:9").sent, true);
    assert.equal(world.messages.length, 0);

    world.clock = new Date("2020-01-15T00:00:00.000Z");
    world.decisions = [{
      id: 3,
      key: "github:example-org/app#3",
      title: "young in 2020",
      status: "open",
      opened_at: "2020-01-10T00:00:00.000Z",
      first_seen_at: "2020-01-10T00:00:00.000Z",
    }];
    const got = await GET(new Request("http://localhost/api/brief/alerts"));
    assert.equal(got.status, 200);
    const body = await got.json() as AlertEvaluation;
    assert.equal(body.generated_at, "2020-01-15T00:00:00Z");
    assert.equal(hit(body, "decision:3").condition, "clear");
    const posted = await POST(new Request("http://localhost/api/brief/alerts/evaluate", { method: "POST", body: "{\"send\":true}" }));
    assert.equal(posted.status, 200);
    const postedBody = await posted.json() as AlertEvaluation;
    assert.equal(postedBody.delivery, "disabled");
    assert.equal(postedBody.sent_count, 0);
    assert.equal(hit(postedBody, "decision:3").condition, "clear");
    assert.equal(world.messages.length, 0);
  });

  it("F2 coordinator silence sends, waits out the hour, repeats at 12h, and clears on work", async () => {
    useDb();
    watch("example-org/app-server");
    snap("example-org/app-server", at(T, 0), [{ merged_at: at(T, -H) }]);
    const on = settings({ enabled: true, maxSilenceHours: 3 });
    silence(T, 3 * H);
    const exact = await evaluateAlerts({
      now: T,
      settings: on,
      actor: { actor_type: "agent", actor_id: "mc-token" },
    });
    assert.equal(hit(exact, "coordinator-silent:carmack").condition, "clear");
    assert.equal(messagesFor("coordinator-silent:carmack").length, 0);

    silence(T, 3 * H + M);
    const first = await evaluateAlerts({
      now: T,
      settings: on,
      actor: { actor_type: "agent", actor_id: "mc-token" },
    });
    assert.equal(hit(first, "coordinator-silent:carmack").condition, "firing");
    assert.equal(hit(first, "coordinator-silent:carmack").sent, true);
    assert.equal(first.sent_count, 1);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 1);
    const message = messagesFor("coordinator-silent:carmack")[0];
    assert.equal(message.created_by, "brief-alerts");
    assert.equal(message.direction, "inbound");
    assert.equal(message.agent_id, "carmack");
    assert.equal(message.actor_type, "agent");
    assert.equal(message.actor_id, "mc-token");

    const hour = await evaluateAlerts({ now: new Date(T.getTime() + H), settings: on });
    assert.equal(hour.sent_count, 0);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 1);

    const almost = await evaluateAlerts({ now: new Date(T.getTime() + 12 * H - M), settings: on });
    assert.equal(almost.sent_count, 0);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 1);

    const later = new Date(T.getTime() + 12 * H);
    const repeat = await evaluateAlerts({ now: later, settings: on });
    assert.equal(hit(repeat, "coordinator-silent:carmack").condition, "firing");
    assert.equal(repeat.sent_count, 1);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 2);

    world.events.push({ agent_id: "carmack", kind: "milestone", created_at: at(later, 0) });
    const cleared = await evaluateAlerts({ now: later, settings: on });
    assert.equal(hit(cleared, "coordinator-silent:carmack").condition, "clear");
    assert.equal(hit(cleared, "coordinator-silent:carmack").sent, false);
    assert.equal(cleared.sent_count, 0);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 2);
    assert.equal(world.alerts.get("coordinator-silent:carmack")?.cleared != null, true);

    world.events = world.events.filter((event) => event.kind !== "milestone");
    const rearmed = await evaluateAlerts({ now: later, settings: on });
    assert.equal(hit(rearmed, "coordinator-silent:carmack").condition, "firing");
    assert.equal(rearmed.sent_count, 1);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 3);
  });

  it("F3 heartbeat, telemetry, turn_start, status_update, and error never reset silence", async () => {
    useDb();
    const on = settings({ enabled: true, maxSilenceHours: 3 });
    world.agents = [{ id: "carmack", last_seen_at: at(T, -M) }];
    world.events = [
      { agent_id: "carmack", kind: "session_end", created_at: at(T, -(4 * H)) },
      { agent_id: "carmack", kind: "heartbeat", created_at: at(T, -M) },
      { agent_id: "carmack", kind: "telemetry", created_at: at(T, -M) },
      { agent_id: "carmack", kind: "turn_start", created_at: at(T, -M) },
      { agent_id: "carmack", kind: "status_update", created_at: at(T, -M) },
      { agent_id: "carmack", kind: "error", created_at: at(T, -M) },
    ];
    const noisy = await evaluateAlerts({ now: T, settings: on });
    const coordinator = hit(noisy, "coordinator-silent:carmack");
    assert.equal(coordinator.condition, "firing");
    assert.equal(coordinator.summary.startsWith("working:"), false);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 1);

    world.events.push({ agent_id: "carmack", kind: "status", created_at: at(T, -M) });
    const worked = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(worked, "coordinator-silent:carmack").condition, "clear");
    assert.equal(messagesFor("coordinator-silent:carmack").length, 1);

    const noiseOnly = settings({
      enabled: true,
      maxSilenceHours: 3,
      workKinds: ["heartbeat", "telemetry", "turn_start", "status_update", "error"],
    });
    world.events = [{ agent_id: "carmack", kind: "heartbeat", created_at: at(T, -M) }];
    const configured = await evaluateAlerts({ now: T, settings: noiseOnly });
    assert.equal(hit(configured, "coordinator-silent:carmack").condition, "firing");
    assert.match(hit(configured, "coordinator-silent:carmack").summary, /NOT WORKING/);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 2);
  });

  it("F4 zero-merge boundaries fire only for a quiet repo that merged inside the lookback", async () => {
    const alerts = settings().alerts;
    const nowMs = T.getTime();
    const point = (delta: number) => [{ repo: "r", collectedAt: nowMs, merged: [{ merged_at: at(T, delta) }] }];
    assert.equal(classifyZeroMerge(point(-72 * H), nowMs, alerts), "firing");
    assert.equal(classifyZeroMerge(point(-72 * H + M), nowMs, alerts), "clear");
    assert.equal(classifyZeroMerge(point(-72 * H - M), nowMs, alerts), "firing");
    assert.equal(classifyZeroMerge(point(-7 * D), nowMs, alerts), "firing");
    assert.equal(classifyZeroMerge(point(-7 * D - M), nowMs, alerts), "unknown");
    assert.equal(classifyZeroMerge([{ repo: "r", collectedAt: nowMs, merged: [] }], nowMs, alerts), "unknown");
    assert.equal(classifyZeroMerge([{ repo: "r", collectedAt: nowMs, merged: null }], nowMs, alerts), "unknown");

    useDb();
    const on = settings({ enabled: true, agentId: null });
    const repos = {
      exact: "example-org/exact",
      recent: "example-org/recent",
      quiet: "example-org/quiet",
      none: "example-org/none",
      ancient: "example-org/ancient",
      edge: "example-org/edge",
      thin: "example-org/thin",
      hole: "example-org/hole",
    };
    Object.values(repos).forEach((repo, index) => watch(repo, index));
    snap(repos.exact, at(T, 0), [{ merged_at: at(T, -72 * H) }]);
    snap(repos.recent, at(T, 0), [{ merged_at: at(T, -72 * H + M) }]);
    snap(repos.quiet, at(T, 0), [{ merged_at: at(T, -72 * H - M) }]);
    cover(repos.none, T);
    cover(repos.ancient, T);
    world.snapshots = world.snapshots.map((row) => {
      if (row.repo !== repos.ancient || row.collected_at !== at(T, -144 * H)) return row;
      return { ...row, detail: { merged: [{ merged_at: at(T, -7 * D - M) }] } };
    });
    snap(repos.edge, at(T, 0), [{ merged_at: at(T, -7 * D) }]);
    snap(repos.thin, at(T, 0), []);
    snap(repos.hole, at(T, -72 * H), [{ merged_at: at(T, -80 * H) }]);
    snap(repos.hole, at(T, 0), null);

    const first = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(first, `zero-merge:${repos.exact}`).condition, "firing");
    assert.equal(hit(first, `zero-merge:${repos.recent}`).condition, "clear");
    assert.equal(hit(first, `zero-merge:${repos.quiet}`).condition, "firing");
    assert.equal(hit(first, `zero-merge:${repos.none}`).condition, "clear");
    assert.equal(hit(first, `zero-merge:${repos.ancient}`).condition, "clear");
    assert.equal(hit(first, `zero-merge:${repos.edge}`).condition, "firing");
    assert.equal(hit(first, `zero-merge:${repos.thin}`).condition, "unknown");
    assert.equal(hit(first, `zero-merge:${repos.hole}`).condition, "unknown");
    assert.equal(messagesFor(`zero-merge:${repos.exact}`).length, 1);
    assert.equal(messagesFor(`zero-merge:${repos.recent}`).length, 0);
    assert.equal(messagesFor(`zero-merge:${repos.quiet}`).length, 1);
    assert.equal(messagesFor(`zero-merge:${repos.none}`).length, 0);
    assert.equal(messagesFor(`zero-merge:${repos.ancient}`).length, 0);
    assert.equal(messagesFor(`zero-merge:${repos.edge}`).length, 1);
    assert.equal(messagesFor(`zero-merge:${repos.thin}`).length, 0);
    assert.equal(messagesFor(`zero-merge:${repos.hole}`).length, 0);
    assert.equal(world.messages.length, 3);

    world.watched = world.watched.filter((row) => row.repo === repos.exact);
    const later = new Date(T.getTime() + 12 * H);
    snap(repos.exact, at(later, 0), []);
    const repeat = await evaluateAlerts({ now: later, settings: on });
    assert.equal(hit(repeat, `zero-merge:${repos.exact}`).condition, "firing");
    assert.equal(repeat.sent_count, 0);
    assert.equal(messagesFor(`zero-merge:${repos.exact}`).length, 1);

    world.snapshots = world.snapshots.filter((row) => row.repo !== repos.exact);
    snap(repos.exact, at(later, 0), [{ merged_at: at(later, -H) }]);
    const back = await evaluateAlerts({ now: later, settings: on });
    assert.equal(hit(back, `zero-merge:${repos.exact}`).condition, "clear");
    assert.equal(back.sent_count, 0);
    assert.equal(world.alerts.get(`zero-merge:${repos.exact}`)?.cleared != null, true);
    assert.equal(messagesFor(`zero-merge:${repos.exact}`).length, 1);

    world.snapshots = world.snapshots.filter((row) => row.repo !== repos.exact);
    snap(repos.exact, at(later, 0), [{ merged_at: at(later, -80 * H) }]);
    const again = await evaluateAlerts({ now: later, settings: on });
    assert.equal(hit(again, `zero-merge:${repos.exact}`).condition, "firing");
    assert.equal(again.sent_count, 1);
    assert.equal(messagesFor(`zero-merge:${repos.exact}`).length, 2);
  });

  it("F5 an open decision alerts once, a minute early never, and a resolved row never", async () => {
    useDb();
    const on = settings({ enabled: true, agentId: null });
    decision(1, "open", at(T, -14 * D));
    decision(2, "open", at(T, -14 * D + M));
    decision(3, "open", at(T, -14 * D - M));
    decision(4, "decided", at(T, -40 * D));
    decision(5, "withdrawn", at(T, -40 * D));
    decision(6, "deferred", at(T, -40 * D));
    decision(7, "open", null, null);
    decision(8, "open", null, at(T, -14 * D - M));

    const first = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(first, "decision:1").condition, "clear");
    assert.equal(hit(first, "decision:2").condition, "clear");
    assert.equal(hit(first, "decision:3").condition, "firing");
    assert.equal(hit(first, "decision:7").condition, "unknown");
    assert.equal(hit(first, "decision:8").condition, "firing");
    for (const id of [4, 5, 6]) {
      assert.equal(first.alerts.some((alert) => alert.key === `decision:${id}`), false);
      assert.equal(messagesFor(`decision:${id}`).length, 0);
    }
    assert.equal(messagesFor("decision:1").length, 0);
    assert.equal(messagesFor("decision:2").length, 0);
    assert.equal(messagesFor("decision:3").length, 1);
    assert.equal(messagesFor("decision:7").length, 0);
    assert.equal(messagesFor("decision:8").length, 1);
    assert.equal(first.sent_count, 2);

    const second = await evaluateAlerts({ now: T, settings: on });
    assert.equal(second.sent_count, 0);
    assert.equal(messagesFor("decision:3").length, 1);
    assert.equal(messagesFor("decision:8").length, 1);

    world.decisions = world.decisions.map((row) => row.id === 3 ? { ...row, status: "decided" } : row);
    const resolved = await evaluateAlerts({ now: T, settings: on });
    assert.equal(resolved.alerts.some((alert) => alert.key === "decision:3"), false);
    assert.equal(resolved.sent_count, 0);
    assert.equal(messagesFor("decision:3").length, 1);
    assert.equal(world.alerts.get("decision:3")?.cleared ?? null, null);
  });

  it("F6 two concurrent evaluates send one message per alert", { timeout: 5000 }, async () => {
    useDb();
    world.stallClaims = true;
    const on = settings({ enabled: true });
    silence(T, 4 * H);
    watch("example-org/app-server");
    snap("example-org/app-server", at(T, 0), [{ merged_at: at(T, -80 * H) }]);
    decision(11, "open", at(T, -20 * D));

    const [left, right] = await Promise.all([
      evaluateAlerts({ now: T, settings: on }),
      evaluateAlerts({ now: T, settings: on }),
    ]);
    assert.equal(world.maxClaimWaiters >= 2, true);
    assert.equal(left.sent_count + right.sent_count, 3);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 1);
    assert.equal(messagesFor("zero-merge:example-org/app-server").length, 1);
    assert.equal(messagesFor("decision:11").length, 1);
    assert.equal(world.messages.length, 3);
    const claimed = world.claimTexts.join("\n");
    assert.match(claimed, /brief-alert-claim:repeat/);
    assert.match(claimed, /brief-alert-claim:episode/);
    assert.match(claimed, /brief-alert-claim:once/);
    assert.match(claimed, /on conflict\s*\(\s*key\s*\)/i);
    assert.match(claimed, /returning/i);
    assert.match(claimed, /do nothing/i);
  });

  it("F7 a failed read is unknown, sends nothing for that condition, and does not clear", async () => {
    useDb();
    const on = settings({ enabled: true });
    silence(T, 4 * H);
    watch("example-org/app-server");
    snap("example-org/app-server", at(T, 0), [{ merged_at: at(T, -80 * H) }]);
    decision(21, "open", at(T, -20 * D));
    world.fail.add("snapshots");

    const partial = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(partial, "zero-merge:example-org/app-server").condition, "unknown");
    assert.equal(hit(partial, "coordinator-silent:carmack").condition, "firing");
    assert.equal(hit(partial, "decision:21").condition, "firing");
    assert.equal(messagesFor("zero-merge:example-org/app-server").length, 0);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 1);
    assert.equal(messagesFor("decision:21").length, 1);
    assert.equal(partial.sent_count, 2);

    world.fail.add("decisions");
    const lostDecisions = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(lostDecisions, "decision-age").condition, "unknown");
    assert.equal(lostDecisions.alerts.some((alert) => alert.key === "decision:21"), false);
    assert.equal(lostDecisions.sent_count, 0);
    assert.equal(messagesFor("decision:21").length, 1);
    assert.equal(world.alerts.get("decision:21")?.cleared ?? null, null);

    world.fail.add("agents");
    const lostCoordinator = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(lostCoordinator, "coordinator-silent:carmack").condition, "unknown");
    assert.equal(hit(lostCoordinator, "coordinator-silent:carmack").sent, true);
    assert.equal(lostCoordinator.sent_count, 0);
    assert.equal(messagesFor("coordinator-silent:carmack").length, 1);
    assert.equal(world.alerts.get("coordinator-silent:carmack")?.cleared ?? null, null);

    world.fail.clear();
    world.agents = [];
    world.events = [];
    world.decisions = [];
    world.watched = [];
    watch("example-org/retry");
    snap("example-org/retry", at(T, 0), [{ merged_at: at(T, -80 * H) }]);
    const retrySettings = settings({ enabled: true, agentId: null });
    world.failMessageInserts = 1;
    const failedSend = await evaluateAlerts({ now: T, settings: retrySettings });
    assert.equal(hit(failedSend, "zero-merge:example-org/retry").condition, "firing");
    assert.equal(failedSend.sent_count, 0);
    assert.equal(messagesFor("zero-merge:example-org/retry").length, 0);
    assert.equal(world.alerts.has("zero-merge:example-org/retry"), false);
    const retried = await evaluateAlerts({ now: T, settings: retrySettings });
    assert.equal(retried.sent_count, 1);
    assert.equal(messagesFor("zero-merge:example-org/retry").length, 1);
    assert.equal(world.alerts.get("zero-merge:example-org/retry")?.cleared ?? null, null);
  });

  it("F8 unauthenticated callers and agents without scope are denied on both routes", async () => {
    assert.equal(scopeForRoute("GET", "/api/brief/alerts"), "progress:read");
    assert.equal(scopeForRoute("POST", "/api/brief/alerts/evaluate"), null);
    assert.equal(scopeForRoute("GET", "/api/brief"), "progress:read");
    assert.equal(TOOL_SCOPES.evaluate_brief_alerts, undefined);
    assert.equal(TOOL_SCOPES.get_brief_alerts, undefined);
    const mcp = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    assert.equal(mcp.includes("brief/alerts"), false);
    assert.equal(mcp.includes("brief_alert"), false);
    assert.equal(mcp.includes("get_morning_brief"), true);

    env.MC_DASHBOARD_PASSWORD = "test-dashboard-password";
    env.MC_TOKEN = "test-mc-token";
    const getDenied = await GET(new Request("http://localhost/api/brief/alerts"));
    assert.equal(getDenied.status, 401);
    const postDenied = await POST(new Request("http://localhost/api/brief/alerts/evaluate", { method: "POST" }));
    assert.equal(postDenied.status, 401);
    const wrong = await GET(new Request("http://localhost/api/brief/alerts", {
      headers: { authorization: "Bearer not-the-token" },
    }));
    assert.equal(wrong.status, 401);
    const wrongPost = await POST(new Request("http://localhost/api/brief/alerts/evaluate", {
      method: "POST",
      headers: { authorization: "Bearer not-the-token" },
    }));
    assert.equal(wrongPost.status, 401);

    const tasksOnly = await createCredential({ label: "tasks only", scopes: ["tasks:read"] });
    assert.equal(tasksOnly.ok, true);
    if (!tasksOnly.ok) return;
    const getScope = await GET(new Request("http://localhost/api/brief/alerts", {
      headers: { authorization: `Bearer ${tasksOnly.token}` },
    }));
    assert.equal(getScope.status, 403);
    assert.equal((await getScope.json()).code, "insufficient_scope");
    const postScope = await POST(new Request("http://localhost/api/brief/alerts/evaluate", {
      method: "POST",
      headers: { authorization: `Bearer ${tasksOnly.token}` },
    }));
    assert.equal(postScope.status, 403);

    const reader = await createCredential({ label: "brief reader", scopes: ["progress:read"] });
    assert.equal(reader.ok, true);
    if (!reader.ok) return;
    const getOk = await GET(new Request("http://localhost/api/brief/alerts", {
      headers: { authorization: `Bearer ${reader.token}` },
    }));
    assert.equal(getOk.status, 200);
    const postReader = await POST(new Request("http://localhost/api/brief/alerts/evaluate", {
      method: "POST",
      headers: { authorization: `Bearer ${reader.token}` },
    }));
    assert.equal(postReader.status, 403);
    assert.equal((await postReader.json()).code, "insufficient_scope");

    const legacy = await POST(new Request("http://localhost/api/brief/alerts/evaluate", {
      method: "POST",
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(legacy.status, 200);
    const legacyBody = await legacy.json() as AlertEvaluation;
    assert.equal(legacyBody.sent_count, 0);
    assert.equal(world.messages.length, 0);

    delete env.MC_DASHBOARD_PASSWORD;
    const garbage = await GET(new Request("http://localhost/api/brief/alerts", {
      headers: { authorization: "Bearer akc_not-a-real-token" },
    }));
    assert.equal(garbage.status, 401);
  });

  it("F9 schema is additive and applying it twice is a no-op", () => {
    const migration = fs.readFileSync("supabase/migrations/20261028_brief_alerts.sql", "utf8");
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    const statements = migration
      .split(";")
      .map((part) => part.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
      .filter(Boolean);
    assert.equal(statements.length >= 2, true);
    for (const statement of statements) {
      assert.match(statement, /if not exists/i);
      assert.equal(/\b(drop|delete|truncate|alter column)\b/i.test(statement), false);
    }
    assert.match(migration, /create table if not exists brief_alerts/i);
    assert.match(schema, /create table if not exists brief_alerts/i);
    for (const name of ["key text primary key", "first_sent_at timestamptz not null", "last_sent_at timestamptz not null", "cleared_at timestamptz"]) {
      assert.equal(migration.includes(name), true);
      assert.equal(schema.includes(name), true);
    }
    assert.match(schema, /alter table brief_alerts add column if not exists cleared_at timestamptz/i);
    assert.match(migration, /add column if not exists claim_token text/i);
    assert.match(schema, /add column if not exists claim_token text/i);
    const spec = openApiDocument() as {
      paths: Record<string, { get?: unknown; post?: unknown }>;
      components: { schemas: { BriefAlert: { required?: string[] } } };
    };
    assert.equal(spec.components.schemas.BriefAlert.required?.includes("last_sent_at"), true);
    assert.ok(spec.paths["/api/brief/alerts"].get);
    assert.ok(spec.paths["/api/brief/alerts/evaluate"].post);
    assert.equal(spec.paths["/api/brief/alerts"].post, undefined);
    const velocity = fs.readFileSync("docs/VELOCITY.md", "utf8");
    assert.match(velocity, /No other pushes/);
    assert.match(velocity, /brief\.alerts\.enabled/);
    const api = fs.readFileSync("docs/API.md", "utf8");
    assert.match(api, /\/api\/brief\/alerts/);
    assert.match(api, /POST \| `\/api\/brief\/alerts\/evaluate`/);
  });

  it("stale zero-merge coverage is unknown until the quiet window is measured", async () => {
    const alerts = settings().alerts;
    const nowMs = T.getTime();
    const hourStale = [{ repo: "r", collectedAt: nowMs - H, merged: [{ merged_at: at(T, -80 * H) }] }];
    assert.equal(classifyZeroMerge(hourStale, nowMs, alerts), "unknown");
    const pastCadence = [{ repo: "r", collectedAt: nowMs - 16 * M, merged: [{ merged_at: at(T, -80 * H) }] }];
    assert.equal(classifyZeroMerge(pastCadence, nowMs, alerts), "unknown");
    const withinCadence = [{ repo: "r", collectedAt: nowMs - 14 * M, merged: [{ merged_at: at(T, -80 * H) }] }];
    assert.equal(classifyZeroMerge(withinCadence, nowMs, alerts), "firing");
    const observed = [{ repo: "r", collectedAt: nowMs - H, merged: [{ merged_at: at(T, -H) }] }];
    assert.equal(classifyZeroMerge(observed, nowMs, alerts), "clear");

    useDb();
    const on = settings({ enabled: true, agentId: null });
    watch("example-org/stale");
    snap("example-org/stale", at(T, -H), [{ merged_at: at(T, -80 * H) }]);
    const report = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(report, "zero-merge:example-org/stale").condition, "unknown");
    assert.equal(report.sent_count, 0);
    assert.equal(messagesFor("zero-merge:example-org/stale").length, 0);
    assert.equal(world.alerts.has("zero-merge:example-org/stale"), false);
  });

  it("a failed send does not restore over a concurrent clear", async () => {
    useDb();
    const on = settings({ enabled: true });
    const key = "coordinator-silent:carmack";
    silence(T, 4 * H);
    watch("example-org/quiet");
    snap("example-org/quiet", at(T, 0), [{ merged_at: at(T, -H) }]);

    const first = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(first, key).condition, "firing");
    assert.equal(hit(first, key).sent, true);
    assert.equal(messagesFor(key).length, 1);
    assert.equal(world.alerts.get(key)?.cleared ?? null, null);

    const later = new Date(T.getTime() + 12 * H);
    silence(later, 4 * H);
    world.beforeMessageInsert = () => {
      const row = world.alerts.get(key);
      assert.ok(row, "the repeat claim lands before the message insert");
      row.cleared = row.last;
    };
    world.failMessageInserts = 1;
    const raced = await evaluateAlerts({ now: later, settings: on });
    assert.equal(raced.sent_count, 0);
    assert.equal(messagesFor(key).length, 1);
    const row = world.alerts.get(key);
    assert.ok(row, "the cleared latch still exists");
    const laterIso = later.toISOString().replace(/\.\d{3}Z$/, "Z");
    assert.equal(row.cleared, laterIso);
    assert.equal(row.last, laterIso);
    assert.equal(hit(raced, key).sent, false);
    const restore = world.restoreTexts.join("\n");
    assert.match(restore, /claim_token\s*=/);
    assert.match(restore, /cleared_at\s+is\s+not\s+distinct\s+from/i);
    assert.match(world.claimTexts.join("\n"), /claim_token/);
    assert.equal(raced.failures?.some((failure) => failure.step === "message" && failure.key === key), true);
  });

  it("a failed first send does not delete a concurrently cleared latch", async () => {
    useDb();
    const on = settings({ enabled: true, agentId: null });
    const repo = "example-org/race";
    const key = `zero-merge:${repo}`;
    watch(repo);
    snap(repo, at(T, 0), [{ merged_at: at(T, -80 * H) }]);
    world.beforeMessageInsert = () => {
      const row = world.alerts.get(key);
      assert.ok(row, "the claim lands before the message insert");
      row.cleared = row.last;
    };
    world.failMessageInserts = 1;
    const raced = await evaluateAlerts({ now: T, settings: on });
    assert.equal(raced.sent_count, 0);
    assert.equal(messagesFor(key).length, 0);
    const row = world.alerts.get(key);
    assert.ok(row, "a concurrent clear keeps the row");
    assert.equal(row.cleared, T.toISOString().replace(/\.\d{3}Z$/, "Z"));
    assert.match(world.restoreTexts.join("\n"), /claim_token\s*=/);
    assert.match(world.restoreTexts.join("\n"), /cleared_at\s+is\s+not\s+distinct\s+from/i);
  });

  it("a missing brief_alerts table makes GET report latches unknown", async () => {
    useDb();
    world.fail.add("latches");
    silence(T, 4 * H);
    const read = await readAlerts({ now: T, settings: settings({ enabled: true }) });
    assert.equal(read.latches, "unknown");
    assert.equal(read.delivery, "read");
    assert.equal(read.alerts.length > 0, true);
    for (const alert of read.alerts) {
      assert.equal(alert.sent, null);
      assert.equal("last_sent_at" in alert, true);
    }
    assert.deepEqual(read.failures, [{ step: "latches" }]);

    const got = await GET(new Request("http://localhost/api/brief/alerts"));
    assert.equal(got.status, 200);
    const body = await got.json() as AlertEvaluation;
    assert.equal(body.latches, "unknown");
    assert.equal(body.alerts.every((alert) => alert.sent === null), true);
    assert.equal(body.alerts.some((alert) => alert.sent === false), false);

    const evaluated = await evaluateAlerts({ now: T, settings: settings({ enabled: true }) });
    assert.equal(evaluated.latches, "unknown");
    assert.equal(evaluated.sent_count, 0);
    assert.equal(world.messages.length, 0);
    assert.deepEqual(evaluated.failures, [
      { step: "claim", key: "coordinator-silent:carmack" },
      { step: "latches" },
    ]);
  });

  it("evaluate names the latch step that failed", async () => {
    useDb();
    const on = settings({ enabled: true });
    const key = "coordinator-silent:carmack";

    world.agents = [{ id: "carmack", last_seen_at: at(T, -M) }];
    world.events = [{ agent_id: "carmack", kind: "milestone", created_at: at(T, -M) }];
    world.fail.add("clear");
    const cleared = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(cleared, key).condition, "clear");
    assert.deepEqual(cleared.failures, [{ step: "clear", key }]);
    assert.equal(cleared.sent_count, 0);

    world.fail.delete("clear");
    world.fail.add("claim");
    silence(T, 4 * H);
    const claimed = await evaluateAlerts({ now: T, settings: on });
    assert.equal(hit(claimed, key).condition, "firing");
    assert.equal(claimed.sent_count, 0);
    assert.equal(messagesFor(key).length, 0);
    assert.deepEqual(claimed.failures, [{ step: "claim", key }]);

    world.fail.delete("claim");
    world.failMessageInserts = 1;
    const unsent = await evaluateAlerts({ now: T, settings: on });
    assert.equal(unsent.sent_count, 0);
    assert.equal(messagesFor(key).length, 0);
    assert.deepEqual(unsent.failures, [{ step: "message", key }]);
    assert.equal(world.alerts.has(key), false);
  });
});
