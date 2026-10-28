/**
 * Installed before any route import. Points the pg driver at an in-memory
 * query spy so a dry run can be proved not to write, without a database.
 *
 * Unconditional inserts and updates return a row and leave the fixture
 * alone, matching the older tests. A conditional write (`md5(alias::text)`
 * or insert-if-absent) mutates the fixture only when the predicate matches,
 * and counts that apply. `md5(alias::text)` is the stable JSON of the stored
 * row, which keeps a microsecond timestamp the driver would otherwise truncate.
 */
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:5432/ak_dry_run";
process.env.MC_DB_DRIVER = "pg";
process.env.MC_TOKEN = "dry-run-test-token";
process.env.MC_DASHBOARD_PASSWORD = "dry-run-dashboard";

import { stableRowRevision } from "../../src/lib/revision";

export const queries: string[] = [];
export const writes: string[] = [];

type Row = Record<string, unknown>;

const state = {
  repos: [] as Row[],
  tasks: [] as Row[],
  memory: [] as Row[],
};

let rejectWrites = false;
let appliedCount = 0;
let afterMemorySelect: (() => void) | null = null;
let insertRaceNeed = 0;
let insertRaceWaiters: Array<() => void> = [];

/** Tests set this after resetSpy. Assigning the imported binding is illegal. */
export function setRejectWrites(value: boolean) {
  rejectWrites = value;
}

/**
 * Run once, after the next memory SELECT has copied its rows and before
 * that result is returned. A second read in the same preview then sees
 * the mutated row. One combined read does not.
 */
export function divergeAfterNextMemorySelect(fn: () => void) {
  afterMemorySelect = fn;
}

/**
 * The next two `INSERT ... WHERE NOT EXISTS` statements both observe the
 * key as absent. The loser then hits the unique constraint, which is what
 * PostgreSQL does under READ COMMITTED. `ON CONFLICT DO NOTHING` does not
 * use this path.
 */
export function armReadCommittedInsertRace() {
  insertRaceNeed = 2;
  insertRaceWaiters = [];
}

/** Conditional applies since the last resetSpy. A miss does not count. */
export function appliedWrites(): number {
  return appliedCount;
}

export function resetSpy() {
  queries.length = 0;
  writes.length = 0;
  rejectWrites = false;
  appliedCount = 0;
  afterMemorySelect = null;
  insertRaceNeed = 0;
  insertRaceWaiters = [];
}

export function setFixture(next: { repos?: Row[]; tasks?: Row[]; memory?: Row[] }) {
  if (next.repos) state.repos = next.repos;
  if (next.tasks) state.tasks = next.tasks;
  if (next.memory) state.memory = next.memory;
}

export function fixtureSnapshot() {
  return JSON.stringify(state);
}

function isWrite(text: string): boolean {
  return /\b(insert|update|delete|alter|drop|truncate)\b/i.test(text);
}

