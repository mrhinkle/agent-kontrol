#!/usr/bin/env node
/**
 * Host watcher (mrhinkle/agent-kontrol#83).
 *
 * Pure functions parse the beats document, compare it to scripts/watch.config.json,
 * and decide which alerts to send from the previous state. The CLI injects the
 * clock, sleep, HTTP, notifiers, and state store. `--dry-run` performs no network
 * I/O to Agent Kontrol, Slack, or Telegram. With `--fixture <path>` it evaluates
 * that document and prints the decisions. It sends nothing, posts no beat, and
 * writes no state. With no fixture it prints "dry-run: no fixture, nothing evaluated"
 * and exits 0.
 *
 * Suppression boundary: a successful delivery is repeated when
 * now >= lastDeliveredAt + 12h, and held back one millisecond earlier.
 * Recovery is one send per destination that received that alert key.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export const SUPPRESS_MS = 12 * 60 * 60 * 1000;
export const RETRY_DELAY_MS = 30_000;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const READ_TIMEOUT_MS = 10_000;

const STATUSES = new Set(["ok", "held", "paused", "stale", "failing", "unknown"]);
const UNHEALTHY = new Set(["stale", "failing", "paused", "unknown"]);
const HEALTHY = new Set(["ok", "held"]);
const HOST_SOURCES = new Set(["mini", "macbook"]);
const DESTINATIONS = new Set(["slack", "telegram"]);
const SELF_SOURCE = "watcher";
const DETAIL_MAX = 500;

const CONFIG_PATH = fileURLToPath(new URL("./watch.config.json", import.meta.url));

export function freshState() {
  return { version: 1, alerts: {} };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePoints(value) {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

export function redact(text, secrets) {
  let out = String(text);
  const list = Array.isArray(secrets) ? secrets : [];
  const sorted = list
    .filter((secret) => typeof secret === "string" && secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of sorted) out = out.split(secret).join("[redacted]");
  out = out.replace(/https:\/\/hooks\.slack\.com\/services\/[^\s'")]+/g, "[redacted-url]");
  out = out.replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, "[redacted-token]");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(/(authorization\s*[:=]\s*)(\S+)/gi, "$1[redacted]");
  return out;
}

export function parseJsonBody(text) {
  if (typeof text !== "string") return { ok: false, reason: "malformed-json" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
}

function fail(reason) {
  return { ok: false, reason };
}

function validateBeatRow(row) {
  if (!isPlainObject(row)) return fail("row-type");
  const source = row.source;
  if (typeof source !== "string" || source.length === 0 || /[\r\n|]/.test(source)) return fail("source-type");
  const status = row.status;
  if (typeof status !== "string" || !STATUSES.has(status)) return fail("status-type");
  if (typeof row.detail !== "string" || codePoints(row.detail) > DETAIL_MAX) return fail("detail-type");
  if (typeof row.beat_at !== "string" || row.beat_at.length === 0) return fail("beat-at-type");
  if (typeof row.received_at !== "string" || row.received_at.length === 0) return fail("received-at-type");
  const age = row.age_s;
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0) return fail("age-type");
  return {
    ok: true,
    beat: {
      source,
      status,
      detail: row.detail,
      beat_at: row.beat_at,
      received_at: row.received_at,
      age_s: age,
    },
  };
}

/**
 * A successful read is one object whose `beats` field is an array of typed rows.
 * @param {unknown} value
 * @returns {{ ok: true, beats: Array<{ source: string, status: string, detail: string, beat_at: string, received_at: string, age_s: number }> } | { ok: false, reason: string }}
 */
export function parseBeatsResponse(value) {
  if (!isPlainObject(value)) return fail("not-object");
  if (!Array.isArray(value.beats)) return fail("beats-not-array");
  const seen = new Set();
  const beats = [];
  for (const row of value.beats) {
    const checked = validateBeatRow(row);
    if (!checked.ok) return checked;
    if (seen.has(checked.beat.source)) return fail("duplicate-source");
    seen.add(checked.beat.source);
    beats.push(checked.beat);
  }
  return { ok: true, beats };
}

