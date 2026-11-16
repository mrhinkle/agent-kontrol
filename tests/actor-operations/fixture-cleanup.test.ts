import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actorOperationsFixture, withOwnedFixtureCleanup } from "./fixture";

/**
 * Cleanup gate. This file does not import the database and does not open a pool.
 * A wrong or unreadable identity must not run the mutating cleanup callback.
 */
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

describe("actor operations fixture cleanup gate", () => {
  it("runs no mutating cleanup when the connected identity is not the fixture", async () => {
    const calls: string[] = [];
    const sql: SqlTag = async (strings) => {
      calls.push(strings.join(" "));
      return [{ db: "other_database", db_user: "ak_backlog_test" }];
    };
    let mutated = 0;
    await withOwnedFixtureCleanup(sql, actorOperationsFixture().database, async () => {
      mutated += 1;
    });
    assert.equal(mutated, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /select current_database/);
    assert.equal(/drop|delete|insert|update/i.test(calls[0]), false);
  });

  it("runs no mutating cleanup when the identity read fails", async () => {
    const sql: SqlTag = async () => {
      throw new Error("identity unavailable");
    };
    let mutated = 0;
    await withOwnedFixtureCleanup(sql, "ak_actor_operations", async () => {
      mutated += 1;
    });
    assert.equal(mutated, 0);
  });

  it("runs cleanup only after the identity read matches", async () => {
    const fixture = actorOperationsFixture();
    const calls: string[] = [];
    const sql: SqlTag = async (strings) => {
      calls.push(strings.join(" "));
      return [{ db: fixture.database, db_user: "ak_backlog_test" }];
    };
    let mutated = 0;
    await withOwnedFixtureCleanup(sql, fixture.database, async () => {
      mutated += 1;
    });
    assert.equal(mutated, 1);
    assert.equal(calls.length, 1);
  });
});
