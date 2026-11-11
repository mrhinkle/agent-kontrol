import { randomUUID } from "node:crypto";
import { sql, type SqlTag } from "./db";

/**
 * Transition log and per-PR lock for reducers (#80).
 * The lock key is lowercased `owner/name#number`. A holder past expires_at
 * can be replaced, so a crashed consumer cannot block a PR forever.
 * Release deletes only the token that acquired the row.
 */

export type TransitionStatus = "started" | "half_done" | "done" | "failed" | "skipped" | "dropped";

export interface CausedBy {
  actor: string;
  until: string;
  keys: string[];
}

export interface DependentStep {
  comment?: boolean;
  unlabel?: boolean;
}

export interface TransitionSteps {
  deliveries?: string[];
  terminal?: boolean;
  next_attempt_at?: string;
  completed?: string[];
  planned?: unknown;
  work_item?: unknown;
  caused_by?: CausedBy;
  dependents?: Record<string, DependentStep>;
  emitted?: unknown;
  /** Head passed to update-branch. Set before the write so a lost response is not merged twice. */
  pending_merge?: string;
  /** Reviewers to re-request after the merge. Captured before the head moves. */
  reviewers?: string[];
  /** Pre-merge head for an update-branch child. The live head changes after the merge. */
  pinned_head?: string;
  /** Child transition keys a push already started, keyed by pull number. */
  children?: Record<string, string>;
}