export function interpretHttpRead(response) {
  if (!response || response.error) return fail(response && response.error ? response.error : "network");
  if (typeof response.status !== "number" || response.status < 200 || response.status >= 300) {
    return fail("http");
  }
  const json = parseJsonBody(response.body);
  if (!json.ok) return json;
  return parseBeatsResponse(json.value);
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, config: { sources: Array<{ source: string, max_age_s: number, enabled: boolean }> } } | { ok: false, reason: string }}
 */
export function loadConfig(raw) {
  let parsed;
  if (typeof raw === "string") {
    const json = parseJsonBody(raw);
    if (!json.ok) return fail("config-json");
    parsed = json.value;
  } else {
    parsed = raw;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.sources)) return fail("config-shape");
  const sources = [];
  const seen = new Set();
  for (const row of parsed.sources) {
    if (!isPlainObject(row)) return fail("config-source");
    if (typeof row.source !== "string" || !HOST_SOURCES.has(row.source)) return fail("config-source");
    if (seen.has(row.source)) return fail("config-duplicate");
    seen.add(row.source);
    if (typeof row.enabled !== "boolean") return fail("config-enabled");
    if (typeof row.max_age_s !== "number" || !Number.isInteger(row.max_age_s) || row.max_age_s <= 0) {
      return fail("config-age");
    }
    sources.push({ source: row.source, max_age_s: row.max_age_s, enabled: row.enabled });
  }
  return { ok: true, config: { sources } };
}

/**
 * Expected enabled sources, not the rows that happened to come back.
 * `watcher` is this monitor and is never a host. Unknown sources are ignored.
 * Equality with max_age_s is within the limit. ok/held past the limit are `stale`.
 * stale|failing|paused|unknown are `unhealthy:<status>` at any age.
 */
export function evaluateSources(beats, sources) {
  const bySource = new Map();
  for (const beat of beats) bySource.set(beat.source, beat);
  const findings = [];
  for (const expected of sources) {
    if (!expected.enabled) continue;
    if (expected.source === SELF_SOURCE) continue;
    const row = bySource.get(expected.source);
    if (!row || row.source === SELF_SOURCE) {
      findings.push({ source: expected.source, condition: "source-missing" });
      continue;
    }
    if (UNHEALTHY.has(row.status)) {
      findings.push({ source: expected.source, condition: `unhealthy:${row.status}` });
      continue;
    }
    if (!HEALTHY.has(row.status)) {
      findings.push({ source: expected.source, condition: `unhealthy:${row.status}` });
      continue;
    }
    if (row.age_s > expected.max_age_s) {
      findings.push({
        source: expected.source,
        condition: "stale",
        age_s: row.age_s,
        max_age_s: expected.max_age_s,
      });
    }
  }
  return findings;
}

export function alertKey(destination, source, condition) {
  return `${destination}|${source}|${condition}`;
}

export function unreachableKey(destination) {
  return `${destination}|api-unreachable`;
}

export function beatFailedKey(destination) {
  return `${destination}|beat-post-failed`;
}

export function parseAlertKey(key) {
  if (typeof key !== "string") return null;
  const parts = key.split("|");
  if (parts.length === 2 && DESTINATIONS.has(parts[0]) && parts[1] === "api-unreachable") {
    return { destination: parts[0], kind: "unreachable" };
  }
  if (parts.length === 2 && DESTINATIONS.has(parts[0]) && parts[1] === "beat-post-failed") {
    return { destination: parts[0], kind: "beat-post" };
  }
  if (parts.length === 3 && DESTINATIONS.has(parts[0]) && parts[1] && parts[2]) {
    if (!/^(source-missing|stale|unhealthy:(ok|held|paused|stale|failing|unknown))$/.test(parts[2])) {
      return null;
    }
    if (parts[1] === SELF_SOURCE || /[\r\n|]/.test(parts[1])) return null;
    return { destination: parts[0], kind: "host", source: parts[1], condition: parts[2] };
  }
  return null;
}

function isEntry(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "lastDeliveredAt" && key !== "pending" && key !== "recoveryPending") return false;
  }
  if (!("lastDeliveredAt" in value) || !("pending" in value) || !("recoveryPending" in value)) return false;
  if (value.lastDeliveredAt !== null && typeof value.lastDeliveredAt !== "string") return false;
  if (typeof value.lastDeliveredAt === "string" && !Number.isFinite(Date.parse(value.lastDeliveredAt))) return false;
  if (typeof value.pending !== "boolean" || typeof value.recoveryPending !== "boolean") return false;
  return true;
}

