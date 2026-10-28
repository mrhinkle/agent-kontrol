/**
 * Installed before any route import. Points the pg driver at an in-memory
 * query spy so a dry run can be proved not to write, without a database.
 *
 * Unconditional inserts and updates return a row and leave the fixture
 * alone, matching the older tests. A conditional write (updated_at equals
 * the expected token, a hash predicate, or insert-if-absent) mutates the
 * fixture only when the predicate matches, and counts that apply.
 */
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:5432/ak_dry_run";
process.env.MC_DB_DRIVER = "pg";
process.env.MC_TOKEN = "dry-run-test-token";
process.env.MC_DASHBOARD_PASSWORD = "dry-run-dashboard";

import { memoryDigest, taskDigest, updatedAtToken } from "../../src/lib/revision";

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

/** Tests set this after resetSpy. Assigning the imported binding is illegal. */
export function setRejectWrites(value: boolean) {
  rejectWrites = value;
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

function sameInstant(stored: unknown, expected: unknown): boolean {
  const left = updatedAtToken(stored);
  const right = updatedAtToken(expected);
  if (!left || !right) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs === rightMs;
  return left === right;
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

function applyTaskWrite(text: string, params: unknown[]): Row[] {
  const idIndex = placeholder(text, /where\s+id\s*=\s*\$(\d+)/i);
  const id = idIndex == null ? params[params.length - 1] : params[idIndex];
  const task = state.tasks.find((row) => row.id === id || row.id === Number(id));
  if (!task) return [];
  const tsIndex = placeholder(text, /updated_at\s*=\s*\$(\d+)::timestamptz/i);
  const hashIndex = placeholder(text, /=\s*\$(\d+)\s*\/\*\s*hash-revision\s*\*\//);
  if (tsIndex == null && hashIndex == null) return [{ ...task }];
  if (tsIndex != null) {
    if (!sameInstant(task.updated_at, params[tsIndex])) return [];
  } else if (task.updated_at != null || taskDigest(task) !== params[hashIndex ?? -1]) {
    return [];
  }
  applyTaskSet(task, params);
  appliedCount += 1;
  return [{ ...task }];
}

function applyMemoryWrite(text: string, params: unknown[]): Row[] {
  const keyIndex = placeholder(text, /where\s+key\s*=\s*\$(\d+)/i);
  if (keyIndex == null) return [];
  const note = state.memory.find((row) => row.key === params[keyIndex]);
  if (!note) return [];
  const tsIndex = placeholder(text, /updated_at\s*=\s*\$(\d+)::timestamptz/i);
  const hashIndex = placeholder(text, /=\s*\$(\d+)\s*\/\*\s*hash-revision\s*\*\//);
  if (tsIndex == null && hashIndex == null) return [{ ...note }];
  if (tsIndex != null) {
    if (!sameInstant(note.updated_at, params[tsIndex])) return [];
  } else if (note.updated_at != null || memoryDigest(note) !== params[hashIndex ?? -1]) {
    return [];
  }
  note.content = params[0];
  note.tags = Array.isArray(params[1]) ? [...params[1]] : [];
  note.agent_id = params[2] ?? null;
  note.updated_at = params[3];
  note.source = null;
  note.facts_at = null;
  appliedCount += 1;
  return [{ ...note, tags: Array.isArray(note.tags) ? [...(note.tags as unknown[])] : [] }];
}

function applyMemoryInsertIfAbsent(params: unknown[]): Row[] {
  const key = params[0];
  if (state.memory.some((row) => row.key === key)) return [];
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

function withRowRevision(kind: "task" | "memory", rows: Row[]): Row[] {
  return rows.map((row) => ({
    ...row,
    row_revision: updatedAtToken(row.updated_at) ?? `rev:${kind === "task" ? taskDigest(row) : memoryDigest(row)}`,
  }));
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
      return { rows: returningRows(text, params) };
    }
    if (text.includes("row_revision") && text.includes("from tasks")) {
      const id = params[0];
      const rows = state.tasks.filter((row) => row.id === id || row.id === Number(id));
      return { rows: withRowRevision("task", rows) };
    }
    if (text.includes("row_revision") && text.includes("from memory")) {
      const key = params[0];
      const rows = state.memory.filter((row) => row.key === key);
      return { rows: withRowRevision("memory", rows) };
    }
    if (text.includes("watched_repos")) return { rows: state.repos };
    if (text.includes("from tasks")) {
      const id = params[0];
      if (id === undefined) return { rows: state.tasks };
      return { rows: state.tasks.filter((row) => row.id === id || row.id === Number(id)) };
    }
    if (text.includes("from memory")) {
      const key = params[0];
      if (key === undefined) return { rows: state.memory };
      return { rows: state.memory.filter((row) => row.key === key) };
    }
    return { rows: [] };
  },
};
