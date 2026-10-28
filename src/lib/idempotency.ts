/**
 * Optional client keys for task creation, operator messages, and replies.
 * The key is scoped to the authenticated actor and the route, so two
 * callers can reuse the same string. The key is never taken from a column
 * on the resource row.
 *
 * The same key and the same arguments return the stored result for 24 hours
 * from the claim. After that window the same key starts a new write. The
 * same key with different arguments throws IdempotencyConflict.
 *
 * A claim with no stored result holds a 30 second lease (`started_at`).
 * During the lease another caller gets a retryable in-progress conflict
 * and a retry-after. After the lease a retry with the same arguments takes
 * over the claim and runs the write. `claim_token` is how a caller recognizes
 * its own claim when that insert commits and the connection dies before
 * RETURNING arrives. The resource write has not started in that case, so
 * the same attempt runs it once.
 *
 * A resource write and its stored response are one statement. The insert's
 * WHERE checks `claim_token`, so a takeover that already swapped the token
 * inserts nothing. A committed row therefore always has a stored response,
 * and a later takeover cannot run the write again.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./actor";
import { sql, type SqlTag } from "./db";
import { asUnknownWriteOutcome } from "./write-outcome";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a claim with no stored result blocks other callers. */
export const IDEMPOTENCY_LEASE_MS = 30_000;
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
const UNKNOWN_OUTCOME = "The previous attempt with this key may already have been saved. Retry the same key and the same arguments. Within 24 hours of the claim, that retry does not insert another row. The key is scoped to this actor and this route.";

/** Stored in response so a later call can tell a lost RETURNING from a live in-progress claim. */
const UNKNOWN_MARKER = { __agent_kontrol_idempotency: "unknown_outcome" };

let clock: () => Date = () => new Date();

/** Tests move the expiry clock. Production never calls this. */
export function setIdempotencyClockForTests(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
}

/** The attempt that owns the current lease. The resource statement must check `token`. */
export type IdempotencyClaim = {
  scope: string;
  key: string;
  token: string;
};

/**
 * Runs after the claim is owned and before the resource statement.
 * Tests use it to let another caller take the lease first.
 * Production never calls this.
 */
let beforeWrite: (() => Promise<void>) | null = null;

export function setBeforeIdempotentWriteForTests(fn: (() => Promise<void>) | null): void {
  beforeWrite = fn;
}