export function parseState(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, state: freshState() };
  const json = parseJsonBody(raw);
  if (!json.ok || !isPlainObject(json.value)) return { ok: false, state: freshState() };
  const value = json.value;
  if (value.version !== 1 || !isPlainObject(value.alerts)) return { ok: false, state: freshState() };
  if (Object.keys(value).some((key) => key !== "version" && key !== "alerts")) {
    return { ok: false, state: freshState() };
  }
  const alerts = {};
  for (const [key, entry] of Object.entries(value.alerts)) {
    if (!parseAlertKey(key) || !isEntry(entry)) return { ok: false, state: freshState() };
    alerts[key] = {
      lastDeliveredAt: entry.lastDeliveredAt,
      pending: entry.pending,
      recoveryPending: entry.recoveryPending,
    };
  }
  return { ok: true, state: { version: 1, alerts } };
}

/** Resend at exactly 12h. One millisecond earlier stays suppressed. */
export function shouldDeliver(entry, now) {
  if (!entry || entry.pending || !entry.lastDeliveredAt) return true;
  const delivered = Date.parse(entry.lastDeliveredAt);
  if (!Number.isFinite(delivered)) return true;
  return now >= delivered + SUPPRESS_MS;
}

function messageFor(finding) {
  if (finding.condition === "source-missing") return `watch-source-missing:${finding.source}`;
  if (finding.condition === "stale") {
    if (typeof finding.age_s === "number" && typeof finding.max_age_s === "number") {
      return `watch stale:${finding.source} age_s=${finding.age_s} limit=${finding.max_age_s}`;
    }
    return `watch stale:${finding.source}`;
  }
  return `watch ${finding.condition}:${finding.source}`;
}

function recoveryMessage(parsed) {
  if (parsed.kind === "unreachable") return "watch recovered:api-unreachable";
  return `watch recovered:${parsed.source} ${parsed.condition}`;
}

/**
 * Actions to attempt now. Suppression is listed and not sent.
 * A failed read yields only api-unreachable. It does not recover host keys.
 */
export function decideSends({ readOk, findings, state, now, destinations }) {
  const actions = [];
  const suppressedKeys = [];
  const alerts = state && state.alerts ? state.alerts : {};

  if (!readOk) {
    for (const destination of destinations) {
      const key = unreachableKey(destination);
      if (shouldDeliver(alerts[key], now)) {
        actions.push({ key, destination, kind: "alert", text: "watch-api-unreachable" });
      } else {
        suppressedKeys.push(key);
      }
    }
    return { actions, suppressedKeys };
  }

  for (const destination of destinations) {
    for (const finding of findings) {
      const key = alertKey(destination, finding.source, finding.condition);
      if (shouldDeliver(alerts[key], now)) {
        actions.push({ key, destination, kind: "alert", text: messageFor(finding) });
      } else {
        suppressedKeys.push(key);
      }
    }
    for (const [key, entry] of Object.entries(alerts)) {
      const parsed = parseAlertKey(key);
      if (!parsed || parsed.destination !== destination || parsed.kind === "beat-post") continue;
      if (parsed.kind === "unreachable") {
        if (entry.lastDeliveredAt) {
          actions.push({ key, destination, kind: "recovery", text: recoveryMessage(parsed) });
        }
        continue;
      }
      const still = findings.some(
        (finding) => finding.source === parsed.source && finding.condition === parsed.condition,
      );
      if (still) continue;
      const sourceHealthy = !findings.some((finding) => finding.source === parsed.source);
      if (sourceHealthy) {
        if (entry.lastDeliveredAt) {
          actions.push({ key, destination, kind: "recovery", text: recoveryMessage(parsed) });
        }
        continue;
      }
      if (entry.pending && !entry.lastDeliveredAt) {
        actions.push({
          key,
          destination,
          kind: "alert",
          text: messageFor({ source: parsed.source, condition: parsed.condition }),
        });
      }
    }
  }
  return { actions, suppressedKeys };
}

