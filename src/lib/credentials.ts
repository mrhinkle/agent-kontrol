/**
 * Per-agent credentials.
 *
 * The token is `akc_` plus 32 random bytes, base64url. It is shown once, at
 * creation. What we keep is the label, the first 8 characters (so the
 * operator can recognise it), the SHA-256 hex of the whole token, the scope
 * list, and timestamps: created, expires, revoked, last used. The token
 * itself is not stored. Prompts and tool input are not stored here.
 *
 * Each credential also has a request quota: requests per minute and
 * requests per UTC day, with the current window start and count for each.
 * Those counters are only counts. See credential-rate-limit.ts.
 *
 * With no DATABASE_URL the same operations run against an in-memory list so
 * demo mode behaves the same way. That list lives in the process and is not
 * shared across instances.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isConfigured, sql } from "./db";
import { isScope, SCOPES, type Scope } from "./scopes";
import {
  DEFAULT_REQUESTS_PER_DAY,
  DEFAULT_REQUESTS_PER_MINUTE,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MIN,
  isValidRateLimit,
} from "./credential-limits";

export type PublicCredential = {
  id: string;
  label: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  rate_limit_per_minute: number;
  rate_limit_per_day: number;
};

export {
  DEFAULT_REQUESTS_PER_DAY,
  DEFAULT_REQUESTS_PER_MINUTE,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MIN,
  isValidRateLimit,
};

/** Demo-mode window counters. Epoch milliseconds of each window start. */
type MemoryQuota = {
  minute_start: number | null;
  minute_count: number;
  day_start: number | null;
  day_count: number;
};

type StoredCredential = PublicCredential & { token_hash: string };
type MemoryCredential = StoredCredential & { quota: MemoryQuota };

// One list per process, kept on globalThis so every route bundle in a dev
// server sees the same demo credentials.
const memoryGlobal = globalThis as unknown as { __akCredentialMemory?: MemoryCredential[] };
const memory: MemoryCredential[] = (memoryGlobal.__akCredentialMemory ??= []);

function emptyQuota(): MemoryQuota {
  return { minute_start: null, minute_count: 0, day_start: null, day_count: 0 };
}

const DUMMY_HASH = createHash("sha256").update("akc_not-a-real-token").digest("hex");

let clock = (): number => Date.now();
let lastUsedWriter: ((id: string) => Promise<void>) | null = null;

/** Tests move time without sleeping. Production uses Date.now. */
export function setCredentialClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/**
 * Tests replace the last_used_at write to prove a failed write does not
 * fail the request. The replacement cannot change the allow decision.
 */
export function setLastUsedWriterForTests(fn: ((id: string) => Promise<void>) | null): void {
  lastUsedWriter = fn;
}

export function resetCredentialsForTests(): void {
  memory.splice(0, memory.length);
  clock = () => Date.now();
  lastUsedWriter = null;
}

export function credentialNow(): number {
  return clock();
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * A null stamp means "not set". A value that is present but cannot be parsed
 * becomes a past stamp, so a corrupt expiry or revocation fails closed.
 */
function presentStamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  return iso(value) ?? "1970-01-01T00:00:00.000Z";
}

function asScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [];
}

function toPublic(row: StoredCredential): PublicCredential {
  return {
    id: row.id,
    label: row.label,
    token_prefix: row.token_prefix,
    scopes: [...row.scopes],
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    rate_limit_per_minute: row.rate_limit_per_minute,
    rate_limit_per_day: row.rate_limit_per_day,
  };
}

