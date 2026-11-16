/**
 * Owned actor-operations database. The URL is a constant so a test cannot
 * inherit an ambient or production DATABASE_URL. Query and hash are rejected
 * before any pool exists: libpq lets those parameters replace the host.
 */
const FIXTURE_DATABASE = "ak_actor_operations";
const FIXTURE_USER = "ak_backlog_test";
const FIXTURE_URL = "postgres://ak_backlog_test@127.0.0.1:65438/ak_actor_operations";

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

export function actorOperationsFixture(): { url: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(FIXTURE_URL);
  } catch {
    throw new Error("actor operations fixture URL is not a postgres URL");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const protocolOk = parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  if (
    !protocolOk
    || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "65438"
    || parsed.username !== FIXTURE_USER
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || database !== FIXTURE_DATABASE
  ) {
    throw new Error("actor operations fixture URL is not the owned local database");
  }
  return { url: FIXTURE_URL, database };
}

export async function confirmActorOperationsFixture(sql: SqlTag, database: string): Promise<void> {
  const rows = await sql`select current_database() as db, current_user as db_user`;
  const row = rows[0];
  if (row?.db !== database || row?.db_user !== FIXTURE_USER) {
    throw new Error("connected database is not the actor operations fixture");
  }
}

/** True only for this fixture's database and role. A failed read is not a match. */
export function actorOperationsIdentity(
  row: { db?: unknown; db_user?: unknown } | undefined,
  database: string,
): boolean {
  return row?.db === database && row?.db_user === FIXTURE_USER;
}

/**
 * Run mutating cleanup only after a fresh identity read matches this fixture.
 * A failed or mismatched read returns without calling `mutate`.
 */
export async function withOwnedFixtureCleanup(
  sql: SqlTag,
  database: string,
  mutate: () => Promise<void>,
): Promise<void> {
  let row: { db?: unknown; db_user?: unknown } | undefined;
  try {
    const seen = await sql`select current_database() as db, current_user as db_user`;
    row = seen[0];
  } catch {
    return;
  }
  if (!actorOperationsIdentity(row, database)) return;
  await mutate();
}

/** Close the pool this process opened. Closing is not a data mutation. */
export async function closeActorOperationsPool(): Promise<void> {
  const holder = globalThis as unknown as { __mcPgPool?: { end: () => Promise<void> } };
  const opened = holder.__mcPgPool;
  holder.__mcPgPool = undefined;
  if (!opened) return;
  await opened.end();
}