function copyEntry(entry) {
  return {
    lastDeliveredAt: entry.lastDeliveredAt,
    pending: entry.pending,
    recoveryPending: entry.recoveryPending,
  };
}

function deliveredEntry(now) {
  return { lastDeliveredAt: new Date(now).toISOString(), pending: false, recoveryPending: false };
}

function failedAlertEntry(prev) {
  return {
    lastDeliveredAt: prev && prev.lastDeliveredAt ? prev.lastDeliveredAt : null,
    pending: true,
    recoveryPending: false,
  };
}

function applyBeatKeys(alerts, prior, situation, byKey, now) {
  for (const destination of situation.destinations) {
    const key = beatFailedKey(destination);
    const prev = prior.alerts[key];
    const result = byKey.get(key);
    delete alerts[key];
    if (!situation.beatAttempted) {
      if (prev) alerts[key] = copyEntry(prev);
      continue;
    }
    if (!situation.beatOk) {
      if (result && result.kind === "alert" && result.ok) alerts[key] = deliveredEntry(now);
      else if (result && result.kind === "alert" && !result.ok) alerts[key] = failedAlertEntry(prev);
      else if (prev) alerts[key] = copyEntry(prev);
      continue;
    }
    if (prev && prev.lastDeliveredAt) {
      if (result && result.kind === "recovery" && result.ok) continue;
      alerts[key] = { lastDeliveredAt: prev.lastDeliveredAt, pending: false, recoveryPending: true };
    }
  }
}

/** Next dedup state after this run's send results. Does not invent a recovery. */
export function nextState(prior, situation, results, now) {
  const byKey = new Map(results.map((result) => [result.key, result]));
  const alerts = {};
  const findings = situation.readOk ? situation.findings : [];
  const destinations = situation.destinations;

  if (!situation.readOk) {
    for (const [key, entry] of Object.entries(prior.alerts)) alerts[key] = copyEntry(entry);
    for (const destination of destinations) {
      const key = unreachableKey(destination);
      const result = byKey.get(key);
      const prev = prior.alerts[key];
      if (!result) {
        if (prev) alerts[key] = copyEntry(prev);
        continue;
      }
      if (result.kind === "alert" && result.ok) alerts[key] = deliveredEntry(now);
      else alerts[key] = failedAlertEntry(prev);
    }
    applyBeatKeys(alerts, prior, situation, byKey, now);
    return { version: 1, alerts };
  }

  const active = new Set();
  for (const destination of destinations) {
    for (const finding of findings) active.add(alertKey(destination, finding.source, finding.condition));
  }
  const seen = new Set([...Object.keys(prior.alerts), ...byKey.keys(), ...active]);

  for (const key of seen) {
    const parsed = parseAlertKey(key);
    if (!parsed || parsed.kind === "beat-post") continue;
    const prev = prior.alerts[key];
    const result = byKey.get(key);

    if (parsed.kind === "unreachable") {
      if (!(prev && prev.lastDeliveredAt)) continue;
      if (result && result.kind === "recovery" && result.ok) continue;
      alerts[key] = { lastDeliveredAt: prev.lastDeliveredAt, pending: false, recoveryPending: true };
      continue;
    }

    const sourceFindings = findings.filter((finding) => finding.source === parsed.source);
    const still = sourceFindings.some((finding) => finding.condition === parsed.condition);
    const healthy = sourceFindings.length === 0;

    if (still) {
      if (result && result.kind === "alert" && result.ok) alerts[key] = deliveredEntry(now);
      else if (result && result.kind === "alert" && !result.ok) alerts[key] = failedAlertEntry(prev);
      else if (prev) alerts[key] = { ...copyEntry(prev), pending: false, recoveryPending: false };
      continue;
    }

    if (healthy) {
      if (!(prev && prev.lastDeliveredAt)) continue;
      if (result && result.kind === "recovery" && result.ok) continue;
      alerts[key] = { lastDeliveredAt: prev.lastDeliveredAt, pending: false, recoveryPending: true };
      continue;
    }

    if (prev && prev.pending && !prev.lastDeliveredAt) {
      if (result && result.kind === "alert" && result.ok) alerts[key] = deliveredEntry(now);
      else if (result && result.kind === "alert" && !result.ok) alerts[key] = failedAlertEntry(prev);
      else alerts[key] = copyEntry(prev);
      continue;
    }
    if (prev && prev.lastDeliveredAt) {
      alerts[key] = { lastDeliveredAt: prev.lastDeliveredAt, pending: false, recoveryPending: false };
    }
  }

  applyBeatKeys(alerts, prior, situation, byKey, now);
  return { version: 1, alerts };
}

