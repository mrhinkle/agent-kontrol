/**
 * Runs the store against a real Postgres through the pg driver.
 * Usage: DATABASE_URL=postgresql://... npm run test:pg
 * Expects supabase/schema.sql to be applied. Skips (exit 0) when DATABASE_URL is unset.
 */
import assert from "node:assert/strict";
import { sql } from "../src/lib/db";
import { report, remember, recall, createTask, claimNextTask, listTasks } from "../src/lib/store";
import { getWatchedRepos, replaceWatchedRepos } from "../src/lib/watched-repos";
import type { RepoConfig } from "../src/lib/progress-config";

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


  // Watched repos: fallback, ordered replace, removal, restoring order.
  const fallback: RepoConfig[] = [{ repo: "example-org/fallback", label: "Fallback", short: "fb", color: "#000000", blockedLabel: null }];
  await sql()`delete from watched_repos`;
  const empty = await getWatchedRepos(fallback);
  assert.equal(empty.source, "file", "an empty table falls back to the file list");
  assert.deepEqual(empty.repos, fallback);
  const a = { repo: `${tag}/a`, label: "A", short: `${tag}-a`, color: "#111111", blockedLabel: null };
  const b = { repo: `${tag}/b`, label: "B", short: `${tag}-b`, color: "#222222", blockedLabel: "blocked" };
  const c = { repo: `${tag}/c`, label: "C", short: `${tag}-c`, color: "#333333", blockedLabel: null };
  await replaceWatchedRepos([a, b, c]);
  let got = await getWatchedRepos(fallback);
  assert.equal(got.source, "database");
  assert.deepEqual(got.repos.map((r) => r.repo), [a.repo, b.repo, c.repo], "order is preserved");
  assert.equal(got.repos[1].blockedLabel, "blocked");
  assert.equal(got.repos[0].blockedLabel, null);
  await replaceWatchedRepos([c, { ...a, label: "A2" }]);
  got = await getWatchedRepos(fallback);
  assert.deepEqual(got.repos.map((r) => r.repo), [c.repo, a.repo], "reorder and removal apply together");
  assert.equal(got.repos[1].label, "A2", "existing rows are updated in place");
  // swapping short names between two repos must not trip over a uniqueness rule
  await replaceWatchedRepos([{ ...c, short: a.short }, { ...a, short: c.short }]);
  got = await getWatchedRepos(fallback);
  assert.deepEqual(got.repos.map((r) => r.short), [a.short, c.short], "short names can be swapped");
  // A save that fails part-way must leave the previous list exactly as it was.
  await replaceWatchedRepos([a, b]);
  await assert.rejects(replaceWatchedRepos([c, { ...c, label: "dup" }]), "a duplicate repo in one save is rejected by the database");
  got = await getWatchedRepos(fallback);
  assert.deepEqual(got.repos.map((r) => r.repo), [a.repo, b.repo], "a failed save changes nothing");
  assert.equal(got.repos[1].blockedLabel, "blocked");
  await sql()`delete from watched_repos`;
  assert.equal((await getWatchedRepos(fallback)).source, "file");

  console.log(`test:pg ok (driver override: ${driverOverride ?? "auto"})`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("test:pg FAILED", e);
  process.exit(1);
});
