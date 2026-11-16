/**
 * The actor-admin fixture gate must reject a URL before pg constructs a
 * client. Query parameters can replace host, port, and user after the
 * authority has already been checked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client, Pool } from "pg";
import { assertActorAdminFixture } from "../../scripts/actor-admin-fixture";

const GOOD = "postgresql://ak_backlog_test@127.0.0.1:65438/ak_actor_admin";
const REJECTED = [
  "postgresql://ak_backlog_test@127.0.0.1:65438/ak_actor_admin?host=external.invalid&port=5432&user=other_user",
  "postgresql://ak_backlog_test@127.0.0.1:65438/ak_actor_admin?sslmode=disable",
  "postgresql://ak_backlog_test@127.0.0.1:65438/ak_actor_admin?",
  "postgresql://ak_backlog_test@127.0.0.1:65438/ak_actor_admin#fragment",
  "postgresql://ak_backlog_test:secret@127.0.0.1:65438/ak_actor_admin",
  "postgresql://ak_backlog_test@localhost:65438/ak_actor_admin",
  "postgresql://other_user@127.0.0.1:65438/ak_actor_admin",
  "postgresql://ak_backlog_test@127.0.0.1:5432/ak_actor_admin",
  "postgresql://ak_backlog_test@127.0.0.1:65438/other_db",
  "host=127.0.0.1 port=65438 user=ak_backlog_test dbname=ak_actor_admin",
  "",
];

describe("actor admin fixture gate", () => {
  it("rejects search, fragment, and password before constructing a client or pool", () => {
    const constructed: string[] = [];
    const open = (raw: string) => {
      const connectionString = assertActorAdminFixture(raw);
      constructed.push("client");
      const client = new Client({ connectionString });
      constructed.push("pool");
      const pool = new Pool({ connectionString, max: 1 });
      return { client, pool };
    };

    for (const raw of REJECTED) {
      constructed.length = 0;
      let rejected = false;
      try {
        open(raw);
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, raw);
      assert.deepEqual(constructed, [], raw);
    }
  });

  it("accepts only the loopback fixture and exposes that target on the client", async () => {
    const constructed: string[] = [];
    const connectionString = assertActorAdminFixture(GOOD);
    constructed.push("client");
    const client = new Client({ connectionString });
    constructed.push("pool");
    const pool = new Pool({ connectionString, max: 1 });
    try {
      assert.deepEqual(constructed, ["client", "pool"]);
      assert.equal(client.host, "127.0.0.1");
      assert.equal(String(client.port), "65438");
      assert.equal(client.user, "ak_backlog_test");
      assert.equal(client.database, "ak_actor_admin");
      assert.equal(pool.options.connectionString, GOOD);
      assert.equal(assertActorAdminFixture("postgres://ak_backlog_test@127.0.0.1:65438/ak_actor_admin").startsWith("postgres:"), true);
    } finally {
      await pool.end();
    }
  });
});
