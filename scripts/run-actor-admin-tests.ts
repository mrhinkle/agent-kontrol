/**
 * Opt-in PostgreSQL tests for Q11 slice A.
 *
 * Does nothing unless AK_ACTOR_ADMIN_DATABASE_URL is set. The value must name
 * the loopback fixture database ak_actor_admin on 127.0.0.1:65438 as
 * ak_backlog_test. This file does not read a production URL and does not
 * open a pool when the variable is absent.
 */
function fixtureUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AK_ACTOR_ADMIN_DATABASE_URL is not a URL");
  }
  const db = url.pathname.replace(/^\//, "");
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "65438" ||
    url.username !== "ak_backlog_test" ||
    db !== "ak_actor_admin"
  ) {
    throw new Error("AK_ACTOR_ADMIN_DATABASE_URL must be the ak_actor_admin fixture on 127.0.0.1:65438");
  }
  return raw;
}

async function main(): Promise<void> {
  const raw = process.env.AK_ACTOR_ADMIN_DATABASE_URL;
  if (!raw) {
    console.log("actor-admin tests skipped: AK_ACTOR_ADMIN_DATABASE_URL is not set");
    return;
  }
  const env = process.env as Record<string, string | undefined>;
  env.DATABASE_URL = fixtureUrl(raw);
  env.MC_DB_DRIVER = "pg";
  env.NODE_ENV = "test";
  const { testCredentialAdmin } = await import("./actor-admin-credentials-tests");
  await testCredentialAdmin();
  console.log("actor-admin credentials: ok");
  const { testSkillSync } = await import("./actor-admin-sync-tests");
  await testSkillSync();
  console.log("actor-admin sync: ok");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