function storedLimit(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function rowFromDb(row: Record<string, unknown>): StoredCredential {
  return {
    id: String(row.id),
    label: String(row.label),
    token_prefix: String(row.token_prefix),
    token_hash: String(row.token_hash ?? ""),
    scopes: asScopes(row.scopes),
    created_at: iso(row.created_at) ?? new Date(credentialNow()).toISOString(),
    expires_at: presentStamp(row.expires_at),
    revoked_at: presentStamp(row.revoked_at),
    last_used_at: iso(row.last_used_at),
    rate_limit_per_minute: storedLimit(row.rate_limit_per_minute, DEFAULT_REQUESTS_PER_MINUTE),
    rate_limit_per_day: storedLimit(row.rate_limit_per_day, DEFAULT_REQUESTS_PER_DAY),
  };
}

export const LABEL_MAX = 80;

const LIMIT_ERROR = `must be a whole number from ${RATE_LIMIT_MIN} to ${RATE_LIMIT_MAX.toLocaleString("en-US")}`;

/** Omitted or null means the default. Anything else must be a valid limit. */
function limitOrDefault(
  value: unknown,
  name: string,
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  if (!isValidRateLimit(value)) return { ok: false, error: `${name} ${LIMIT_ERROR}` };
  return { ok: true, value };
}

export function validateCredentialInput(input: {
  label: unknown;
  scopes: unknown;
  expires_at?: unknown;
  rate_limit_per_minute?: unknown;
  rate_limit_per_day?: unknown;
}):
  | {
      ok: true;
      label: string;
      scopes: Scope[];
      expires_at: string | null;
      rate_limit_per_minute: number;
      rate_limit_per_day: number;
    }
  | { ok: false; error: string } {
  if (typeof input.label !== "string") return { ok: false, error: "label is required" };
  const label = input.label.trim();
  if (!label || label.length > LABEL_MAX || /[\u0000-\u001f]/.test(label)) {
    return { ok: false, error: "label must be 1 to 80 characters" };
  }
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    return { ok: false, error: "scopes must list at least one scope" };
  }
  if (input.scopes.length > SCOPES.length) return { ok: false, error: "too many scopes" };
  const scopes: Scope[] = [];
  for (const item of input.scopes) {
    if (typeof item !== "string" || !isScope(item)) {
      return { ok: false, error: "unknown scope" };
    }
    if (!scopes.includes(item)) scopes.push(item);
  }
  let expires_at: string | null = null;
  if (input.expires_at != null && input.expires_at !== "") {
    if (typeof input.expires_at !== "string") return { ok: false, error: "expires_at must be an ISO timestamp" };
    const parsed = Date.parse(input.expires_at);
    if (Number.isNaN(parsed)) return { ok: false, error: "expires_at must be an ISO timestamp" };
    if (parsed <= credentialNow()) return { ok: false, error: "expires_at must be in the future" };
    expires_at = new Date(parsed).toISOString();
  }
  const perMinute = limitOrDefault(input.rate_limit_per_minute, "rate_limit_per_minute", DEFAULT_REQUESTS_PER_MINUTE);
  if (!perMinute.ok) return perMinute;
  const perDay = limitOrDefault(input.rate_limit_per_day, "rate_limit_per_day", DEFAULT_REQUESTS_PER_DAY);
  if (!perDay.ok) return perDay;
  return {
    ok: true,
    label,
    scopes,
    expires_at,
    rate_limit_per_minute: perMinute.value,
    rate_limit_per_day: perDay.value,
  };
}

const LIMIT_FIELDS = new Set(["id", "rate_limit_per_minute", "rate_limit_per_day"]);

/**
 * PATCH body for the limits: `id` plus at least one limit. Unknown fields,
 * null, strings, fractions, zero, negatives, and values over the maximum
 * are rejected. A limit that is left out keeps its stored value.
 */
export function validateLimitsInput(
  body: unknown,
):
  | { ok: true; id: string; rate_limit_per_minute: number | null; rate_limit_per_day: number | null }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!LIMIT_FIELDS.has(key)) return { ok: false, error: "unknown field" };
  }
  const id = record.id;
  if (typeof id !== "string" || !id || id.length > 64 || /[\u0000-\u001f]/.test(id)) {
    return { ok: false, error: "id is required" };
  }
  const has = (key: string) => Object.prototype.hasOwnProperty.call(record, key);
  if (!has("rate_limit_per_minute") && !has("rate_limit_per_day")) {
    return { ok: false, error: "send rate_limit_per_minute, rate_limit_per_day, or both" };
  }
  let perMinute: number | null = null;
  let perDay: number | null = null;
  if (has("rate_limit_per_minute")) {
    if (!isValidRateLimit(record.rate_limit_per_minute)) {
      return { ok: false, error: `rate_limit_per_minute ${LIMIT_ERROR}` };
    }
    perMinute = record.rate_limit_per_minute;
  }
  if (has("rate_limit_per_day")) {
    if (!isValidRateLimit(record.rate_limit_per_day)) {
      return { ok: false, error: `rate_limit_per_day ${LIMIT_ERROR}` };
    }
    perDay = record.rate_limit_per_day;
  }
  return { ok: true, id, rate_limit_per_minute: perMinute, rate_limit_per_day: perDay };
}

