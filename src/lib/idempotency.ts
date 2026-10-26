/**
 * Optional client keys for task creation, operator messages, and replies.
 * The key is scoped to the authenticated actor and the route, so two
 * callers can reuse the same string. The key is never taken from a column
 * on the resource row.
 *
 * The same key and the same arguments return the stored result. The same
 * key with different arguments throws IdempotencyConflict. A key lasts 24
 * hours from the claim.
 */
import { createHash } from "node:crypto";
import type { Actor } from "./actor";
import { sql, type SqlTag } from "./db";
import { asUnknownWriteOutcome } from "./write-outcome";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_MAX = 200;
const MAX_ATTEMPTS = 3;

export const IDEMPOTENCY_ROUTE = {
  createTask: "create_task",
  reply: "reply_to_operator",
  enqueueMessage: "enqueue_message",
} as const;

const MISMATCH = "This idempotency key was already used with different arguments.";
const IN_PROGRESS = "This idempotency key is already in progress.";
const BAD_KEY = "Use 1 to 200 characters and no control characters, or omit the key.";
const UNKNOWN_OUTCOME = "The previous attempt with this key may already have been saved. Retry the same key until it resolves or expires. A retry will not insert another row.";

/** Stored in response so a later call can tell a lost RETURNING from a live in-progress claim. */
const UNKNOWN_MARKER = { __agent_kontrol_idempotency: "unknown_outcome" };

let clock: () => Date = () => new Date();

/** Tests move the expiry clock. Production never calls this. */
export function setIdempotencyClockForTests(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
}

export class IdempotencyConflict extends Error {
  readonly code = "idempotency_conflict" as const;
  readonly fields: Record<string, string>;
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflict";
    this.fields = { idempotency_key: message };
  }
}

export class IdempotencyKeyInvalid extends Error {
  readonly code = "validation_failed" as const;
  readonly fields: Record<string, string>;
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyKeyInvalid";
    this.fields = { idempotency_key: message };
  }
}

/**
 * The write may have committed and the client did not see the result.
 * The claim is kept until it expires. Retrying the same key does not insert another row.
 */
export class IdempotencyUnknownOutcome extends Error {
  readonly code = "idempotency_conflict" as const;
  readonly retryable = true;
  readonly fields: Record<string, string>;
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyUnknownOutcome";
    this.fields = { idempotency_key: message };
  }
}

export function idempotencyScope(actor: Actor | null | undefined, route: string): string {
  return `${actor?.actor_type ?? "unknown"}:${actor?.actor_id ?? "unknown"}:${route}`;
}

/** Drop undefined fields and sort keys so argument order does not change the hash. */
export function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export function payloadOf(input: object, keys: readonly string[]): Record<string, unknown> {
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/** Header value for the REST routes. Blank is the same as omitting the header. */
export function readIdempotencyHeader(req: Request): string | undefined {
  const raw = req.headers.get("idempotency-key");
  if (raw == null) return undefined;
  return raw;
}

function normalizeKey(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new IdempotencyKeyInvalid("idempotency_key must be a string.");
  const key = raw.trim();
  if (!key) return null;
  if (key.length > KEY_MAX || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new IdempotencyKeyInvalid(BAD_KEY);
  }
  return key;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue;
      out[key] = sortValue(src[key]);
    }
    return out;
  }
  return value ?? null;
}

function parseStored<T>(response: unknown): T {
  if (typeof response === "string") return JSON.parse(response) as T;
  return response as T;
}

interface ClaimRow {
  request_hash: string;
  response: unknown;
  expires_at: string | Date;
}

function isUnknownMarker(response: unknown): boolean {
  let value = response;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== "object") return false;
  return (value as { __agent_kontrol_idempotency?: unknown }).__agent_kontrol_idempotency === "unknown_outcome";
}

async function releaseClaim(db: SqlTag, scope: string, key: string): Promise<void> {
  await db`
    delete from idempotency_keys
    where scope = ${scope}
      and idempotency_key = ${key}
      and response is null
  `;
}

/** Leave the claim. Swallow a second connection failure so the first error still surfaces. */
async function retainUnknown(db: SqlTag, scope: string, key: string): Promise<void> {
  try {
    await db`
      update idempotency_keys
      set response = ${JSON.stringify(UNKNOWN_MARKER)}::jsonb
      where scope = ${scope}
        and idempotency_key = ${key}
        and response is null
    `;
  } catch {
    // The null claim still blocks a second insert until it expires.
  }
}

/**
 * Run `execute` once per key. A missing key runs `execute` every time.
 * A definite failure releases the claim. A connection loss after the
 * statement may have committed keeps the claim until it expires.
 */
export async function runIdempotent<T>(opts: {
  actor: Actor | null | undefined;
  route: string;
  key: unknown;
  payload: Record<string, unknown>;
  execute: () => Promise<T>;
}): Promise<T> {
  const key = normalizeKey(opts.key);
  if (!key) return opts.execute();

  const db = sql();
  const scope = idempotencyScope(opts.actor, opts.route);
  const requestHash = hashPayload(opts.payload);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = clock();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();

    await db`
      delete from idempotency_keys
      where scope = ${scope}
        and idempotency_key = ${key}
        and expires_at <= ${nowIso}
    `;

    const claimed = await db`
      insert into idempotency_keys (scope, idempotency_key, request_hash, response, expires_at)
      values (${scope}, ${key}, ${requestHash}, null, ${expiresAt})
      on conflict (scope, idempotency_key) do nothing
      returning scope, idempotency_key, request_hash, response, expires_at
    `;

    if (claimed[0]) {
      let result: T;
      try {
        result = await opts.execute();
      } catch (e) {
        if (asUnknownWriteOutcome(e)) {
          await retainUnknown(db, scope, key);
          throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
        }
        await releaseClaim(db, scope, key);
        throw e;
      }
      try {
        await db`
          update idempotency_keys
          set response = ${JSON.stringify(result)}::jsonb
          where scope = ${scope} and idempotency_key = ${key}
        `;
      } catch {
        // execute() already returned, so the resource row may be committed.
        await retainUnknown(db, scope, key);
        throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
      }
      return result;
    }

    const existing = await db`
      select request_hash, response, expires_at
      from idempotency_keys
      where scope = ${scope} and idempotency_key = ${key}
      limit 1
    `;
    const row = existing[0] as ClaimRow | undefined;
    if (!row) continue;
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      await db`
        delete from idempotency_keys
        where scope = ${scope}
          and idempotency_key = ${key}
          and expires_at <= ${nowIso}
      `;
      continue;
    }
    if (row.request_hash !== requestHash) throw new IdempotencyConflict(MISMATCH);
    if (row.response == null) throw new IdempotencyConflict(IN_PROGRESS);
    if (isUnknownMarker(row.response)) throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
    return parseStored<T>(row.response);
  }

  throw new Error("idempotency claim could not be completed");
}