async function attemptRead(request) {
  try {
    return interpretHttpRead(await request());
  } catch {
    return fail("network");
  }
}

export async function readBeatsWithRetry({ request, sleep }) {
  const first = await attemptRead(request);
  if (first.ok) return first;
  await sleep(RETRY_DELAY_MS);
  return attemptRead(request);
}

export function interpretSlackResponse(response) {
  if (!response || response.error) return { ok: false, reason: response && response.error ? response.error : "network" };
  if (typeof response.status !== "number" || response.status < 200 || response.status >= 300) {
    return { ok: false, reason: "http" };
  }
  return { ok: true };
}

export function interpretTelegramResponse(response) {
  if (!response || response.error) return { ok: false, reason: response && response.error ? response.error : "network" };
  if (typeof response.status !== "number" || response.status < 200 || response.status >= 300) {
    return { ok: false, reason: "http" };
  }
  const json = parseJsonBody(response.body);
  if (!json.ok || !isPlainObject(json.value) || json.value.ok !== true) return { ok: false, reason: "not-ok" };
  return { ok: true };
}

export function interpretBeatResponse(response) {
  if (!response || response.error) return { ok: false, reason: response && response.error ? response.error : "network" };
  if (typeof response.status !== "number" || response.status < 200 || response.status >= 300) {
    return { ok: false, reason: "http" };
  }
  const json = parseJsonBody(response.body);
  if (!json.ok || !isPlainObject(json.value) || json.value.ok !== true) return { ok: false, reason: "not-ok" };
  return { ok: true };
}

export function createNotifier({ http, credentials, log, secrets }) {
  const write = (line) => log(redact(line, secrets));
  return async function notify({ destination, text, timeoutMs }) {
    const timeout = timeoutMs ?? DELIVERY_TIMEOUT_MS;
    try {
      if (destination === "slack") {
        const webhook = credentials.slackWebhook;
        if (typeof webhook !== "string" || !webhook.startsWith("https://hooks.slack.com/services/")) {
          write("delivery failed slack destination");
          return { ok: false };
        }
        const response = await http({
          url: webhook,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          timeoutMs: timeout,
        });
        const result = interpretSlackResponse(response);
        if (!result.ok) write(`delivery failed slack ${result.reason}`);
        return { ok: result.ok };
      }
      if (destination === "telegram") {
        const token = credentials.telegramToken;
        const chat = credentials.telegramChat;
        if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
          write("delivery failed telegram destination");
          return { ok: false };
        }
        if ((typeof chat !== "string" && typeof chat !== "number") || !/^-?\d+$/.test(String(chat))) {
          write("delivery failed telegram destination");
          return { ok: false };
        }
        const response = await http({
          url: `https://api.telegram.org/bot${token}/sendMessage`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: String(chat), text }),
          timeoutMs: timeout,
        });
        const result = interpretTelegramResponse(response);
        if (!result.ok) write(`delivery failed telegram ${result.reason}`);
        return { ok: result.ok };
      }
      write(`delivery failed ${destination} unknown`);
      return { ok: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      write(`delivery failed ${destination} ${message}`);
      return { ok: false };
    }
  };
}

function allowedFetchTarget(raw) {
  if (typeof raw !== "string" || raw.includes("\0")) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "http:") return local;
  return url.protocol === "https:";
}

export async function defaultHttp(call) {
  if (!allowedFetchTarget(call.url)) return { error: "network" };
  try {
    const response = await fetch(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      redirect: "manual",
      signal: AbortSignal.timeout(call.timeoutMs),
    });
    const body = await response.text();
    return { status: response.status, body };
  } catch (error) {
    const name = error && error.name;
    if (name === "TimeoutError" || name === "AbortError") return { error: "timeout" };
    return { error: "network" };
  }
}

