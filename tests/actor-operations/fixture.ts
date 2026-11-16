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
