/**
 * Runs the store against a real Postgres through the pg driver.
 * Usage: DATABASE_URL=postgresql://... npm run test:pg
 * Expects supabase/schema.sql to be applied. Skips (exit 0) when DATABASE_URL is unset.
 */
import assert from "node:assert/strict";
import { sql } from "../src/lib/db";
import { report, remember, recall, createTask, claimNextTask, listTasks } from "../src/lib/store";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("test:pg skipped: DATABASE_URL is not set");
    return;
  }
  const driverOverride = process.env.MC_DB_DRIVER;
  const rows = await sql()`select 1 as one`;
  assert.equal(Number(rows[0].one), 1);

  const tag = `pgtest-${Date.now()}`;
  await report({ agent_id: `${tag}-agent`, platform: "codex", machine: "m1", kind: "session_start", title: "hello", project: "p" } as never);

  const first = await remember({ content: `alpha ${tag}`, key: `${tag}/k1`, tags: [tag, "b"], agent_id: `${tag}-agent` });
  const second = await remember({ content: `alpha ${tag} v2`, key: `${tag}/k1`, tags: [tag], agent_id: `${tag}-agent` });
  assert.equal(first.id, second.id, "same key must upsert, not insert");
  assert.equal(second.content, `alpha ${tag} v2`);

  const hits = await recall({ query: tag.toUpperCase(), tags: [tag] });
  assert.equal(hits.length, 1, "case-insensitive search plus tag overlap");
  assert.ok(Array.isArray(hits[0].tags), "text[] comes back as an array");

  const task = await createTask({ title: `smoke ${tag}`, platform: `pgtest-${tag}`, priority: 2 } as never);
  const claimed = await claimNextTask({ platform: `pgtest-${tag}`, machine: "m1", agent_id: `${tag}-agent` });
  const again = await claimNextTask({ platform: `pgtest-${tag}`, machine: "m1", agent_id: `${tag}-agent` });
  assert.equal(claimed?.id, task.id, "claim returns the queued task");
  assert.equal(again, null, "a task is never handed out twice");
  const all = await listTasks({ status: "claimed" });
  assert.ok(all.some((t) => t.id === task.id));

  console.log(`test:pg ok (driver override: ${driverOverride ?? "auto"})`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("test:pg FAILED", e);
  process.exit(1);
});