export function assertWatchUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return fail("url");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail("url");
  }
  if (url.username || url.password) return fail("url-userinfo");
  const host = url.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "https:") return { ok: true, origin: url.origin };
  if (url.protocol === "http:" && local) return { ok: true, origin: url.origin };
  return fail("scheme");
}

export function watchExitCode({ dryRun, readOk, findings, results, beatOk, beatAttempted }) {
  if (!readOk) return 1;
  if (findings.length > 0) return 1;
  if (!dryRun && results.some((result) => result.ok !== true)) return 1;
  if (beatAttempted && beatOk !== true) return 1;
  return 0;
}

async function loadPriorState(options, safeLog) {
  if (options.state) return options.state;
  if (options.stateText !== undefined) {
    const parsed = parseState(options.stateText);
    if (!parsed.ok) safeLog("watch state corrupt; starting fresh");
    return parsed.state;
  }
  if (!options.stateStore) return freshState();
  let raw;
  try {
    raw = await options.stateStore.read();
  } catch (error) {
    safeLog(`watch state unreadable; starting fresh ${error && error.name ? error.name : ""}`.trim());
    return freshState();
  }
  if (raw === null || raw === undefined) {
    safeLog("watch state missing; starting fresh");
    return freshState();
  }
  const parsed = parseState(raw);
  if (!parsed.ok) safeLog("watch state corrupt; starting fresh");
  return parsed.state;
}

function beatDetail(readOk, deliveryFailed) {
  return `read=${readOk ? "ok" : "failed"} delivery=${deliveryFailed ? "failed" : "ok"}`;
}

/**
 * One watcher pass. Adapters: clock/now, sleep, request or readResult,
 * notify, postBeat, stateStore, log. Dry-run prints each finding and planned
 * send, then returns before notify, postBeat, or a state write. The read is
 * the caller's fixture or an already stubbed readResult.
 */