export interface TransitionRow {
  transition_key: string;
  reducer: string;
  repo: string | null;
  number: number | null;
  head_sha: string | null;
  status: TransitionStatus;
  reason: string | null;
  steps: TransitionSteps;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export type TransitionDraft = Omit<TransitionRow, "created_at" | "updated_at">;

export interface ReducerFailureLine {
  transition_key: string;
  reducer: string;
  repo: string;
  number: number | null;
  reason: string | null;
  attempts: number;
}

export interface TransitionStore {
  get(key: string): Promise<TransitionRow | null>;
  insert(row: TransitionDraft, at: string): Promise<{ row: TransitionRow; inserted: boolean }>;
  update(key: string, patch: Partial<Pick<TransitionRow, "status" | "reason" | "steps" | "attempts" | "head_sha">>, at: string): Promise<TransitionRow>;
  listTerminalFailures(): Promise<ReducerFailureLine[]>;
}

export interface ReducerLock {
  tryAcquire(key: string, ttlMs: number, nowMs: number): Promise<{ ok: true; token: string } | { ok: false }>;
  release(key: string, token: string): Promise<void>;
}

function copySteps(steps: TransitionSteps): TransitionSteps {
  return JSON.parse(JSON.stringify(steps)) as TransitionSteps;
}

function copyRow(row: TransitionRow): TransitionRow {
  return { ...row, steps: copySteps(row.steps) };
}

export function memoryTransitionStore(): TransitionStore & { rows(): TransitionRow[] } {
  const table = new Map<string, TransitionRow>();
  return {
    rows: () => [...table.values()].map(copyRow),
    async get(key) {
      const row = table.get(key);
      return row ? copyRow(row) : null;
    },
    async insert(row, at) {
      const existing = table.get(row.transition_key);
      if (existing) return { row: copyRow(existing), inserted: false };
      const stored: TransitionRow = { ...row, steps: copySteps(row.steps), created_at: at, updated_at: at };
      table.set(row.transition_key, stored);
      return { row: copyRow(stored), inserted: true };
    },
    async update(key, patch, at) {
      const existing = table.get(key);
      if (!existing) throw new Error(`missing transition ${key}`);
      const next: TransitionRow = {
        ...existing,
        ...patch,
        steps: patch.steps ? copySteps(patch.steps) : existing.steps,
        updated_at: at,
      };
      table.set(key, next);
      return copyRow(next);
    },
    async listTerminalFailures() {
      return [...table.values()]
        .filter((row) => row.status === "failed" && row.attempts >= 5)
        .map((row) => ({
          transition_key: row.transition_key,
          reducer: row.reducer,
          repo: row.repo ?? "",
          number: row.number,
          reason: row.reason,
          attempts: row.attempts,
        }));
    },
  };
}

export function memoryReducerLock(): ReducerLock {
  const held = new Map<string, { token: string; expiresAt: number }>();
  return {
    async tryAcquire(key, ttlMs, nowMs) {
      const current = held.get(key);
      if (current && current.expiresAt > nowMs) return { ok: false };
      const token = randomUUID();
      held.set(key, { token, expiresAt: nowMs + ttlMs });
      return { ok: true, token };
    },
    async release(key, token) {
      const current = held.get(key);
      if (current && current.token === token) held.delete(key);
    },
  };
}

function asSteps(value: unknown): TransitionSteps {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as TransitionSteps;
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as TransitionSteps;
  }
  return {};
}

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function asRow(row: Record<string, unknown>): TransitionRow {
  return {
    transition_key: String(row.transition_key),
    reducer: String(row.reducer),
    repo: row.repo == null ? null : String(row.repo),
    number: asNumber(row.number),
    head_sha: row.head_sha == null ? null : String(row.head_sha),
    status: String(row.status) as TransitionStatus,
    reason: row.reason == null ? null : String(row.reason),
    steps: asSteps(row.steps),
    attempts: asNumber(row.attempts) ?? 0,
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

export function sqlTransitionStore(db?: SqlTag): TransitionStore {
  const q = () => db ?? sql();
  return {
    async get(key) {
      const rows = await q()`select transition_key, reducer, repo, number::text as number, head_sha, status, reason, steps, attempts, created_at, updated_at
        from reducer_transitions where transition_key = ${key}`;
      return rows.length ? asRow(rows[0]) : null;
    },
    async insert(row, at) {
      const rows = await q()`insert into reducer_transitions
        (transition_key, reducer, repo, number, head_sha, status, reason, steps, attempts, created_at, updated_at)
        values (
          ${row.transition_key}, ${row.reducer}, ${row.repo}, ${row.number}, ${row.head_sha},
          ${row.status}, ${row.reason}, ${JSON.stringify(row.steps)}::jsonb, ${row.attempts},
          ${at}::timestamptz, ${at}::timestamptz
        )
        on conflict (transition_key) do nothing
        returning transition_key, reducer, repo, number::text as number, head_sha, status, reason, steps, attempts, created_at, updated_at`;
      if (rows.length) return { row: asRow(rows[0]), inserted: true };
      const existing = await q()`select transition_key, reducer, repo, number::text as number, head_sha, status, reason, steps, attempts, created_at, updated_at
        from reducer_transitions where transition_key = ${row.transition_key}`;
      if (!existing.length) throw new Error(`missing transition ${row.transition_key}`);
      return { row: asRow(existing[0]), inserted: false };
    },
    async update(key, patch, at) {
      const current = await q()`select transition_key, reducer, repo, number::text as number, head_sha, status, reason, steps, attempts, created_at, updated_at
        from reducer_transitions where transition_key = ${key}`;
      if (!current.length) throw new Error(`missing transition ${key}`);
      const row = asRow(current[0]);
      const next: TransitionRow = {
        ...row,
        status: patch.status ?? row.status,
        reason: patch.reason === undefined ? row.reason : patch.reason,
        steps: patch.steps ?? row.steps,
        attempts: patch.attempts ?? row.attempts,
        head_sha: patch.head_sha === undefined ? row.head_sha : patch.head_sha,
        updated_at: at,
      };
      const rows = await q()`update reducer_transitions set
          status = ${next.status},
          reason = ${next.reason},
          steps = ${JSON.stringify(next.steps)}::jsonb,
          attempts = ${next.attempts},
          head_sha = ${next.head_sha},
          updated_at = ${at}::timestamptz
        where transition_key = ${key}
        returning transition_key, reducer, repo, number::text as number, head_sha, status, reason, steps, attempts, created_at, updated_at`;
      return asRow(rows[0]);
    },
    async listTerminalFailures() {
      const rows = await q()`select transition_key, reducer, repo, number::text as number, reason, attempts
        from reducer_transitions
        where status = 'failed' and attempts >= 5
        order by updated_at desc
        limit 50`;
      return rows.map((row) => ({
        transition_key: String(row.transition_key),
        reducer: String(row.reducer),
        repo: row.repo == null ? "" : String(row.repo),
        number: asNumber(row.number),
        reason: row.reason == null ? null : String(row.reason),
        attempts: asNumber(row.attempts) ?? 0,
      }));
    },
  };
}

export function sqlReducerLock(db?: SqlTag): ReducerLock {
  const q = () => db ?? sql();
  return {
    async tryAcquire(key, ttlMs) {
      const token = randomUUID();
      const secs = Math.max(1, Math.ceil(ttlMs / 1000));
      const rows = await q()`insert into reducer_locks (lock_key, token, expires_at)
        values (${key}, ${token}, now() + make_interval(secs => ${secs}))
        on conflict (lock_key) do update
          set token = excluded.token,
              expires_at = excluded.expires_at
          where reducer_locks.expires_at <= now()
        returning token`;
      if (!rows.length || String(rows[0].token) !== token) return { ok: false };
      return { ok: true, token };
    },
    async release(key, token) {
      await q()`delete from reducer_locks where lock_key = ${key} and token = ${token}`;
    },
  };
}

/** Lines the morning brief prints. Empty when nothing has hit the retry cap. */
export function formatReducerFailureLines(rows: readonly ReducerFailureLine[]): string[] {
  if (rows.length === 0) return [];
  const lines = [`REDUCER FAILURES (${rows.length}) — retry cap reached`];
  for (const row of rows) {
    const number = row.number == null ? "" : ` #${row.number}`;
    lines.push(`  ${row.repo}${number}  ${row.reducer}  ${row.reason ?? ""}  attempts=${row.attempts}`);
  }
  return lines;
}

export async function listTerminalReducerFailures(): Promise<ReducerFailureLine[] | null> {
  try {
    return await sqlTransitionStore().listTerminalFailures();
  } catch {
    return null;
  }
}