function placeholder(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function hasMicroseconds(value: unknown): boolean {
  return typeof value === "string" && /\.\d{4,}/.test(value);
}

/** node-pg returns `timestamptz` as a Date, which keeps only milliseconds. */
function driverView(row: Row): Row {
  if (!Object.values(row).some((value) => hasMicroseconds(value))) return row;
  const copy: Row = { ...row };
  if (Array.isArray(row.tags)) copy.tags = [...row.tags];
  for (const key of Object.keys(copy)) {
    if (hasMicroseconds(copy[key])) copy[key] = new Date(String(copy[key]));
  }
  return copy;
}

function applyTaskSet(task: Row, params: unknown[]) {
  const now = params[0];
  task.updated_at = typeof now === "string" ? now : new Date().toISOString();
  if (params[1] === true && typeof params[2] === "string") task.status = params[2];
  if (params[3] === true) task.completed_at = typeof params[4] === "string" ? params[4] : task.updated_at;
  if (params[5] === true) task.result = params[6] ?? null;
  if (params[7] === true) task.cost_usd = params[8] ?? null;
  if (params[9] === true) task.session_id = params[10] ?? null;
  if (params[11] === true) task.assigned_agent = params[12] ?? null;
}

/**
 * updateTask and remember throw when RETURNING is empty. A non-dry-run
 * control test needs one row back. Only a matching conditional write
 * changes the fixture.
 */
function returningRows(text: string, params: unknown[]): Row[] {
  if (/\bupdate\s+tasks\b/i.test(text)) return applyTaskWrite(text, params);
  if (/\bupdate\s+memory\b/i.test(text)) return applyMemoryWrite(text, params);
  if (/\binsert\s+into\s+memory\b/i.test(text) && /on conflict\s*\(\s*key\s*\)\s*do nothing/i.test(text)) {
    return applyMemoryInsertIfAbsent(params);
  }
  if (/\binsert\s+into\s+memory\b/i.test(text) && /where\s+not\s+exists/i.test(text)) {
    return applyMemoryInsertIfAbsent(params);
  }
  if (/\binsert\s+into\s+memory\b/i.test(text)) {
    const key = params[0];
    const existing = state.memory.find((row) => row.key === key);
    return [
      {
        id: typeof existing?.id === "number" ? existing.id : 42,
        key: typeof key === "string" ? key : null,
        content: typeof params[1] === "string" ? params[1] : "",
        tags: Array.isArray(params[2]) ? params[2] : [],
        agent_id: typeof params[3] === "string" ? params[3] : null,
        source: null,
        facts_at: null,
        created_at: new Date().toISOString(),
        updated_at: typeof params[4] === "string" ? params[4] : new Date().toISOString(),
      },
    ];
  }
  return [];
}

function revisionIndex(text: string): number | null {
  return placeholder(text, /md5\(\s*(?:m|t)::text\s*\)\s*=\s*\$(\d+)/i);
}

function applyTaskWrite(text: string, params: unknown[]): Row[] {
  const idIndex = placeholder(text, /where\s+(?:\w+\.)?id\s*=\s*\$(\d+)/i);
  const id = idIndex == null ? params[params.length - 1] : params[idIndex];
  const task = state.tasks.find((row) => row.id === id || row.id === Number(id));
  if (!task) return [];
  const revIndex = revisionIndex(text);
  if (revIndex == null) return [{ ...task }];
  if (stableRowRevision(task) !== params[revIndex]) return [];
  applyTaskSet(task, params);
  appliedCount += 1;
  return [{ ...task }];
}

function applyMemoryWrite(text: string, params: unknown[]): Row[] {
  const keyIndex = placeholder(text, /where\s+(?:\w+\.)?key\s*=\s*\$(\d+)/i);
  if (keyIndex == null) return [];
  const note = state.memory.find((row) => row.key === params[keyIndex]);
  if (!note) return [];
  const revIndex = revisionIndex(text);
  if (revIndex == null) return [{ ...note }];
  if (stableRowRevision(note) !== params[revIndex]) return [];
  note.content = params[0];
  note.tags = Array.isArray(params[1]) ? [...params[1]] : [];
  note.agent_id = params[2] ?? null;
  note.updated_at = params[3];
  note.source = null;
  note.facts_at = null;
  appliedCount += 1;
  return [{ ...note, tags: Array.isArray(note.tags) ? [...(note.tags as unknown[])] : [] }];
}

function duplicateKey(): Error {
  const err = new Error('duplicate key value violates unique constraint "memory_key_key"');
  (err as Error & { code: string }).code = "23505";
  return err;
}

function applyMemoryInsertIfAbsent(params: unknown[], raced = false): Row[] {
  const key = params[0];
  if (state.memory.some((row) => row.key === key)) {
    if (raced) throw duplicateKey();
    return [];
  }
  const row: Row = {
    id: 100 + state.memory.length,
    key: typeof key === "string" ? key : null,
    content: typeof params[1] === "string" ? params[1] : "",
    tags: Array.isArray(params[2]) ? [...params[2]] : [],
    agent_id: typeof params[3] === "string" ? params[3] : null,
    source: null,
    facts_at: null,
    created_at: typeof params[4] === "string" ? params[4] : new Date().toISOString(),
    updated_at: typeof params[4] === "string" ? params[4] : new Date().toISOString(),
  };
  state.memory.push(row);
  appliedCount += 1;
  return [{ ...row, tags: [...(row.tags as unknown[])] }];
}

function isAbsentInsert(text: string): boolean {
  return /\binsert\s+into\s+memory\b/i.test(text) && /where\s+not\s+exists/i.test(text);
}

function waitForInsertRace(): Promise<void> {
  return new Promise((resolve) => {
    insertRaceWaiters.push(resolve);
    if (insertRaceWaiters.length >= insertRaceNeed) {
      const pending = insertRaceWaiters.splice(0);
      insertRaceNeed = 0;
      for (const resume of pending) resume();
    }
  });
}

function projectRow(text: string, alias: "m" | "t", row: Row): Row {
  if (!new RegExp(`md5\\(\\s*${alias}::text\\s*\\)`, "i").test(text)) return driverView(row);
  const revision = stableRowRevision(row);
  if (!new RegExp(`${alias}\\.\\*`).test(text)) return { revision };
  const viewed = driverView(row);
  return viewed === row ? { ...viewed, revision } : { ...viewed, revision };
}

function finishMemoryRead(text: string, params: unknown[]): Row[] {
  const key = params[0];
  const matched = key === undefined ? state.memory : state.memory.filter((row) => row.key === key);
  const rows = matched.map((row) => projectRow(text, "m", row));
  if (afterMemorySelect) {
    const fn = afterMemorySelect;
    afterMemorySelect = null;
    fn();
  }
  return rows;
}

(
  globalThis as unknown as {
    __mcPgPool?: { query: (text: string, params?: unknown[]) => Promise<{ rows: Row[] }>; on: () => void };
  }
).__mcPgPool = {
  on() {},
  async query(text: string, params: unknown[] = []) {
    queries.push(text);
    if (isWrite(text)) {
      writes.push(text);
      if (rejectWrites) throw new Error(`dry run attempted a write: ${text}`);
      if (insertRaceNeed > 0 && isAbsentInsert(text)) {
        await waitForInsertRace();
        return { rows: applyMemoryInsertIfAbsent(params, true) };
      }
      return { rows: returningRows(text, params) };
    }
    if (text.includes("watched_repos")) return { rows: state.repos };
    if (text.includes("from tasks")) {
      const id = params[0];
      const matched = id === undefined
        ? state.tasks
        : state.tasks.filter((row) => row.id === id || row.id === Number(id));
      return { rows: matched.map((row) => projectRow(text, "t", row)) };
    }
    if (text.includes("from memory")) return { rows: finishMemoryRead(text, params) };
    return { rows: [] };
  },
};