export async function runWatch(options) {
  const now = typeof options.now === "number" ? options.now : options.clock();
  const secrets = options.secrets ?? [];
  const log = options.log ?? (() => {});
  const safeLog = (line) => log(redact(line, secrets));
  const dryRun = options.dryRun === true;
  const destinations = options.destinations ?? [];
  const state = await loadPriorState(options, safeLog);

  let read;
  if (options.readResult) {
    read = options.readResult;
  } else if (options.fixtureBody !== undefined) {
    read = interpretHttpRead({ status: 200, body: options.fixtureBody });
  } else {
    read = await readBeatsWithRetry({ request: options.request, sleep: options.sleep });
  }

  const readOk = read.ok === true;
  const findings = readOk ? evaluateSources(read.beats, options.config.sources) : [];
  const plan = decideSends({ readOk, findings, state, now, destinations });
  safeLog(
    `watch read=${readOk ? "ok" : "failed"} findings=${findings.length} actions=${plan.actions.length} suppressed=${plan.suppressedKeys.length} dry_run=${dryRun}`,
  );

  if (dryRun) {
    for (const finding of findings) {
      safeLog(`dry-run decision ${finding.source} ${finding.condition}`);
    }
    for (const action of plan.actions) {
      safeLog(`dry-run ${action.kind} ${action.destination} ${action.key}`);
    }
    return watchExitCode({
      dryRun: true,
      readOk,
      findings,
      results: [],
      beatOk: true,
      beatAttempted: false,
    });
  }

  const results = [];
  for (const action of plan.actions) {
    try {
      const sent = await options.notify({
        destination: action.destination,
        text: action.text,
        timeoutMs: DELIVERY_TIMEOUT_MS,
      });
      const ok = Boolean(sent && sent.ok);
      results.push({ key: action.key, kind: action.kind, ok });
      safeLog(`${action.destination} ${action.kind} ${ok ? "ok" : "failed"} ${action.key}`);
    } catch (error) {
      results.push({ key: action.key, kind: action.kind, ok: false });
      const message = error instanceof Error ? error.message : "error";
      safeLog(`${action.destination} ${action.kind} failed ${action.key} ${message}`);
    }
  }

  const phaseFailed = results.some((result) => !result.ok);
  const cannotReport = destinations.length === 0 && (!readOk || findings.length > 0);
  if (cannotReport) safeLog("no alert destination configured");
  const deliveryFailed = phaseFailed || cannotReport;
  const watcherStatus = readOk && !deliveryFailed ? "ok" : "failing";
  const beat = {
    source: SELF_SOURCE,
    status: watcherStatus,
    detail: beatDetail(readOk, deliveryFailed),
    beat_at: new Date(now).toISOString(),
  };

  let beatOk = false;
  try {
    const posted = await options.postBeat(beat);
    beatOk = Boolean(posted && posted.ok);
  } catch (error) {
    beatOk = false;
    const message = error instanceof Error ? error.message : "error";
    safeLog(`watcher beat failed ${message}`);
  }
  safeLog(beatOk ? "watcher beat stored" : "watcher beat failed");

  if (!beatOk) {
    for (const destination of destinations) {
      const key = beatFailedKey(destination);
      if (!shouldDeliver(state.alerts[key], now)) continue;
      try {
        const sent = await options.notify({
          destination,
          text: "watch beat-post-failed",
          timeoutMs: DELIVERY_TIMEOUT_MS,
        });
        results.push({ key, kind: "alert", ok: Boolean(sent && sent.ok) });
      } catch (error) {
        results.push({ key, kind: "alert", ok: false });
        const message = error instanceof Error ? error.message : "error";
        safeLog(`beat failure notice failed ${message}`);
      }
    }
  } else {
    for (const destination of destinations) {
      const key = beatFailedKey(destination);
      const entry = state.alerts[key];
      if (!(entry && entry.lastDeliveredAt)) continue;
      try {
        const sent = await options.notify({
          destination,
          text: "watch recovered:beat-post-failed",
          timeoutMs: DELIVERY_TIMEOUT_MS,
        });
        results.push({ key, kind: "recovery", ok: Boolean(sent && sent.ok) });
      } catch {
        results.push({ key, kind: "recovery", ok: false });
      }
    }
  }

  const situation = {
    readOk,
    findings,
    destinations,
    beatOk,
    beatAttempted: true,
  };
  const next = nextState(state, situation, results, now);
  if (options.stateStore) await options.stateStore.write(next);

  return watchExitCode({
    dryRun: false,
    readOk,
    findings,
    results,
    beatOk,
    beatAttempted: true,
  });
}

