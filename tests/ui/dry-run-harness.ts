/**
 * Installed before any route import. Points the pg driver at an in-memory
 * query spy so a dry run can be proved not to write, without a database.
 */
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:5432/ak_dry_run";
process.env.MC_DB_DRIVER = "pg";
process.env.MC_TOKEN = "dry-run-test-token";
process.env.MC_DASHBOARD_PASSWORD = "dry-run-dashboard";

export const queries: string[] = [];
export const writes: string[] = [];

type Row = Record<string, unknown>;

const state = {
  repos: [] as Row[],
  tasks: [] as Row[],
  memory: [] as Row[],
};

let rejectWrites = false;

/** Tests set this after resetSpy. Assigning the imported binding is illegal. */
export function setRejectWrites(value: boolean) {
  rejectWrites = value;
}

export function resetSpy() {
  queries.length = 0;
  writes.length = 0;
  rejectWrites = false;
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

/**
 * updateTask and remember throw when RETURNING is empty. A non-dry-run
 * control test needs one row back; the fixture itself is not mutated.
 */
function returningRows(text: string, params: unknown[]): Row[] {
  if (/\bupdate\s+tasks\b/i.test(text)) {
    const id = params[params.length - 1];
    const task = state.tasks.find((row) => row.id === id || row.id === Number(id));
    return task ? [{ ...task }] : [];
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
