/**
 * Opt-in gate for the slice A fixture database.
 *
 * pg gives query host, port, and user precedence over the URL authority, so a
 * loopback-looking string can still name another server. Search, fragment, and
 * password are refused before any client is constructed. The accepted string's
 * authority and database are the only target this harness may use.
 */

const FIXTURE_HOST = "127.0.0.1";
const FIXTURE_PORT = "65438";
const FIXTURE_USER = "ak_backlog_test";
const FIXTURE_DATABASE = "ak_actor_admin";

export function assertActorAdminFixture(raw: string | undefined): string {
  if (!raw) throw new Error("DATABASE_URL is not the actor admin fixture");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("actor admin fixture URL is not a URL");
  }
  if (raw.includes("?") || raw.includes("#") || url.search || url.hash || url.password) {
    throw new Error("actor admin fixture URL must not include a query, fragment, or password");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    url.hostname !== FIXTURE_HOST ||
    url.port !== FIXTURE_PORT ||
    user !== FIXTURE_USER ||
    database !== FIXTURE_DATABASE
  ) {
    throw new Error("refusing to run actor admin tests outside ak_actor_admin on 127.0.0.1:65438");
  }
  return raw;
}