/** Operator paths stay under the working directory or the system temp dir. */
export function resolveInsideRoots(userPath) {
  if (typeof userPath !== "string" || userPath.length === 0 || userPath.includes("\0")) return null;
  const resolved = path.resolve(userPath);
  const roots = [path.resolve(process.cwd()), path.resolve(os.tmpdir())];
  for (const root of roots) {
    try {
      const realRoot = realpathSync(root);
      if (!roots.includes(realRoot)) roots.push(realRoot);
    } catch {
      // The root itself may not exist yet. The lexical path is still a bound.
    }
  }
  const inside = (candidate) =>
    roots.some((root) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`));
  if (!inside(resolved)) return null;
  try {
    const real = realpathSync(resolved);
    if (!inside(real)) return null;
    return real;
  } catch {
    return resolved;
  }
}

export function fileStateStore(file) {
  return {
    async read() {
      try {
        return await readFile(file, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(state) {
      const dir = path.dirname(file);
      await mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
      await writeFile(tmp, `${JSON.stringify(state)}\n`);
      await rename(tmp, file);
    },
  };
}

function collectSecrets(env) {
  return [env.WATCH_AK_KEY, env.WATCH_SLACK_WEBHOOK, env.WATCH_TELEGRAM_TOKEN, env.WATCH_TELEGRAM_CHAT].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
}

function destinationsFromEnv(env) {
  const list = [];
  if (env.WATCH_SLACK_WEBHOOK) list.push("slack");
  if (env.WATCH_TELEGRAM_TOKEN && env.WATCH_TELEGRAM_CHAT) list.push("telegram");
  return list;
}

function parseWatchArgs(argv) {
  let dryRun = false;
  let fixturePath;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--fixture") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return { error: "watch fixture requires a path" };
      if (fixturePath !== undefined) return { error: "watch unknown argument" };
      fixturePath = next;
      i += 1;
      continue;
    }
    return { error: "watch unknown argument" };
  }
  if (fixturePath !== undefined && !dryRun) return { error: "watch fixture requires --dry-run" };
  return { dryRun, fixturePath };
}

export async function main(argv, env, adapters = {}) {
  const log = adapters.log ?? ((line) => console.log(line));
  const secrets = collectSecrets(env);
  const safeLog = (line) => log(redact(line, secrets));
  const parsed = parseWatchArgs(argv);
  if (parsed.error) {
    safeLog(parsed.error);
    return 1;
  }
  const dryRun = parsed.dryRun === true;

  if (dryRun && parsed.fixturePath === undefined) {
    safeLog("dry-run: no fixture, nothing evaluated");
    return 0;
  }

  let configRaw;
  try {
    configRaw = await readFile(adapters.configPath ?? CONFIG_PATH, "utf8");
  } catch {
    safeLog("watch config unreadable");
    return 1;
  }
  const loaded = loadConfig(configRaw);
  if (!loaded.ok) {
    safeLog(`watch config invalid ${loaded.reason}`);
    return 1;
  }

  let fixtureBody;
  if (parsed.fixturePath !== undefined) {
    const resolved = resolveInsideRoots(parsed.fixturePath);
    if (!resolved) {
      safeLog("watch fixture path rejected");
      return 1;
    }
    try {
      fixtureBody = await readFile(resolved, "utf8");
    } catch {
      safeLog("watch fixture unreadable");
      return 1;
    }
  }

  const statePath = resolveInsideRoots(env.WATCH_STATE_PATH || path.join(process.cwd(), ".watch-state", "state.json"));
  if (!statePath) {
    safeLog("watch state path rejected");
    return 1;
  }
  const http = adapters.http ?? defaultHttp;
  const sleep = adapters.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = adapters.clock ?? (() => Date.now());

  if (dryRun) {
    try {
      return await runWatch({
        config: loaded.config,
        destinations: destinationsFromEnv(env),
        dryRun: true,
        now: adapters.now,
        clock,
        sleep,
        fixtureBody,
        notify: adapters.notify ?? (async () => ({ ok: false })),
        postBeat: adapters.postBeat ?? (async () => ({ ok: false })),
        stateStore: adapters.stateStore ?? fileStateStore(statePath),
        log,
        secrets,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      safeLog(`watch failed ${message}`);
      return 1;
    }
  }

  const checked = assertWatchUrl(env.WATCH_AK_URL);
  if (!checked.ok) {
    safeLog("watch AK URL rejected");
    return 1;
  }
  const origin = checked.origin;
  if (!env.WATCH_AK_KEY) {
    safeLog("watch AK credential missing");
    return 1;
  }

  const headers = { accept: "application/json", authorization: `Bearer ${env.WATCH_AK_KEY}` };
  const request = async () =>
    http({
      url: `${origin}/api/watch/beats`,
      method: "GET",
      headers,
      timeoutMs: READ_TIMEOUT_MS,
    });

  const postBeat =
    adapters.postBeat ??
    (async (beat) => {
      const response = await http({
        url: `${origin}/api/watch/beat`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.WATCH_AK_KEY}`,
        },
        body: JSON.stringify(beat),
        timeoutMs: DELIVERY_TIMEOUT_MS,
      });
      return interpretBeatResponse(response);
    });

  const notify =
    adapters.notify ??
    createNotifier({
      http,
      credentials: {
        slackWebhook: env.WATCH_SLACK_WEBHOOK,
        telegramToken: env.WATCH_TELEGRAM_TOKEN,
        telegramChat: env.WATCH_TELEGRAM_CHAT,
      },
      log,
      secrets,
    });

  try {
    return await runWatch({
      config: loaded.config,
      destinations: destinationsFromEnv(env),
      dryRun: false,
      now: adapters.now,
      clock,
      sleep,
      request,
      notify,
      postBeat,
      stateStore: adapters.stateStore ?? fileStateStore(statePath),
      log,
      secrets,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    safeLog(`watch failed ${message}`);
    return 1;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exit(code);
    })
    .catch(() => {
      process.exit(1);
    });
}