function mintToken(): { token: string; token_prefix: string; token_hash: string } {
  const token = `akc_${randomBytes(32).toString("base64url")}`;
  return { token, token_prefix: token.slice(0, 8), token_hash: sha256(token) };
}

async function noteUse(id: string): Promise<void> {
  try {
    if (lastUsedWriter) {
      await lastUsedWriter(id);
      return;
    }
    await writeLastUsed(id);
  } catch (e) {
    // The credential was already checked. A failed timestamp must not turn
    // a read the caller was allowed to make into an error.
    console.error("[credentials] last_used_at update failed", id, e instanceof Error ? e.name : "error");
  }
}

async function writeLastUsed(id: string): Promise<void> {
  const stamp = new Date(credentialNow()).toISOString();
  if (!isConfigured()) {
    const row = memory.find((item) => item.id === id);
    if (row) row.last_used_at = stamp;
    return;
  }
  const db = sql();
  await db`update agent_credentials set last_used_at = ${stamp} where id = ${id}`;
}

export async function createCredential(input: {
  label: unknown;
  scopes: unknown;
  expires_at?: unknown;
  rate_limit_per_minute?: unknown;
  rate_limit_per_day?: unknown;
}): Promise<{ ok: true; credential: PublicCredential; token: string } | { ok: false; error: string }> {
  const checked = validateCredentialInput(input);
  if (!checked.ok) return checked;
  const minted = mintToken();
  const row: MemoryCredential = {
    id: randomUUID(),
    label: checked.label,
    token_prefix: minted.token_prefix,
    token_hash: minted.token_hash,
    scopes: checked.scopes,
    created_at: new Date(credentialNow()).toISOString(),
    expires_at: checked.expires_at,
    revoked_at: null,
    last_used_at: null,
    rate_limit_per_minute: checked.rate_limit_per_minute,
    rate_limit_per_day: checked.rate_limit_per_day,
    quota: emptyQuota(),
  };
  if (!isConfigured()) {
    memory.push(row);
    return { ok: true, credential: toPublic(row), token: minted.token };
  }
  const db = sql();
  await db`
    insert into agent_credentials (
      id, label, token_prefix, token_hash, scopes, created_at, expires_at,
      rate_limit_per_minute, rate_limit_per_day
    ) values (
      ${row.id},
      ${row.label},
      ${row.token_prefix},
      ${row.token_hash},
      ${row.scopes},
      ${row.created_at},
      ${row.expires_at},
      ${row.rate_limit_per_minute}::integer,
      ${row.rate_limit_per_day}::integer
    )
  `;
  return { ok: true, credential: toPublic(row), token: minted.token };
}

export async function listCredentials(): Promise<PublicCredential[]> {
  if (!isConfigured()) {
    return memory
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map(toPublic);
  }
  const db = sql();
  const rows = await db`
    select id, label, token_prefix, scopes, created_at, expires_at, revoked_at, last_used_at,
      rate_limit_per_minute, rate_limit_per_day
    from agent_credentials
    order by created_at desc
  `;
  return rows.map((row) => toPublic(rowFromDb(row)));
}

export async function revokeCredential(id: string): Promise<PublicCredential | null> {
  if (!id || typeof id !== "string") return null;
  const stamp = new Date(credentialNow()).toISOString();
  if (!isConfigured()) {
    const row = memory.find((item) => item.id === id);
    if (!row) return null;
    if (!row.revoked_at) row.revoked_at = stamp;
    return toPublic(row);
  }
  const db = sql();
  const rows = await db`
    update agent_credentials
    set revoked_at = coalesce(revoked_at, ${stamp}::timestamptz)
    where id = ${id}
    returning id, label, token_prefix, scopes, created_at, expires_at, revoked_at, last_used_at,
      rate_limit_per_minute, rate_limit_per_day
  `;
  const row = rows[0];
  return row ? toPublic(rowFromDb(row)) : null;
}

/**
 * Change one or both limits. The window counters are not touched, so an
 * edit keeps the requests already counted in the current minute and day.
 * The update takes the same row lock a charge takes, so the two serialize.
 * Returns null when the id does not exist.
 */
