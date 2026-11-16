/**
 * Opt-in PostgreSQL tests for Q11 slice A.
 *
 * Does nothing unless AK_ACTOR_ADMIN_DATABASE_URL is set. The value must name
 * the loopback fixture database ak_actor_admin on 127.0.0.1:65438 as
 * ak_backlog_test, with no query, fragment, or password. This file does not
 * read a production URL and does not open a pool when the variable is absent
 * or the value is rejected.
 */
import { assertActorAdminFixture } from "./actor-admin-fixture";

async function main(): Promise<void> {
  const raw = process.env.AK_ACTOR_ADMIN_DATABASE_URL;
  if (!raw) {
    console.log("actor-admin tests skipped: AK_ACTOR_ADMIN_DATABASE_URL is not set");
    return;
  }
  const env = process.env as Record<string, string | undefined>;
  env.DATABASE_URL = assertActorAdminFixture(raw);
  env.MC_DB_DRIVER = "pg";
  env.NODE_ENV = "test";
  const { testCredentialAdmin } = await import("./actor-admin-credentials-tests");
  await testCredentialAdmin();
  console.log("actor-admin credentials: ok");
  const { testSkillSync } = await import("./actor-admin-sync-tests");
  await testSkillSync();
  console.log("actor-admin sync: ok");
  const { testSkillDrift } = await import("./actor-admin-drift-tests");
  await testSkillDrift();
  console.log("actor-admin drift: ok");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