export class IdempotencyConflict extends Error {
  readonly code = "idempotency_conflict" as const;
  readonly retryable: boolean;
  /** Seconds a caller should wait before retrying. Set for an in-progress lease. */
  readonly retryAfterSec: number | null;
  readonly fields: Record<string, string>;
  constructor(message: string, opts?: { retryable?: boolean; retryAfterSec?: number | null }) {
    super(message);
    this.name = "IdempotencyConflict";
    this.retryable = opts?.retryable ?? false;
    this.retryAfterSec = opts?.retryAfterSec ?? null;
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
 * The claim is kept for 24 hours. Inside that window, retrying the same
 * key and the same arguments does not insert another row. The key is
 * scoped to the actor and the route.
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
  started_at?: string | Date | null;
  claim_token?: string | null;
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

/** True while another attempt may still be inside execute. A null start is already expired. */
function leaseOpen(startedAt: string | Date | null | undefined, now: Date): boolean {
  if (startedAt == null) return false;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return false;
  return start + IDEMPOTENCY_LEASE_MS > now.getTime();
}

function retryAfterSec(startedAt: string | Date | null | undefined, now: Date): number {
  const cap = Math.ceil(IDEMPOTENCY_LEASE_MS / 1000);
  if (startedAt == null) return cap;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return cap;
  const sec = Math.ceil((start + IDEMPOTENCY_LEASE_MS - now.getTime()) / 1000);
  if (!Number.isFinite(sec) || sec < 1) return 1;
  return Math.min(sec, cap);
}

function inProgressError(startedAt: string | Date | null | undefined, now: Date): IdempotencyConflict {
  return new IdempotencyConflict(IN_PROGRESS, {
    retryable: true,
    retryAfterSec: retryAfterSec(startedAt, now),
  });
}

/** Drop only this attempt's claim. A newer lease keeps its row. */
async function releaseClaim(db: SqlTag, scope: string, key: string, token: string): Promise<void> {
  await db`
    delete from idempotency_keys
    where scope = ${scope}
      and idempotency_key = ${key}
      and response is null
      and claim_token = ${token}
  `;
}

/**
 * Mark a null claim whose result could not be read. Only the in-memory
 * path uses this: a resource statement stores its own response, so a
 * committed row is never left null for a takeover to repeat.
 * A second connection failure leaves the null claim; the lease still blocks
 * another insert, and this error is not swallowed into a success.
 */
async function retainUnknown(db: SqlTag, scope: string, key: string, token: string): Promise<void> {
  await db`
    update idempotency_keys
    set response = ${JSON.stringify(UNKNOWN_MARKER)}::jsonb
    where scope = ${scope}
      and idempotency_key = ${key}
      and response is null
      and claim_token = ${token}
  `;
}

async function readClaim(db: SqlTag, scope: string, key: string): Promise<ClaimRow | undefined> {
  const existing = await db`
    select request_hash, response, expires_at, started_at, claim_token
    from idempotency_keys
    where scope = ${scope} and idempotency_key = ${key}
    limit 1
  `;
  return existing[0] as ClaimRow | undefined;
}

/** In-memory results only. A resource row is stored by its own statement. */
async function completeClaim<T>(
  db: SqlTag,
  scope: string,
  key: string,
  token: string,
  execute: () => Promise<T | null>,
): Promise<T> {
  let result: T | null;
  try {
    result = await execute();
  } catch (e) {
    if (asUnknownWriteOutcome(e)) {
      try {
        await retainUnknown(db, scope, key, token);
      } catch (markErr) {
        if (!asUnknownWriteOutcome(markErr)) throw markErr;
      }
      throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
    }
    await releaseClaim(db, scope, key, token);
    throw e;
  }
  if (result == null) throw new Error("idempotent write returned no result");
  try {
    await db`
      update idempotency_keys
      set response = ${JSON.stringify(result)}::jsonb
      where scope = ${scope}
        and idempotency_key = ${key}
        and claim_token = ${token}
    `;
  } catch (e) {
    if (!asUnknownWriteOutcome(e)) {
      await releaseClaim(db, scope, key, token);
      throw e;
    }
    try {
      await retainUnknown(db, scope, key, token);
    } catch (markErr) {
      if (!asUnknownWriteOutcome(markErr)) throw markErr;
    }
    throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
  }
  return result;
}

function storedRaw(row: ClaimRow | undefined): unknown | undefined {
  if (!row || row.response == null || isUnknownMarker(row.response)) return undefined;
  return row.response;
}

type Next<T> =
  | { kind: "return"; value: T }
  | { kind: "throw"; error: Error }
  | { kind: "owned" }
  | { kind: "continue" };

/**
 * Run `execute` once per key. A missing key runs `execute` every time.
 * A definite failure releases this attempt's claim. A connection loss on
 * the claim insert is re-read: when `claim_token` matches, this attempt
 * owns the row and runs the write once.
 *
 * `storesResponse` means `execute` inserts the resource and stores the
 * response in one statement, and inserts nothing when `claim.token` no
 * longer matches. A null return is that refusal. A connection loss after
 * that statement is re-read: a stored response is returned, and a null
 * response with this token still held means the statement rolled back.
 *
 * `restore` maps that stored row JSON to `T`. The live return applies the
 * same function to the JSON the statement stored, so a retry matches it.
 */
export async function runIdempotent<T>(opts: {
  actor: Actor | null | undefined;
  route: string;
  key: unknown;
  payload: Record<string, unknown>;
  execute: (claim: IdempotencyClaim | null) => Promise<T | null>;
  storesResponse?: boolean;
  restore?: (stored: unknown) => T;
}): Promise<T> {
  const present = (response: unknown): T => {
    const parsed = parseStored<unknown>(response);
    return opts.restore ? opts.restore(parsed) : (parsed as T);
  };
  const key = normalizeKey(opts.key);
  if (!key) {
    const value = await opts.execute(null);
    if (value == null) throw new Error("write returned no result");
    return value;
  }

  const db = sql();
  const scope = idempotencyScope(opts.actor, opts.route);
  const requestHash = hashPayload(opts.payload);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = clock();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
    const leaseCutoff = new Date(now.getTime() - IDEMPOTENCY_LEASE_MS).toISOString();
    const token = randomUUID();

    await db`
      delete from idempotency_keys
      where scope = ${scope}
        and idempotency_key = ${key}
        and expires_at <= ${nowIso}
    `;

    const settle = async (row: ClaimRow | undefined): Promise<Next<T>> => {
      if (!row) return { kind: "continue" };
      if (new Date(row.expires_at).getTime() <= now.getTime()) {
        await db`
          delete from idempotency_keys
          where scope = ${scope}
            and idempotency_key = ${key}
            and expires_at <= ${nowIso}
        `;
        return { kind: "continue" };
      }
      if (row.request_hash !== requestHash) {
        return { kind: "throw", error: new IdempotencyConflict(MISMATCH) };
      }
      if (isUnknownMarker(row.response)) {
        return { kind: "throw", error: new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME) };
      }
      if (row.response != null) return { kind: "return", value: present(row.response) };
      if (row.claim_token === token) return { kind: "owned" };
      if (!leaseOpen(row.started_at, now)) {
        const owned = await takeOver();
        return owned ? { kind: "owned" } : { kind: "continue" };
      }
      return { kind: "throw", error: inProgressError(row.started_at, now) };
    };

    const takeOver = async (): Promise<boolean> => {
      try {
        const updated = await db`
          update idempotency_keys
          set started_at = ${nowIso},
              claim_token = ${token},
              request_hash = ${requestHash}
          where scope = ${scope}
            and idempotency_key = ${key}
            and response is null
            and request_hash = ${requestHash}
            and (started_at is null or started_at <= ${leaseCutoff})
          returning claim_token
        `;
        return Boolean(updated[0]);
      } catch (e) {
        if (!asUnknownWriteOutcome(e)) throw e;
        try {
          const again = await readClaim(db, scope, key);
          return Boolean(
            again
            && again.claim_token === token
            && again.response == null
            && again.request_hash === requestHash,
          );
        } catch (readErr) {
          if (asUnknownWriteOutcome(readErr)) return false;
          throw readErr;
        }
      }
    };

    const claim: IdempotencyClaim = { scope, key, token };

    const afterRefusal = async (): Promise<{ settled: true; value: T } | { settled: false }> => {
      const row = await readClaim(db, scope, key);
      const stored = storedRaw(row);
      if (stored !== undefined) return { settled: true, value: present(stored) };
      if (row && isUnknownMarker(row.response)) {
        throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
      }
      // This token still owns an empty claim, and the statement inserted nothing.
      // settle() would report "owned" and write again.
      if (row && row.claim_token === token && row.response == null) {
        throw new Error("idempotent write inserted nothing while this attempt still held the claim");
      }
      return finish(await settle(row));
    };

    const writeAtomic = async (): Promise<{ settled: true; value: T } | { settled: false }> => {
      const once = () => opts.execute(claim);
      try {
        const result = await once();
        if (result == null) return afterRefusal();
        return { settled: true, value: result };
      } catch (e) {
        if (!asUnknownWriteOutcome(e)) {
          await releaseClaim(db, scope, key, token);
          throw e;
        }
        let row: ClaimRow | undefined;
        try {
          row = await readClaim(db, scope, key);
        } catch (readErr) {
          if (asUnknownWriteOutcome(readErr)) throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
          throw readErr;
        }
        const stored = storedRaw(row);
        if (stored !== undefined) return { settled: true, value: present(stored) };
        if (row && isUnknownMarker(row.response)) {
          throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
        }
        // The statement rolled back. This token still owns an empty claim.
        if (row && row.claim_token === token && row.response == null) {
          try {
            const again = await once();
            if (again == null) return afterRefusal();
            return { settled: true, value: again };
          } catch (againErr) {
            if (!asUnknownWriteOutcome(againErr)) {
              await releaseClaim(db, scope, key, token);
              throw againErr;
            }
            try {
              const saved = storedRaw(await readClaim(db, scope, key));
              if (saved !== undefined) return { settled: true, value: present(saved) };
            } catch (readErr) {
              if (!asUnknownWriteOutcome(readErr)) throw readErr;
            }
            throw new IdempotencyUnknownOutcome(UNKNOWN_OUTCOME);
          }
        }
        return afterRefusal();
      }
    };

    const finish = async (next: Next<T>): Promise<{ settled: true; value: T } | { settled: false }> => {
      if (next.kind === "continue") return { settled: false };
      if (next.kind === "throw") throw next.error;
      if (next.kind === "return") return { settled: true, value: next.value };
      if (beforeWrite) {
        const hook = beforeWrite;
        beforeWrite = null;
        await hook();
      }
      if (opts.storesResponse) return writeAtomic();
      return {
        settled: true,
        value: await completeClaim(db, scope, key, token, () => opts.execute(claim)),
      };
    };

    try {
      const claimed = await db`
        insert into idempotency_keys (
          scope, idempotency_key, request_hash, response, expires_at, started_at, claim_token
        )
        values (
          ${scope}, ${key}, ${requestHash}, null, ${expiresAt}, ${nowIso}, ${token}
        )
        on conflict (scope, idempotency_key) do nothing
        returning scope, idempotency_key, request_hash, response, expires_at, started_at, claim_token
      `;
      if (claimed[0]) {
        const done = await finish({ kind: "owned" });
        if (done.settled) return done.value;
        continue;
      }
    } catch (e) {
      if (!asUnknownWriteOutcome(e)) throw e;
      let row: ClaimRow | undefined;
      try {
        row = await readClaim(db, scope, key);
      } catch (readErr) {
        if (asUnknownWriteOutcome(readErr)) continue;
        throw readErr;
      }
      const done = await finish(await settle(row));
      if (done.settled) return done.value;
      continue;
    }

    const done = await finish(await settle(await readClaim(db, scope, key)));
    if (done.settled) return done.value;
  }

  throw inProgressError(null, clock());
}