export async function updateCredentialLimits(input: {
  id: string;
  rate_limit_per_minute: number | null;
  rate_limit_per_day: number | null;
}): Promise<PublicCredential | null> {
  if (input.rate_limit_per_minute !== null && !isValidRateLimit(input.rate_limit_per_minute)) {
    throw new Error("rate_limit_per_minute is out of range");
  }
  if (input.rate_limit_per_day !== null && !isValidRateLimit(input.rate_limit_per_day)) {
    throw new Error("rate_limit_per_day is out of range");
  }
  if (!isConfigured()) {
    const row = memory.find((item) => item.id === input.id);
    if (!row) return null;
    if (input.rate_limit_per_minute !== null) row.rate_limit_per_minute = input.rate_limit_per_minute;
    if (input.rate_limit_per_day !== null) row.rate_limit_per_day = input.rate_limit_per_day;
    return toPublic(row);
  }
  const db = sql();
  const rows = await db`
    update agent_credentials
    set rate_limit_per_minute = coalesce(${input.rate_limit_per_minute}::integer, rate_limit_per_minute),
        rate_limit_per_day = coalesce(${input.rate_limit_per_day}::integer, rate_limit_per_day)
    where id = ${input.id}
    returning id, label, token_prefix, scopes, created_at, expires_at, revoked_at, last_used_at,
      rate_limit_per_minute, rate_limit_per_day
  `;
  const row = rows[0];
  return row ? toPublic(rowFromDb(row)) : null;
}

/** Demo-mode row for the quota module. Routes must not call this. */
export function memoryCredentialForQuota(id: string): MemoryCredential | null {
  return memory.find((item) => item.id === id) ?? null;
}

export type ResolveResult =
  | { status: "ok"; credential: PublicCredential }
  | { status: "reject" }
  | { status: "unavailable" };

/**
 * Look up the SHA-256 of the token and compare the stored hash with a
 * timing-safe compare. Revoked and expired credentials are rejected.
 * A store error is `unavailable` so the caller can fail closed.
 */
export async function resolveAgentCredential(token: string): Promise<ResolveResult> {
  if (!token.startsWith("akc_") || token.length < 12) return { status: "reject" };
  const hash = sha256(token);
  let row: StoredCredential | null = null;
  try {
    row = await findByHash(hash);
  } catch (e) {
    console.error("[credentials] lookup failed", e instanceof Error ? e.name : "error");
    return { status: "unavailable" };
  }
  const stored = row?.token_hash ?? DUMMY_HASH;
  const match = hashesEqual(hash, stored);
  if (!row || !match) return { status: "reject" };
  if (row.revoked_at) return { status: "reject" };
  if (row.expires_at) {
    const exp = Date.parse(row.expires_at);
    if (!Number.isFinite(exp) || exp <= credentialNow()) return { status: "reject" };
  }
  await noteUse(row.id);
  return { status: "ok", credential: toPublic(row) };
}

async function findByHash(hash: string): Promise<StoredCredential | null> {
  if (!isConfigured()) {
    return memory.find((item) => item.token_hash === hash) ?? null;
  }
  const db = sql();
  const rows = await db`
    select id, label, token_prefix, token_hash, scopes, created_at, expires_at, revoked_at, last_used_at,
      rate_limit_per_minute, rate_limit_per_day
    from agent_credentials
    where token_hash = ${hash}
    limit 1
  `;
  return rows[0] ? rowFromDb(rows[0]) : null;
}

/**
 * Test-only. Puts a row through the same normalizer the database uses.
 * A present expiry or revocation that cannot be parsed must still reject.
 */
export function plantCredentialForTests(input: {
  token: string;
  scopes: string[];
  expires_at?: unknown;
  revoked_at?: unknown;
}): void {
  if (isConfigured()) throw new Error("plantCredentialForTests is for the in-memory store");
  const row = rowFromDb({
    id: randomUUID(),
    label: "planted",
    token_prefix: input.token.slice(0, 8),
    token_hash: sha256(input.token),
    scopes: input.scopes,
    created_at: new Date(credentialNow()).toISOString(),
    expires_at: input.expires_at ?? null,
    revoked_at: input.revoked_at ?? null,
    last_used_at: null,
  });
  memory.push({ ...row, quota: emptyQuota() });
}

/** Test-only read of the stored hash. Routes must not call this. */
export async function readCredentialHashForTests(id: string): Promise<string | null> {
  if (!isConfigured()) {
    return memory.find((item) => item.id === id)?.token_hash ?? null;
  }
  const db = sql();
  const rows = await db`select token_hash from agent_credentials where id = ${id} limit 1`;
  const hash = rows[0]?.token_hash;
  return typeof hash === "string" ? hash : null;
}
