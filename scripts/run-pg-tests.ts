/**
 * Runs the store against a real Postgres through the pg driver.
 * Usage: DATABASE_URL=postgresql://... npm run test:pg
 * Expects supabase/schema.sql to be applied. Skips (exit 0) when DATABASE_URL is unset.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { evaluateAlerts, setBeforeClaimForTests, setBriefSettingsForTests } from "../src/lib/brief-alerts";
import type { BriefSettings } from "../src/lib/progress-config";
import { sql } from "../src/lib/db";
import { IdempotencyConflict, setIdempotencyClockForTests } from "../src/lib/idempotency";
import { StaleWrite } from "../src/lib/revision";
import { readReceipt } from "../src/lib/activity";
import { report, remember, recall, createTask, claimNextTask, listTasks, updateTask, readMemoryForPreview, readTaskForPreview, findAgent, deleteMemory, slugify } from "../src/lib/store";
import { updateTaskForTool } from "../src/lib/dry-run-actions";
import { getWatchedRepos, replaceWatchedRepos, setRepoOverride } from "../src/lib/watched-repos";
import { applyOwnerDiscovery } from "../src/lib/watched-owners";
import type { RepoConfig } from "../src/lib/progress-config";
import { getTrace, listTraces, pruneSpans, upsertSpans } from "../src/lib/trace-store";
import { pruneAutomaticNotes, upsertAutomaticNote } from "../src/lib/session-memory";
import type { SpanInput } from "../src/lib/traces";
import {
  ageDays,
  claimDecisionWriteback,
  getDecision,
  listDecisions,
  patchDecision,
  reconcileDecisions,
  partitionBrief,
  setDecisionWriteback,
  toBriefDecisions,
  upsertDecision,
  WRITEBACK_LOCK_LEASE_SECONDS,
  type UpsertInput,
} from "../src/lib/decisions";
import { finishSyncRun, markSkillRemoved, SyncLeaseLost, upsertSettings, upsertSkill } from "../src/lib/skills/store";
import { runScheduleTick, type TickResult } from "../src/lib/skills/schedule";
import { listLastScheduledTasks, listOpenScheduledTasks } from "../src/lib/skills/schedule-store";
import type { SkillRecord } from "../src/lib/skills/types";
import { readBeats, upsertBeat, WATCH_STATUSES, type WatchBeat } from "../src/lib/watch";
import {
  MEMORY_REST,
  TASK_REST,
  TRACE_LIST,
  decodeCursor,
  memoryKeyset,
  parseToolList,
  splitPage,
  taskKeyset,
  traceKeyset,
} from "../src/lib/list-params";

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

  // A microsecond timestamp stays in the row. The preview token is md5(row),
  // computed in SQL, so the confirm matches that same value.
  const memoryKey = `${tag}/k1`;
  await sql()`update memory set updated_at = timestamptz '2026-10-28 12:00:00.123456+00' where key = ${memoryKey}`;
  const micros = await sql()`select to_char(updated_at, 'US') as us from memory where key = ${memoryKey}`;
  assert.equal(String(micros[0].us), "123456");
  const memoryPreview = await readMemoryForPreview(memoryKey);
  assert.ok(memoryPreview);
  assert.match(memoryPreview.revision, /^[0-9a-f]{32}$/);
  const confirmed = await remember({ content: `confirmed ${tag}`, key: memoryKey, expected_revision: memoryPreview.revision });
  assert.equal(confirmed.content, `confirmed ${tag}`);
  await assert.rejects(
    () => remember({ content: `too late ${tag}`, key: memoryKey, expected_revision: memoryPreview.revision }),
    (err: unknown) => err instanceof StaleWrite && err.currentRevision !== memoryPreview.revision,
  );

  const knownAgent = await findAgent(`${tag}-agent`);
  assert.equal(knownAgent?.id, `${tag}-agent`);
  assert.equal(await findAgent(`${tag}-missing`), null);
  assert.equal(await findAgent("***"), null);
  const deleteKey = `${tag}/delete-me`;
  await assert.rejects(
    () => deleteMemory({ key: deleteKey }),
    (err: unknown) => err instanceof Error && err.message === "Memory not found",
  );
  await remember({ content: "one", key: deleteKey, agent_id: `${tag}-agent` });
  const beforeDelete = await readMemoryForPreview(deleteKey);
  assert.ok(beforeDelete);
  await remember({ content: "two", key: deleteKey, agent_id: `${tag}-agent` });
  await assert.rejects(
    () => deleteMemory({ key: deleteKey, expected_revision: beforeDelete.revision }),
    (err: unknown) => err instanceof StaleWrite && err.currentRevision !== beforeDelete.revision,
  );
  const kept = await readMemoryForPreview(deleteKey);
  assert.ok(kept);
  assert.equal(kept.item.content, "two");
  const removed = await deleteMemory({ key: deleteKey, expected_revision: kept.revision });
  assert.equal(removed.content, "two");
  assert.equal(await readMemoryForPreview(deleteKey), null);
  const actorTask = await createTask({ title: `${tag} actor requeue`, platform: "any" });
  const stamped = await updateTask({
    id: actorTask.id,
    status: "failed",
    actor: { actor_type: "agent", actor_id: `${tag}-actor` },
  });
  assert.equal(stamped.actor_type, "agent");
  assert.equal(stamped.actor_id, `${tag}-actor`);
  const untouched = await updateTask({ id: actorTask.id, result: "still mine" });
  assert.equal(untouched.actor_id, `${tag}-actor`);
  assert.equal(untouched.result, "still mine");

  const absentKey = `${tag}/absent`;
  const raced = await Promise.allSettled([
    remember({ content: `race-a ${tag}`, key: absentKey, expected_revision: "absent" }),
    remember({ content: `race-b ${tag}`, key: absentKey, expected_revision: "absent" }),
  ]);
  assert.equal(raced.filter((item) => item.status === "fulfilled").length, 1);
  const lost = raced.find((item) => item.status === "rejected");
  assert.ok(lost && lost.status === "rejected");
  assert.equal(lost.reason instanceof StaleWrite, true);
  const absentCount = await sql()`select count(*)::int as n from memory where key = ${absentKey}`;
  assert.equal(Number(absentCount[0].n), 1);
  await sql()`delete from memory where key = ${absentKey}`;

  const task = await createTask({ title: `smoke ${tag}`, platform: `pgtest-${tag}`, priority: 2 } as never);
  const claimed = await claimNextTask({ platform: `pgtest-${tag}`, machine: "m1", agent_id: `${tag}-agent` });
  const again = await claimNextTask({ platform: `pgtest-${tag}`, machine: "m1", agent_id: `${tag}-agent` });
  assert.equal(claimed?.id, task.id, "claim returns the queued task");
  assert.equal(again, null, "a task is never handed out twice");
  const all = await listTasks({ status: "claimed" });
  assert.ok(all.some((t) => t.id === task.id));

  await sql()`update tasks set updated_at = timestamptz '2026-10-28 12:00:00.123456+00' where id = ${task.id}`;
  const taskMicros = await sql()`select to_char(updated_at, 'US') as us from tasks where id = ${task.id}`;
  assert.equal(String(taskMicros[0].us), "123456");
  const taskPreview = await readTaskForPreview(Number(task.id));
  assert.ok(taskPreview);
  assert.match(taskPreview.revision, /^[0-9a-f]{32}$/);
  const cancelled = await updateTask({ id: Number(task.id), status: "cancelled", expected_revision: taskPreview.revision });
  assert.equal(cancelled.status, "cancelled");


  // Watched repos: fallback, ordered replace, removal, restoring order.
  const fallback: RepoConfig[] = [{ repo: "example-org/fallback", label: "Fallback", short: "fb", color: "#000000", blockedLabel: null }];
  await sql()`delete from watched_owners`;
  await sql()`delete from watched_repos`;
  const empty = await getWatchedRepos(fallback);
  assert.equal(empty.source, "file", "no owners and no repos falls back to the file list");
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

  // Traces: upsert merges an open span with its close, lists summarize, prune removes old rows.
  const traceId = randomUUID().replace(/-/g, "");
  const mk = (id: string, parent: string | null, over: Partial<SpanInput> = {}): SpanInput => ({
    trace_id: traceId, span_id: id, parent_span_id: parent, agent_id: `${tag}-agent`, session_id: "s1", name: id,
    kind: "tool", status: "unset", status_message: null, started_at: "2026-10-09T12:00:00.000Z", ended_at: null,
    attributes: { a: 1 }, model: null, input_tokens: null, output_tokens: null, cost_usd: null, ...over,
  });
  await upsertSpans([mk("00000000000000a1", null, { kind: "session", name: "session" }), mk("00000000000000a2", "00000000000000a1")]);
  await upsertSpans([mk("00000000000000a2", null, { status: "error", status_message: "bad", ended_at: "2026-10-09T12:00:02.000Z", attributes: { b: "x" }, input_tokens: 10, output_tokens: 5, cost_usd: 0.25 })]);
  const stored = await getTrace(traceId);
  assert.equal(stored.length, 2);
  const child = stored.find((s) => s.span_id === "00000000000000a2")!;
  assert.equal(child.parent_span_id, "00000000000000a1", "a later write without a parent keeps the stored parent");
  assert.equal(child.status, "error");
  assert.equal(child.ended_at, "2026-10-09T12:00:02.000Z");
  assert.deepEqual(child.attributes, { a: 1, b: "x" }, "attributes merge");
  assert.equal(child.input_tokens, 10);
  assert.equal(child.cost_usd, 0.25);
  const summary = (await listTraces({ agent: `${tag}-agent` })).find((t) => t.trace_id === traceId)!;
  assert.equal(summary.span_count, 2);
  assert.equal(summary.error_count, 1);
  assert.equal(summary.open_count, 1, "the session span is still open");
  assert.equal(summary.ended_at, null, "a trace with an open span has no end");
  assert.equal(summary.root_name, "session");
  assert.equal(summary.output_tokens, 5);
  assert.equal((await listTraces({ agent: `${tag}-agent`, errorsOnly: true })).length, 1);
  assert.equal((await listTraces({ agent: `${tag}-agent`, before: "2026-10-09T11:00:00.000Z" })).length, 0, "before filters by start time");
  // Out-of-order and retried updates are monotonic: the later end and a failure survive a stale "ok".
  await upsertSpans([mk("00000000000000a2", "00000000000000a1", { status: "ok", ended_at: "2026-10-09T12:00:01.000Z", attributes: { c: "late" } })]);
  const afterStale = (await getTrace(traceId)).find((s) => s.span_id === "00000000000000a2")!;
  assert.equal(afterStale.status, "error", "a stale ok cannot erase an error");
  assert.equal(afterStale.status_message, "bad");
  assert.equal(afterStale.ended_at, "2026-10-09T12:00:02.000Z", "a stale end cannot shorten a span");
  assert.equal(afterStale.attributes.c, "late", "attributes still merge");
  // Always a different id from traceId: flip the last hex digit, so the test cannot collide with itself.
  const oldTrace = traceId.slice(0, 31) + (traceId.endsWith("0") ? "1" : "0");
  await upsertSpans([mk("00000000000000b1", null, { trace_id: oldTrace, started_at: "2020-01-01T00:00:00.000Z" })]);
  await pruneSpans();
  assert.equal((await getTrace(oldTrace)).length, 0, "spans older than the retention window are pruned");
  assert.equal((await getTrace(traceId)).length, 2, "recent spans are kept");
  await sql()`delete from spans where trace_id = ${traceId}`;

  // Session writeback: any platform that ends a session leaves one note in shared memory.
  const sid = `${tag}-sess`;
  const wbAgent = `${tag}-wb`;
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  await report({ agent_id: wbAgent, platform: "codex", display_name: "WB Agent", session_id: sid, kind: "session_start", project: "Demo App" } as never);
  await sql()`update sessions set started_at = ${at(30)} where id = ${sid}`;
  await report({ agent_id: wbAgent, session_id: sid, kind: "milestone", title: "Migrated the schema" } as never);
  await report({ agent_id: wbAgent, session_id: sid, kind: "turn_start", title: "New instruction: rotate the production keys" } as never);
  await report({ agent_id: wbAgent, session_id: sid, kind: "error", title: "build failed" } as never);
  await sql()`insert into spans (trace_id, span_id, agent_id, session_id, name, kind, status, started_at, ended_at)
              values (${randomUUID().replace(/-/g, "")}, '00000000000000d1', ${wbAgent}, ${sid}, 'Bash', 'tool', 'error', now(), now()),
                     (${randomUUID().replace(/-/g, "")}, '00000000000000d2', ${wbAgent}, ${sid}, 'Bash', 'tool', 'ok', now(), now())`;
  await report({ agent_id: wbAgent, session_id: sid, kind: "session_end", title: "Session ended" } as never);
  const note = (await recall({ key: `session/${sid}` }))[0];
  assert.ok(note, "an ended session leaves a note");
  assert.ok(note.tags.includes("session-summary") && note.tags.includes("codex") && note.tags.includes("demo-app"));
  assert.match(note.content, /WB Agent \[codex\] on Demo App/);
  assert.match(note.content, /Tools: Bash×2 \(1 failed\)/);
  assert.match(note.content, /errors: 1/);
  assert.match(note.content, /Milestones reported: 1\./);
  assert.doesNotMatch(note.content, /Migrated the schema/, "reported text stays out by default");
  assert.doesNotMatch(note.content, /rotate the production keys/, "prompt text stays out by default");
  const noteRow = (await sql()`select source, facts_at from memory where key = ${`session/${sid}`}`)[0];
  assert.equal(noteRow.source, "automatic-session");
  assert.ok(noteRow.facts_at, "the note records how fresh its facts were");
  process.env.MC_MEMORY_WRITEBACK_TEXT = "1";
  await report({ agent_id: wbAgent, session_id: sid, kind: "session_end", title: "Session ended" } as never);
  const withText = (await recall({ key: `session/${sid}` }))[0];
  assert.match(withText.content, /Migrated the schema/, "text appears with the opt-in");
  assert.doesNotMatch(withText.content, /rotate the production keys/, "prompt-derived text still needs its own opt-in");
  delete process.env.MC_MEMORY_WRITEBACK_TEXT;

  // A stale snapshot can never replace a newer note, and a note an agent wrote itself is never overwritten.
  const keyed = { key: `session/${tag}-race`, content: "NEW", tags: ["session-summary"] };
  await upsertAutomaticNote(keyed, wbAgent, "2026-10-09T12:00:10.000Z");
  await upsertAutomaticNote({ ...keyed, content: "STALE" }, wbAgent, "2026-10-09T12:00:05.000Z");
  assert.equal((await recall({ key: keyed.key }))[0].content, "NEW", "an older snapshot loses");
  await upsertAutomaticNote({ ...keyed, content: "NEWER" }, wbAgent, "2026-10-09T12:00:10.000Z");
  assert.equal((await recall({ key: keyed.key }))[0].content, "NEWER", "an equal or newer snapshot wins");
  await remember({ content: "written by an agent", key: `session/${tag}-own`, tags: ["session-summary"], agent_id: wbAgent });
  await upsertAutomaticNote({ key: `session/${tag}-own`, content: "AUTO", tags: ["session-summary"] }, wbAgent, "2026-10-09T12:00:10.000Z");
  assert.equal((await recall({ key: `session/${tag}-own` }))[0].content, "written by an agent", "agent-written notes are not overwritten");

  // Cleanup removes only expired AUTOMATIC notes, even when an agent used the same tag.
  await sql()`update memory set updated_at = now() - interval '90 days' where key in (${`session/${tag}-race`}, ${`session/${tag}-own`})`;
  await pruneAutomaticNotes();
  assert.equal((await recall({ key: `session/${tag}-race` })).length, 0, "an expired automatic note is removed");
  assert.equal((await recall({ key: `session/${tag}-own` })).length, 1, "an old note an agent wrote survives, even with the same tag");
  await report({ agent_id: wbAgent, session_id: sid, kind: "session_end", title: "Session ended" } as never);
  assert.equal((await recall({ tags: ["session-summary"], query: "WB Agent" })).filter((n) => n.key === `session/${sid}`).length, 1, "ending twice keeps one note");

  // An MCP agent that reports status done also gets a note; a thin session does not.
  const sid2 = `${tag}-mcp`;
  await report({ agent_id: `${tag}-mcp-agent`, session_id: sid2, kind: "milestone", title: "Opened the PR", project: "Demo App" } as never);
  await report({ agent_id: `${tag}-mcp-agent`, session_id: sid2, kind: "status", status: "done", title: "Finished" } as never);
  assert.ok((await recall({ key: `session/${sid2}` }))[0], "status done via the MCP path writes a note");
  const sid3 = `${tag}-thin`;
  await report({ agent_id: `${tag}-thin-agent`, session_id: sid3, kind: "session_start" } as never);
  await report({ agent_id: `${tag}-thin-agent`, session_id: sid3, kind: "session_end" } as never);
  assert.equal((await recall({ key: `session/${sid3}` })).length, 0, "a thin session leaves no note");

  process.env.MC_MEMORY_WRITEBACK = "0";
  const sid4 = `${tag}-off`;
  await report({ agent_id: `${tag}-off-agent`, session_id: sid4, kind: "milestone", title: "Did a thing" } as never);
  await report({ agent_id: `${tag}-off-agent`, session_id: sid4, kind: "session_end" } as never);
  assert.equal((await recall({ key: `session/${sid4}` })).length, 0, "MC_MEMORY_WRITEBACK=0 turns it off");
  delete process.env.MC_MEMORY_WRITEBACK;
  await sql()`delete from memory where key like ${"session/" + tag + "%"}`;
  await sql()`delete from spans where session_id like ${tag + "%"}`;

  // Idempotency: replay returns the original task, a different body conflicts,
  // and a key older than 24 hours can be used again.
  const idemKey = `idem-${tag}`;
  const idemPlatform = `pgtest-idem-${tag}`;
  try {
    const first = await createTask({
      title: `idem ${tag}`,
      platform: idemPlatform,
      priority: 1,
      idempotency_key: idemKey,
    });
    const replay = await createTask({
      title: `idem ${tag}`,
      platform: idemPlatform,
      priority: 1,
      idempotency_key: idemKey,
    });
    assert.equal(String(replay.id), String(first.id), "the same idempotency key returns the original task");
    const queued = await sql()`select count(*)::int as n from tasks where platform = ${idemPlatform}`;
    assert.equal(Number(queued[0].n), 1, "a replay does not insert a second task");
    await assert.rejects(
      () => createTask({
        title: `other ${tag}`,
        platform: idemPlatform,
        priority: 1,
        idempotency_key: idemKey,
      }),
      (err: unknown) => err instanceof IdempotencyConflict,
    );
    const stillOne = await sql()`select count(*)::int as n from tasks where platform = ${idemPlatform}`;
    assert.equal(Number(stillOne[0].n), 1, "a conflict does not insert a task");
    setIdempotencyClockForTests(() => new Date(Date.now() + 25 * 60 * 60 * 1000));
    const afterExpiry = await createTask({
      title: `other ${tag}`,
      platform: idemPlatform,
      priority: 1,
      idempotency_key: idemKey,
    });
    assert.notEqual(String(afterExpiry.id), String(first.id), "an expired key can create a new task");
    await sql()`
      delete from events
      where kind = 'create_task'
        and detail->>'task_id' in (select id::text from tasks where platform = ${idemPlatform})
    `;
    await sql()`delete from tasks where platform = ${idemPlatform}`;
    await sql()`delete from idempotency_keys where idempotency_key = ${idemKey}`;
  } finally {
    setIdempotencyClockForTests(null);
  }

  await testActivityReceiptAtomic(tag);
  await testReportStatusAtomic(tag);
  await testDecisions(tag);
  await testSkillLeaseFence(tag);
  await testSkillSchedule(tag);
  await testWatchBeats(tag);
  await testWatchBeatRoute(tag);
  await testListCursors(tag);
  await testBriefAlerts(tag);
  await testZeroMergeCaseFold(tag);
  await testDecisionWritebackHardening(tag);
  await testRepoCaseIdentity(tag);

  console.log(`test:pg ok (driver override: ${driverOverride ?? "auto"})`);
}

/**
 * One idempotent create_task is one task, one event, and one receipt.
 * A forced events-insert failure rolls the write back with it.
 */
async function testActivityReceiptAtomic(tag: string) {
  const platform = `pgtest-act-${tag}`;
  const key = `act-${tag}`;
  const failPlatform = `pgtest-act-fail-${tag}`;
  const memoryKey = `${tag}/act-keep`;
  const freshKey = `${tag}/act-fresh`;
  const deleteKey = `${tag}/act-del`;
  const failIdem = `act-fail-${tag}`;
  try {
    const settled = await Promise.allSettled([
      createTask({ title: `race ${tag}`, platform, priority: 1, idempotency_key: key }),
      createTask({ title: `race ${tag}`, platform, priority: 1, idempotency_key: key }),
    ]);
    for (const item of settled) {
      if (item.status === "rejected" && !(item.reason instanceof IdempotencyConflict)) throw item.reason;
    }
    const won = settled.filter((item) => item.status === "fulfilled");
    assert.ok(won.length >= 1, "at least one concurrent create_task completed");
    const taskIds = new Set(won.map((item) => String(item.value.id)));
    assert.equal(taskIds.size, 1, "concurrent same-key creates share one task");
    const receiptIds = new Set(won.map((item) => readReceipt(item.value)?.id).filter((id): id is string => Boolean(id)));
    assert.equal(receiptIds.size, 1, "concurrent same-key creates share one receipt");
    const taskId = [...taskIds][0];
    const receiptId = [...receiptIds][0];
    const tasks = await sql()`select count(*)::int as n from tasks where platform = ${platform}`;
    assert.equal(Number(tasks[0].n), 1, "two concurrent calls insert one task");
    const events = await sql()`
      select id::text as id
      from events
      where kind = 'create_task' and detail->>'task_id' = ${taskId}
    `;
    assert.equal(events.length, 1, "two concurrent calls insert one activity event");
    assert.equal(String(events[0].id), receiptId);

    const replay = await createTask({ title: `race ${tag}`, platform, priority: 1, idempotency_key: key });
    assert.equal(String(replay.id), taskId);
    assert.equal(readReceipt(replay)?.id, receiptId, "a replay returns the stored receipt");
    const afterReplay = await sql()`
      select count(*)::int as n from events
      where kind = 'create_task' and detail->>'task_id' = ${taskId}
    `;
    assert.equal(Number(afterReplay[0].n), 1, "a replay does not insert a second event");

    await remember({ content: "before", key: memoryKey, agent_id: `${tag}-agent` });
    await remember({ content: "stay", key: deleteKey, agent_id: `${tag}-agent` });

    await sql()`
      create or replace function ak_test_fail_event()
      returns trigger
      language plpgsql
      as $fn$
      begin
        if new.kind in ('create_task', 'remember', 'delete_note', 'send_message', 'reply_to_operator') then
          raise exception 'simulated events insert failure';
        end if;
        return new;
      end;
      $fn$
    `;
    await sql()`drop trigger if exists ak_test_fail_event on events`;
    await sql()`
      create trigger ak_test_fail_event
      before insert on events
      for each row
      execute procedure ak_test_fail_event()
    `;

    const orphansBefore = await sql()`
      select count(*)::int as n
      from events e
      where e.kind = 'create_task'
        and not exists (
          select 1 from tasks t where t.id::text = e.detail->>'task_id'
        )
    `;
    await assert.rejects(
      () => createTask({ title: `fail ${tag}`, platform: failPlatform }),
      (err: unknown) => err instanceof Error && /simulated events insert failure/.test(err.message),
    );
    const failedTasks = await sql()`select count(*)::int as n from tasks where platform = ${failPlatform}`;
    assert.equal(Number(failedTasks[0].n), 0, "a failed event insert leaves no task");
    const orphans = await sql()`
      select count(*)::int as n
      from events e
      where e.kind = 'create_task'
        and not exists (
          select 1 from tasks t where t.id::text = e.detail->>'task_id'
        )
    `;
    assert.equal(
      Number(orphans[0].n),
      Number(orphansBefore[0].n),
      "a failed event insert leaves no receipt row",
    );

    await assert.rejects(
      () => remember({ content: "after", key: memoryKey, agent_id: `${tag}-agent` }),
      (err: unknown) => err instanceof Error && /simulated events insert failure/.test(err.message),
    );
    const kept = await sql()`select content from memory where key = ${memoryKey}`;
    assert.equal(String(kept[0]?.content), "before", "a failed event insert leaves the previous note");

    await assert.rejects(
      () => remember({ content: "nope", key: freshKey, agent_id: `${tag}-agent` }),
      (err: unknown) => err instanceof Error && /simulated events insert failure/.test(err.message),
    );
    const fresh = await sql()`select count(*)::int as n from memory where key = ${freshKey}`;
    assert.equal(Number(fresh[0].n), 0, "a failed event insert leaves no new note");

    await assert.rejects(
      () => deleteMemory({ key: deleteKey }),
      (err: unknown) => err instanceof Error && /simulated events insert failure/.test(err.message),
    );
    const stillThere = await sql()`select content from memory where key = ${deleteKey}`;
    assert.equal(String(stillThere[0]?.content), "stay", "a failed event insert does not delete the note");

    await assert.rejects(
      () => createTask({ title: `fail idem ${tag}`, platform: failPlatform, idempotency_key: failIdem }),
      (err: unknown) => err instanceof Error && /simulated events insert failure/.test(err.message),
    );
    await sql()`drop trigger if exists ak_test_fail_event on events`;
    const recovered = await createTask({
      title: `fail idem ${tag}`,
      platform: failPlatform,
      idempotency_key: failIdem,
    });
    assert.equal(readReceipt(recovered)?.kind, "create_task");
    const recoveredTasks = await sql()`select count(*)::int as n from tasks where platform = ${failPlatform}`;
    assert.equal(Number(recoveredTasks[0].n), 1, "a failed claim is released so the same key can write once");
    const recoveredEvents = await sql()`
      select count(*)::int as n from events
      where kind = 'create_task' and detail->>'task_id' = ${String(recovered.id)}
    `;
    assert.equal(Number(recoveredEvents[0].n), 1);
  } finally {
    await sql()`drop trigger if exists ak_test_fail_event on events`;
    await sql()`drop function if exists ak_test_fail_event()`;
    await sql()`
      delete from events e
      where e.kind in ('create_task', 'remember', 'delete_note')
        and (
          e.detail->>'memory_key' like ${`%${tag}%`}
          or e.detail->>'task_id' in (
            select id::text from tasks where platform like ${`pgtest-act-%${tag}`}
          )
        )
    `;
    await sql()`delete from tasks where platform like ${`pgtest-act-%${tag}`}`;
    await sql()`delete from memory where key like ${`%${tag}%`}`;
    await sql()`delete from idempotency_keys where idempotency_key like ${`%${tag}%`}`;
  }
}

/**
 * report() writes the agent, the session, and the event in one statement.
 * A rejecting events insert leaves both rows as they were. updateTaskForTool
 * still returns the task receipt when the later status report fails.
 */
async function testReportStatusAtomic(tag: string) {
  const agentId = slugify(`${tag}-rpt`);
  // main() already stores a writeback session at `${tag}-sess`. A colliding id
  // would make the rollback count look like a leftover insert.
  const sessionId = `${tag}-rpt-sess`;
  const laneId = slugify(`${tag}-lane`);
  const platform = `pgtest-rpt-${tag}`;
  const install = async () => {
    await sql()`
      create or replace function ak_test_fail_status_event()
      returns trigger
      language plpgsql
      as $fn$
      begin
        if new.kind = 'status' then
          raise exception 'simulated events insert failure';
        end if;
        return new;
      end;
      $fn$
    `;
    await sql()`drop trigger if exists ak_test_fail_status_event on events`;
    await sql()`
      create trigger ak_test_fail_status_event
      before insert on events
      for each row
      execute procedure ak_test_fail_status_event()
    `;
  };
  const drop = async () => {
    await sql()`drop trigger if exists ak_test_fail_status_event on events`;
    await sql()`drop function if exists ak_test_fail_status_event()`;
  };
  try {
    await install();
    await assert.rejects(
      () => report({
        agent_id: agentId,
        platform: "codex",
        machine: "m1",
        display_name: "Should Not Stick",
        session_id: sessionId,
        kind: "status",
        title: "ghost",
        project: "p",
        summary: "ghost summary",
      }),
      (err: unknown) => err instanceof Error && /simulated events insert failure/.test(err.message),
    );
    const newAgents = await sql()`select count(*)::int as n from agents where id = ${agentId}`;
    const newSessions = await sql()`select count(*)::int as n from sessions where id = ${sessionId}`;
    const ghosts = await sql()`select count(*)::int as n from events where kind = 'status' and title = 'ghost'`;
    assert.equal(Number(newAgents[0].n), 0, "a failed event insert leaves no new agent");
    assert.equal(Number(newSessions[0].n), 0, "a failed event insert leaves no new session");
    assert.equal(Number(ghosts[0].n), 0, "a failed event insert leaves no status event");

    await drop();
    const seeded = await report({
      agent_id: agentId,
      platform: "codex",
      display_name: "Kept",
      session_id: sessionId,
      kind: "session_start",
      title: "hello",
      project: "p",
      summary: "kept",
    });
    assert.equal(seeded?.kind, "session_start");
    const beforeAgent = await sql()`select platform, display_name, last_seen_at from agents where id = ${agentId}`;
    const beforeSession = await sql()`select status, summary, project, ended_at from sessions where id = ${sessionId}`;
    assert.equal(beforeAgent.length, 1);
    assert.equal(beforeSession.length, 1);
    await install();
    await assert.rejects(
      () => report({
        agent_id: agentId,
        platform: "hermes",
        display_name: "Changed",
        session_id: sessionId,
        kind: "status",
        status: "failed",
        title: "ghost-update",
        summary: "changed",
      }),
      (err: unknown) => err instanceof Error && /simulated events insert failure/.test(err.message),
    );
    const afterAgent = await sql()`select platform, display_name, last_seen_at from agents where id = ${agentId}`;
    const afterSession = await sql()`select status, summary, project, ended_at from sessions where id = ${sessionId}`;
    assert.equal(String(afterAgent[0].platform), String(beforeAgent[0].platform));
    assert.equal(String(afterAgent[0].display_name), String(beforeAgent[0].display_name));
    assert.equal(new Date(afterAgent[0].last_seen_at as string | Date).toISOString(), new Date(beforeAgent[0].last_seen_at as string | Date).toISOString());
    assert.equal(String(afterSession[0].status), String(beforeSession[0].status));
    assert.equal(String(afterSession[0].summary), String(beforeSession[0].summary));
    assert.equal(String(afterSession[0].project), String(beforeSession[0].project));
    const endedBefore = beforeSession[0].ended_at == null ? null : new Date(beforeSession[0].ended_at as string | Date).toISOString();
    const endedAfter = afterSession[0].ended_at == null ? null : new Date(afterSession[0].ended_at as string | Date).toISOString();
    assert.equal(endedAfter, endedBefore);
    const updates = await sql()`select count(*)::int as n from events where kind = 'status' and title = 'ghost-update'`;
    assert.equal(Number(updates[0].n), 0, "a failed event insert leaves no status event on an existing session");

    const task = await createTask({ title: `secondary ${tag}`, platform });
    const result = await updateTaskForTool({ id: task.id, status: "done", agent_id: `${tag}-lane` });
    assert.equal(result.isError, undefined);
    const text = result.content[0]?.text ?? "";
    assert.match(text, new RegExp(`^Task #${task.id} updated \\(done\\)\\.`));
    assert.match(text, /note: the status event was not recorded/);
    const receiptLine = text.split("\n").at(-1) ?? "";
    assert.match(receiptLine, /^receipt: \{/);
    const receipt = JSON.parse(receiptLine.slice("receipt: ".length)) as { id: string; kind: string };
    assert.equal(receipt.kind, "task_updated");
    const structured = result.structuredContent as { receipt?: { id: string; kind: string } } | undefined;
    assert.equal(structured?.receipt?.id, receipt.id);
    assert.equal(structured?.receipt?.kind, "task_updated");
    const stored = await sql()`select status from tasks where id = ${task.id}`;
    assert.equal(String(stored[0].status), "done");
    const lane = await sql()`select count(*)::int as n from agents where id = ${laneId}`;
    assert.equal(Number(lane[0].n), 0, "a failed secondary report writes no agent");
    const statusEvents = await sql()`
      select count(*)::int as n from events
      where kind = 'status' and detail->>'task_id' = ${String(task.id)}
    `;
    assert.equal(Number(statusEvents[0].n), 0, "a failed secondary report writes no status event");
    const taskEvents = await sql()`
      select id::text as id from events
      where kind = 'task_updated' and detail->>'task_id' = ${String(task.id)}
    `;
    assert.equal(taskEvents.length, 1);
    assert.equal(String(taskEvents[0].id), receipt.id);
  } finally {
    await drop();
    await sql()`delete from tasks where platform = ${platform}`;
    await sql()`delete from events where agent_id in (${agentId}, ${laneId}) or session_id = ${sessionId}`;
    await sql()`delete from sessions where id = ${sessionId}`;
    await sql()`delete from agents where id in (${agentId}, ${laneId})`;
  }
}

async function testDecisions(tag: string) {
  const repo = `pgtest/d${tag.replace(/\W/g, "")}`;
  const key = (n: number) => `github:${repo}#${n}`;
  const opened = "2026-07-21T12:00:00.000Z";
  const body = (n: number, over: Partial<UpsertInput> = {}): UpsertInput => ({
    key: key(n),
    source: "github-label",
    repo,
    repo_short: "app",
    number: n,
    url: `https://github.com/${repo}/issues/${n}`,
    title: `decision ${n}`,
    why: "needs-owner",
    options: null,
    recommended: null,
    requested_by: "owner",
    kind: n === 1 ? "issue" : "pr",
    labels: ["needs-owner"],
    opened_at: opened,
    first_seen_at: n === 2 ? "2026-01-01T00:00:00.000Z" : opened,
    github_present: true,
    force: false,
    ...over,
  });

  await sql()`delete from decisions where repo = ${repo}`;
  try {
    const cols = await sql()`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'decisions'
        and column_name in ('kind', 'labels', 'opened_at', 'repo_short', 'github_present')
    `;
    assert.equal(cols.length, 5, "schema.sql adds the brief columns");

    const first = await upsertDecision(body(1));
    assert.equal(typeof first.decision.id, "number");
    assert.equal(first.status_held, false);
    assert.equal(first.decision.status, "open");
    assert.equal(first.decision.github_present, true);
    assert.deepEqual(first.decision.labels, ["needs-owner"]);
    assert.equal(first.decision.age_days, ageDays(opened, new Date().toISOString()));
    assert.equal(first.decision.requested_by, "owner");

    const decided = await patchDecision(first.decision.id, {
      status: "decided",
      decision: "Ship it",
      setDecision: true,
      decided_by: "mark",
      setDecidedBy: true,
      defer_until: null,
      setDefer: false,
    });
    assert.equal(decided?.status, "decided");
    assert.equal(decided?.decision, "Ship it");
    assert.ok(decided?.decided_at);

    const held = await upsertDecision(body(1, {
      title: "renamed",
      requested_by: "collector",
      opened_at: "2026-10-01T00:00:00.000Z",
      why: "needs-owner, decision",
    }));
    assert.equal(held.status_held, true);
    assert.equal(held.decision.status, "decided");
    assert.equal(held.decision.decision, "Ship it");
    assert.equal(held.decision.title, "renamed");
    assert.equal(held.decision.requested_by, "owner");
    assert.ok(held.decision.opened_at?.startsWith("2026-07-21"));

    const forced = await upsertDecision(body(1, { force: true, title: "reopened" }));
    assert.equal(forced.status_held, false);
    assert.equal(forced.decision.status, "open");
    assert.equal(forced.decision.decision, null);
    assert.equal(forced.decision.decided_by, null);
    assert.equal(forced.decision.decided_at, null);

    const again = await patchDecision(first.decision.id, {
      status: "decided",
      decision: "Ship it",
      setDecision: true,
      decided_by: "mark",
      setDecidedBy: true,
      defer_until: null,
      setDefer: false,
    });
    assert.equal(again?.status, "decided");

    const missing = await upsertDecision(body(2, { title: "will withdraw", kind: "issue" }));
    assert.equal(missing.decision.status, "open");
    const deferred = await upsertDecision(body(3, { title: "due", kind: "issue", first_seen_at: "2026-08-01T00:00:00.000Z" }));
    const parked = await patchDecision(deferred.decision.id, {
      status: "deferred",
      decision: null,
      setDecision: false,
      decided_by: null,
      setDecidedBy: false,
      defer_until: "2020-01-01T00:00:00.000Z",
      setDefer: true,
    });
    assert.equal(parked?.status, "deferred");

    const future = await upsertDecision(body(5, { title: "later", kind: "issue", opened_at: "2026-10-24T00:00:00.000Z" }));
    await patchDecision(future.decision.id, {
      status: "deferred",
      decision: null,
      setDecision: false,
      decided_by: null,
      setDecidedBy: false,
      defer_until: "2099-01-01T00:00:00.000Z",
      setDefer: true,
    });
    const openBefore = await listDecisions({ status: "open", repo, source: "github-label", limit: 100 });
    const openIds = openBefore.map((row) => row.number);
    assert.ok(openIds.includes(2) && openIds.includes(3), "due deferred rows sit in the open queue");
    assert.equal(openIds.includes(1), false, "a decided row is not in the open queue");
    assert.equal(openIds.includes(5), false, "a future deferral stays out of the open queue");

    const forcedDefer = await upsertDecision(body(5, { force: true, title: "later", opened_at: "2026-10-24T00:00:00.000Z" }));
    assert.equal(forcedDefer.decision.status, "open");
    assert.equal(forcedDefer.decision.defer_until, null);

    const briefBefore = toBriefDecisions(
      await listDecisions({ status: "all", repo, source: null, limit: 100 }),
      "2026-10-25T12:00:00Z",
    );
    assert.ok(briefBefore.some((row) => row.number === 1 && row.repo === repo && row.repo_short === "app"));

    const reconciled = await reconcileDecisions({
      repo,
      source: "github-label",
      seen_keys: [key(1), key(5)],
    });
    assert.equal(reconciled.withdrawn, 2, "the missing open row and the due deferred row withdraw");
    assert.ok(reconciled.reconciled >= 2);

    const after = await listDecisions({ status: "all", repo, source: null, limit: 100 });
    const byNumber = new Map(after.map((row) => [row.number, row]));
    assert.equal(byNumber.get(1)?.status, "decided");
    assert.equal(byNumber.get(1)?.github_present, true, "a key the collector still saw stays present");
    assert.equal(byNumber.get(1)?.decision, "Ship it");
    assert.equal(byNumber.get(2)?.status, "withdrawn");
    assert.equal(byNumber.get(2)?.github_present, false);
    assert.equal(byNumber.get(3)?.status, "withdrawn");
    assert.equal(byNumber.get(3)?.defer_until, null);
    assert.equal(byNumber.get(5)?.status, "open");
    assert.equal(byNumber.get(5)?.github_present, true);

    const brief = toBriefDecisions(after, "2026-10-25T12:00:00Z");
    assert.deepEqual(brief.map((row) => row.number), [1, 5], "oldest first, and a decided row still on GitHub stays in the brief");
    assert.ok(brief.every((row) => row.repo === repo && row.repo_short === "app"));
    const listedBrief = await listDecisions({
      status: "open",
      repo,
      source: "agent",
      limit: 100,
      shape: "brief",
    });
    assert.deepEqual(
      listedBrief.map((row) => row.number).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [1, 5],
      "shape=brief keeps a decided row that is still present and ignores status and source",
    );

    const dropped = await reconcileDecisions({ repo, source: "github-label", seen_keys: [key(5)] });
    assert.equal(dropped.withdrawn, 1, "losing the label withdraws a decided row");
    const hidden = (await listDecisions({ status: "all", repo, source: null, limit: 100 })).find((row) => row.number === 1);
    assert.equal(hidden?.status, "withdrawn");
    assert.equal(hidden?.github_present, false);
    assert.equal(hidden?.decision, "Ship it");
    assert.equal(hidden?.decided_by, "mark");
    assert.ok(hidden?.decided_at, "withdrawing a decided row keeps decided_at");
    const briefAfterDrop = toBriefDecisions(
      await listDecisions({ status: "all", repo, source: null, limit: 100 }),
      "2026-10-25T12:00:00Z",
    );
    assert.deepEqual(briefAfterDrop.map((row) => row.number), [5]);
    const listedAfterDrop = await listDecisions({ status: "all", repo, source: null, limit: 100, shape: "brief" });
    assert.deepEqual(listedAfterDrop.map((row) => row.number), [5]);

    const closing = await upsertDecision(body(6, {
      title: "closing",
      kind: "issue",
      opened_at: "2026-09-01T00:00:00.000Z",
    }));
    const closedDecided = await patchDecision(closing.decision.id, {
      status: "decided",
      decision: "Close it",
      setDecision: true,
      decided_by: "mark",
      setDecidedBy: true,
      defer_until: null,
      setDefer: false,
    });
    assert.equal(closedDecided?.status, "decided");
    assert.equal(closedDecided?.decision, "Close it");
    const closedSweep = await reconcileDecisions({ repo, source: "github-label", seen_keys: [key(5)] });
    assert.equal(closedSweep.withdrawn, 1, "a decided row whose issue closed is withdrawn");
    const closedRow = (await listDecisions({ status: "all", repo, source: null, limit: 100 })).find((row) => row.number === 6);
    assert.equal(closedRow?.status, "withdrawn");
    assert.equal(closedRow?.github_present, false);
    assert.equal(closedRow?.decision, "Close it");
    assert.equal(closedRow?.decided_by, "mark");
    assert.ok(closedRow?.decided_at);
    const stillHidden = (await listDecisions({ status: "all", repo, source: null, limit: 100 })).find((row) => row.number === 1);
    assert.equal(stillHidden?.status, "withdrawn");
    assert.equal(stillHidden?.decision, "Ship it");
    assert.equal(stillHidden?.decided_by, "mark");

    const back = await upsertDecision(body(2, { title: "label returned", requested_by: "collector" }));
    assert.equal(back.decision.status, "open");
    assert.equal(back.decision.github_present, true);
    assert.equal(back.status_held, false);

    const empty = await reconcileDecisions({ repo, source: "github-label", seen_keys: [] });
    assert.ok(empty.withdrawn >= 1, "an empty sweep withdraws the open rows");
    const decidedLeft = await listDecisions({ status: "decided", repo, source: null, limit: 100 });
    assert.equal(decidedLeft.length, 0, "a closed or unlabeled decided row is no longer decided");
    const answers = await listDecisions({ status: "withdrawn", repo, source: null, limit: 100 });
    const ship = answers.find((row) => row.number === 1);
    const close = answers.find((row) => row.number === 6);
    assert.equal(ship?.decision, "Ship it");
    assert.equal(ship?.decided_by, "mark");
    assert.equal(ship?.github_present, false);
    assert.equal(close?.decision, "Close it");
    assert.equal(close?.decided_by, "mark");

    const cleared = await patchDecision(first.decision.id, {
      status: "open",
      decision: null,
      setDecision: false,
      decided_by: null,
      setDecidedBy: false,
      defer_until: null,
      setDefer: false,
    });
    assert.equal(cleared?.status, "open");
    assert.equal(cleared?.decision, null);
    assert.equal(cleared?.decided_at, null);

    await sql()`
      insert into decisions (key, source, repo, repo_short, number, title, status, kind, labels, opened_at, first_seen_at, github_present)
      values (${key(9)}, 'github-label', ${repo}, 'app', 9, 'pre-column', 'open', 'issue', ${JSON.stringify(["needs-owner"])}::jsonb, ${"2026-10-23T00:00:00.000Z"}, ${"2026-10-23T00:00:00.000Z"}, null)
    `;
    const withNull = toBriefDecisions(
      await listDecisions({ status: "all", repo, source: null, limit: 100 }),
      "2026-10-25T12:00:00Z",
    );
    assert.ok(withNull.some((row) => row.number === 9), "a null github_present still shows in the brief");

    const seenAt = "2026-10-25T00:00:00.000Z";
    const createdAt = "2026-07-21T12:00:00.000Z";
    await sql()`
      insert into decisions (key, source, repo, number, title, url, status, first_seen_at)
      values (${key(20)}, 'github-label', ${repo}, 20, 'legacy pr', ${"https://github.com/" + repo + "/pull/20"}, 'open', ${seenAt})
    `;
    const legacyRows = await listDecisions({ status: "all", repo, source: null, limit: 100, shape: "brief" });
    const legacy = legacyRows.find((row) => row.number === 20);
    assert.equal(legacy?.kind, null);
    assert.equal(legacy?.labels, null);
    assert.equal(legacy?.opened_at, null);
    assert.equal(legacy?.repo_short, null);
    const beforeFill = partitionBrief(legacyRows, "2026-10-25T12:00:00Z");
    assert.equal(beforeFill.decisions.some((row) => row.number === 20), false, "a legacy null row is not a brief decision");
    assert.ok(beforeFill.incomplete_repos.includes(repo), "the repo stays on the GitHub sweep");
    assert.equal(
      beforeFill.decisions.some((row) => row.kind === "issue" && row.labels.length === 0 && row.repo_short === repo.split("/")[1]),
      false,
    );

    const filled = await upsertDecision(body(20, {
      title: "legacy pr",
      kind: "pr",
      labels: ["needs-owner"],
      opened_at: createdAt,
      repo_short: "app",
      url: `https://github.com/${repo}/pull/20`,
    }));
    assert.equal(filled.decision.kind, "pr");
    assert.deepEqual(filled.decision.labels, ["needs-owner"]);
    assert.ok(filled.decision.opened_at?.startsWith("2026-07-21"));
    assert.equal(filled.decision.repo_short, "app");
    assert.ok(filled.decision.first_seen_at.startsWith("2026-10-25"), "backfill does not move first_seen_at");
    const afterFill = partitionBrief(
      await listDecisions({ status: "all", repo, source: null, limit: 100, shape: "brief" }),
      "2026-10-25T12:00:00Z",
    );
    const shown = afterFill.decisions.find((row) => row.number === 20);
    assert.equal(shown?.kind, "pr");
    assert.deepEqual(shown?.labels, ["needs-owner"]);
    assert.equal(shown?.age_days, ageDays(createdAt, "2026-10-25T12:00:00Z"));
    assert.equal(shown?.repo_short, "app");
    assert.equal(afterFill.incomplete_repos.includes(repo), false);
  } finally {
    await sql()`delete from decisions where repo = ${repo}`;
  }
}

/** The scheduler against real tasks and idempotency_keys rows. Only this skill's rows are touched. */
async function testSkillSchedule(tag: string): Promise<void> {
  const skillId = `sched-${tag}`.replace(/[^a-z0-9-]/gi, "").slice(0, 48);
  const title = `Run scheduled skill ${skillId}`;
  const cleanup = async () => {
    await sql()`delete from tasks where title = ${title}`;
    await sql()`delete from idempotency_keys where idempotency_key like ${`skill-schedule:${skillId}:%`}`;
    await sql()`delete from skill_settings where skill_id = ${skillId}`;
    await sql()`delete from skills where id = ${skillId}`;
  };
  await cleanup();
  try {
    const seeded = skillRecord(skillId, "scheduled body");
    await sql()`
      insert into skills (
        id, source_id, path, name, description, version, sha, commit_sha, body,
        "references", runtimes, frontmatter, category, tags, removed_at, synced_at
      ) values (
        ${skillId}, 'master-skills', ${seeded.path}, ${skillId}, 'scheduled', '1.0.0',
        ${seeded.sha}, ${seeded.commit_sha}, ${seeded.body},
        '[]'::jsonb, ${JSON.stringify(seeded.runtimes)}::jsonb, '{}'::jsonb, null, '[]'::jsonb, null, now()
      )
    `;
    await upsertSettings({
      skill_id: skillId,
      trigger: "scheduled",
      scope: { mode: "all", lanes: [] },
      schedule: "*/5 * * * *",
      updated_by: null,
      updated_at: "2026-10-27T12:00:00.000Z",
    });
    const mine = (r: TickResult) => r.items.filter((i) => i.skill_id === skillId);

    const first = await runScheduleTick({ now: new Date("2026-10-27T12:10:30Z") });
    const queued = mine(first);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].outcome, "queued");
    const rows = await sql()`select platform, status, actor_type, actor_id, created_by, description from tasks where title = ${title}`;
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].platform), "claude-code", "one compatible runtime pins the platform");
    assert.equal(String(rows[0].actor_id), "skill-scheduler");
    assert.match(String(rows[0].description), /Scheduled slot: 2026-10-27T12:10Z/);

    const again = mine(await runScheduleTick({ now: new Date("2026-10-27T12:10:50Z") }));
    assert.deepEqual(again.map((i) => [i.outcome, i.reason]), [["skipped", "already_scheduled"]]);

    const blocked = mine(await runScheduleTick({ now: new Date("2026-10-27T12:15:00Z") }));
    assert.deepEqual(blocked.map((i) => i.reason), ["previous_open"]);
    assert.equal((await listOpenScheduledTasks()).filter((t) => t.skill_id === skillId).length, 1);

    await sql()`update tasks set status = 'done' where title = ${title}`;
    const next = mine(await runScheduleTick({ now: new Date("2026-10-27T12:20:00Z") }));
    assert.equal(next[0].outcome, "queued");
    assert.equal(next[0].missed, 1, "the 12:15 tick was skipped while the task was open");
    const last = (await listLastScheduledTasks()).filter((t) => t.skill_id === skillId);
    assert.equal(last.length, 1);
    assert.match(last[0].description, /Scheduled slot: 2026-10-27T12:20Z/);

    // The index, not the tick's read, is what stops two open tasks for one skill.
    await sql()`update tasks set status = 'done' where title = ${title}`;
    await sql()`insert into tasks (title, actor_type, actor_id, status) values (${title}, 'agent', 'skill-scheduler', 'queued')`;
    await assert.rejects(
      sql()`insert into tasks (title, actor_type, actor_id, status) values (${title}, 'agent', 'skill-scheduler', 'running')`,
      /tasks_skill_schedule_one_open_idx/,
    );

    // A task an agent creates with the same title and created_by does not count: the actor differs.
    await sql()`delete from tasks where title = ${title}`;
    await sql()`insert into tasks (title, created_by, actor_type, actor_id) values (${title}, 'skill-scheduler', 'agent', 'someone-else')`;
    const spoof = mine(await runScheduleTick({ now: new Date("2026-10-27T12:25:00Z") }));
    assert.equal(spoof[0].outcome, "queued");
  } finally {
    await cleanup();
  }
}

/**
 * Two connections. The holder locks the lease row the way beginSyncRun's
 * expiry UPDATE does, and commits status failed only after the sync write
 * is waiting. READ COMMITTED must then re-check status and write nothing.
 * A missing `for share` / `for update` lets the write finish on the old
 * snapshot while the holder still has the row locked.
 */
async function testSkillLeaseFence(tag: string): Promise<void> {
  const skillId = `lease-${tag}`.replace(/[^a-z0-9-]/gi, "").slice(0, 48);
  const runId = randomUUID();
  const stolen = skillRecord(skillId, "stolen");
  await sql()`
    insert into skills (
      id, source_id, path, name, description, version, sha, commit_sha, body,
      "references", runtimes, frontmatter, category, tags, removed_at, synced_at
    ) values (
      ${skillId}, 'master-skills', ${stolen.path}, ${skillId}, 'lease fence', '1.0.0',
      ${stolen.sha}, ${stolen.commit_sha}, 'original',
      '[]'::jsonb, ${JSON.stringify(stolen.runtimes)}::jsonb, '{}'::jsonb, null, '[]'::jsonb, null, now()
    )
  `;
  await sql()`
    insert into skill_sync_runs (id, started_at, finished_at, trigger, status, summary, error)
    values (${runId}::uuid, now() - interval '11 minutes', null, 'manual', 'running', null, null)
  `;
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    await assert.rejects(
      () => holdExpiredLease(holder, runId, "sk:upsert-skill", () => upsertSkill(stolen, runId)),
      (err: unknown) => err instanceof SyncLeaseLost,
    );
    const afterUpsert = await sql()`select body, removed_at from skills where id = ${skillId}`;
    assert.equal(String(afterUpsert[0].body), "original", "a fenced upsert must not overwrite the skill");
    assert.equal(afterUpsert[0].removed_at, null);

    await reviveLease(runId);
    await assert.rejects(
      () => holdExpiredLease(holder, runId, "sk:remove-skill", () => markSkillRemoved(skillId, "2026-10-27T12:11:00.000Z", runId)),
      (err: unknown) => err instanceof SyncLeaseLost,
    );
    const afterRemove = await sql()`select removed_at from skills where id = ${skillId}`;
    assert.equal(afterRemove[0].removed_at, null, "a fenced removal must not mark the skill removed");

    await reviveLease(runId);
    const closed = await holdExpiredLease(holder, runId, "sk:finish-sync", () => finishSyncRun({
      id: runId,
      status: "ok",
      summary: { sources: [] },
      error: null,
      finishedAt: "2026-10-27T12:11:00.000Z",
    }));
    assert.equal(closed, false, "a fenced finish must not close a lease it no longer owns");
    const run = await sql()`select status, error from skill_sync_runs where id = ${runId}::uuid`;
    assert.equal(String(run[0].status), "failed");
    assert.equal(String(run[0].error), "sync lease expired");
  } finally {
    await holder.query("rollback").catch(() => undefined);
    await holder.end();
    await sql()`delete from skills where id = ${skillId}`;
    await sql()`delete from skill_sync_runs where id = ${runId}::uuid`;
  }
}

function skillRecord(id: string, body: string): SkillRecord {
  return {
    id,
    source_id: "master-skills",
    path: `skills/${id}/SKILL.md`,
    name: id,
    description: "lease fence",
    version: "1.0.0",
    sha: "a".repeat(64),
    commit_sha: "b".repeat(40),
    body,
    references: [],
    runtimes: { claude: true, codex: false, grok: false, hermes: false, mini: false, nemoclaw: false },
    category: null,
    tags: [],
    frontmatter: {},
    removed_at: null,
    synced_at: "2026-10-27T12:00:00.000Z",
  };
}

async function reviveLease(runId: string): Promise<void> {
  await sql()`
    update skill_sync_runs
    set status = 'running', finished_at = null, error = null
    where id = ${runId}::uuid
  `;
}

async function holdExpiredLease<T>(holder: Client, runId: string, marker: string, start: () => Promise<T>): Promise<T> {
  await holder.query("begin");
  let pending: Promise<T> | null = null;
  try {
    const locked = await holder.query(
      "update skill_sync_runs set error = 'holding' where id = $1 and status = 'running' returning id",
      [runId],
    );
    assert.equal(locked.rowCount, 1, "the holder must lock the running lease");
    let settled = false;
    pending = start().finally(() => {
      settled = true;
    });
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline && !settled) {
      const rows = await sql()`
        select pid
        from pg_stat_activity
        where wait_event_type = 'Lock'
          and query like ${`%${marker}%`}
      `;
      if (rows.length > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(settled, false, `${marker} finished while the expiry update still held the lease row`);
    assert.equal(waiting, true, `${marker} did not wait on the lease row lock`);
    await holder.query(
      "update skill_sync_runs set status = 'failed', finished_at = now(), error = 'sync lease expired' where id = $1",
      [runId],
    );
    await holder.query("commit");
    return await pending;
  } catch (err) {
    await holder.query("rollback").catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
    throw err;
  }
}

function pgCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function applyCanonicalSchema(): Promise<void> {
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "schema.sql");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(fs.readFileSync(schemaPath, "utf8"));
  } finally {
    await client.end();
  }
}

async function restoreWatchBeatsName(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      do $$ begin
        if to_regclass('public.watch_beats_hidden') is not null
           and to_regclass('public.watch_beats') is null then
          alter table watch_beats_hidden rename to watch_beats;
        end if;
      end $$
    `);
  } finally {
    await client.end();
  }
}

function beatFor(rows: WatchBeat[], source: string): WatchBeat {
  const found = rows.find((row) => row.source === source);
  assert.ok(found, `missing beat ${source}`);
  return found;
}

/**
 * Failure cases for watch_beats: constraint rejects, clock skew, a second
 * write refreshing received_at, concurrent same-source upserts, a failed
 * read, a missing DATABASE_URL, and a second schema apply that must not
 * rewrite a stored beat.
 */
async function testWatchBeats(tag: string): Promise<void> {
  await sql()`delete from watch_beats`;
  const previousUrl = process.env.DATABASE_URL;
  try {
    const encoding = await sql()`show server_encoding`;
    assert.equal(String(encoding[0].server_encoding).toUpperCase(), "UTF8");

    const cols = await sql()`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'watch_beats'
      order by ordinal_position
    `;
    assert.deepEqual(
      cols.map((col) => [col.column_name, col.data_type, col.is_nullable]),
      [
        ["source", "text", "NO"],
        ["status", "text", "NO"],
        ["detail", "text", "NO"],
        ["beat_at", "timestamp with time zone", "NO"],
        ["received_at", "timestamp with time zone", "NO"],
      ],
    );

    assert.deepEqual(await readBeats(), [], "an empty table is not a fabricated healthy beat");

    const behind = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const ahead = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const skew = `${tag}-skew`;
    await upsertBeat(skew, "ok", "sender behind", behind);
    let row = beatFor(await readBeats(), skew);
    assert.equal(row.beat_at, behind);
    assert.match(row.beat_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(row.received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(Number.isInteger(row.age_s), true);
    assert.ok(row.age_s >= 0 && row.age_s < 30, `age follows received_at, got ${row.age_s}`);
    assert.deepEqual(Object.keys(row), ["source", "status", "detail", "beat_at", "received_at", "age_s"]);

    await upsertBeat(skew, "failing", "sender ahead", ahead);
    row = beatFor(await readBeats(), skew);
    assert.equal(row.status, "failing", "a future beat_at is still accepted");
    assert.equal(row.detail, "sender ahead");
    assert.equal(row.beat_at, ahead);
    assert.ok(row.age_s < 30, `a future beat_at must not zero the age by itself, got ${row.age_s}`);

    // An older sender instant still overwrites. beat_at is not a version.
    await upsertBeat(skew, "paused", "older sender wins", behind);
    row = beatFor(await readBeats(), skew);
    assert.equal(row.status, "paused");
    assert.equal(row.detail, "older sender wins");
    assert.equal(row.beat_at, behind);

    await sql()`update watch_beats set received_at = clock_timestamp() - interval '2 days' where source = ${skew}`;
    const rewound = beatFor(await readBeats(), skew);
    assert.ok(rewound.age_s >= 2 * 86400 - 5, `rewound age should be about two days, got ${rewound.age_s}`);
    await upsertBeat(skew, "held", "refreshed", behind);
    row = beatFor(await readBeats(), skew);
    assert.equal(row.status, "held");
    assert.equal(row.detail, "refreshed");
    assert.ok(row.age_s < 30, `the conflict update must stamp received_at again, got ${row.age_s}`);

    await sql()`update watch_beats set received_at = clock_timestamp() + interval '2 days' where source = ${skew}`;
    assert.equal(beatFor(await readBeats(), skew).age_s, 0, "age_s floors at zero when received_at is ahead of the database clock");

    const micros = `${tag}-micros`;
    await upsertBeat(micros, "unknown", "", "2026-10-26T12:00:00.123456Z");
    const storedUs = await sql()`
      select to_char(beat_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as beat
      from watch_beats where source = ${micros}
    `;
    assert.equal(String(storedUs[0].beat), "2026-10-26T12:00:00.123456Z");
    const offset = `${tag}-offset`;
    await upsertBeat(offset, "ok", "", "2026-10-26T12:00:00-05:00");
    assert.equal(beatFor(await readBeats(), offset).beat_at, "2026-10-26T17:00:00.000Z");

    const emoji = "😀".repeat(500);
    const wide = `${tag}-wide`;
    await upsertBeat(wide, "stale", emoji, "2026-10-28T00:00:00Z");
    assert.equal(beatFor(await readBeats(), wide).detail, emoji);
    await upsertBeat(`${tag}-empty-detail`, "ok", "", "2026-10-28T00:00:00Z");

    const hostile = `${tag}-'); drop table watch_beats; --`;
    await upsertBeat(hostile, "ok", "still here", "2026-10-28T00:00:00Z");
    assert.equal(beatFor(await readBeats(), hostile).detail, "still here");
    const stillThere = await sql()`select to_regclass('public.watch_beats') as rel`;
    assert.equal(stillThere[0].rel, "watch_beats");

    const sources = [`${tag}-c`, `${tag}-a`, `${tag}-b`];
    for (const source of sources) await upsertBeat(source, "ok", source, "2026-10-28T00:00:00Z");
    const ordered = (await readBeats()).map((item) => item.source).filter((source) => sources.includes(source));
    assert.deepEqual(ordered, [...sources].sort(), "readBeats orders by source");
    const distinct = await sql()`select count(*)::int as n from watch_beats where source like ${`${tag}-%`}`;
    assert.ok(Number(distinct[0].n) >= sources.length);

    const race = `${tag}-race`;
    await Promise.all(Array.from({ length: 12 }, (_, i) => upsertBeat(
      race,
      WATCH_STATUSES[i % WATCH_STATUSES.length],
      `n${i}`,
      new Date(Date.now() - i * 1000).toISOString(),
    )));
    const raceCount = await sql()`select count(*)::int as n from watch_beats where source = ${race}`;
    assert.equal(Number(raceCount[0].n), 1, "concurrent same-source writes leave one row");

    const same = `${tag}-same`;
    await upsertBeat(same, "ok", "one", "2026-10-28T00:00:00Z");
    await upsertBeat(same, "unknown", "two", "2026-10-28T00:00:01Z");
    const sameCount = await sql()`select count(*)::int as n, max(detail) as detail from watch_beats where source = ${same}`;
    assert.equal(Number(sameCount[0].n), 1);
    assert.equal(String(sameCount[0].detail), "two");
    await upsertBeat(`${tag}-other`, "held", "separate", "2026-10-28T00:00:00Z");
    const pair = await sql()`select count(*)::int as n from watch_beats where source in (${same}, ${`${tag}-other`})`;
    assert.equal(Number(pair[0].n), 2, "different sources stay separate");

    const kept = `${tag}-kept`;
    await upsertBeat(kept, "ok", "do not touch", "2026-10-27T01:02:03Z");
    const before = await sql()`
      select status, detail,
             extract(epoch from beat_at) as beat_epoch,
             extract(epoch from received_at) as received_epoch
      from watch_beats where source = ${kept}
    `;
    await applyCanonicalSchema();
    await applyCanonicalSchema();
    const after = await sql()`
      select status, detail,
             extract(epoch from beat_at) as beat_epoch,
             extract(epoch from received_at) as received_epoch
      from watch_beats where source = ${kept}
    `;
    assert.deepEqual(after, before, "applying the canonical schema twice leaves the beat unchanged");

    const badSource = `${tag}-bad`;
    await assert.rejects(
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values ('', 'ok', '', now(), now())`,
      (err: unknown) => pgCode(err) === "23514",
      "empty source",
    );
    await assert.rejects(
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (${badSource}, 'nope', '', now(), now())`,
      (err: unknown) => pgCode(err) === "23514",
      "invalid status",
    );
    await assert.rejects(
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (${badSource}, 'OK', '', now(), now())`,
      (err: unknown) => pgCode(err) === "23514",
      "status is case-sensitive",
    );
    await assert.rejects(
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (${badSource}, 'ok', ${"a".repeat(501)}, now(), now())`,
      (err: unknown) => pgCode(err) === "23514",
      "501 code points",
    );
    await assert.rejects(
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (${badSource}, 'ok', ${"😀".repeat(501)}, now(), now())`,
      (err: unknown) => pgCode(err) === "23514",
      "501 emoji code points",
    );
    const nullWrites = [
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (null, 'ok', '', now(), now())`,
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (${badSource}, null, '', now(), now())`,
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (${badSource}, 'ok', null, now(), now())`,
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (${badSource}, 'ok', '', null, now())`,
      () => sql()`insert into watch_beats (source, status, detail, beat_at, received_at) values (${badSource}, 'ok', '', now(), null)`,
    ];
    for (const write of nullWrites) {
      await assert.rejects(write, (err: unknown) => pgCode(err) === "23502");
    }
    const badLeft = await sql()`select count(*)::int as n from watch_beats where source = ${badSource} or source = ''`;
    assert.equal(Number(badLeft[0].n), 0, "rejected rows are not stored");

    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query("alter table watch_beats rename to watch_beats_hidden");
      await assert.rejects(readBeats, (err: unknown) => pgCode(err) === "42P01");
      await assert.rejects(
        () => upsertBeat("missing-table", "ok", "", "2026-10-28T00:00:00Z"),
        (err: unknown) => pgCode(err) === "42P01",
      );
    } finally {
      await admin.query("alter table if exists watch_beats_hidden rename to watch_beats");
      await admin.end();
    }

    delete process.env.DATABASE_URL;
    try {
      await assert.rejects(readBeats, /DATABASE_URL is not set/);
      await assert.rejects(
        () => upsertBeat("unconfigured", "ok", "", new Date()),
        /DATABASE_URL is not set/,
      );
    } finally {
      process.env.DATABASE_URL = previousUrl;
    }
  } finally {
    if (process.env.DATABASE_URL !== previousUrl) process.env.DATABASE_URL = previousUrl;
    await restoreWatchBeatsName();
    await sql()`delete from watch_beats`;
  }
}

/**
 * Persisted round trip through the watch routes. Rejected writes leave the
 * stored row unchanged. age_s follows received_at, not an old or future beat_at.
 */
async function testWatchBeatRoute(tag: string): Promise<void> {
  const { POST } = await import("../src/app/api/watch/beat/route");
  const { GET } = await import("../src/app/api/watch/beats/route");
  const { createCredential } = await import("../src/lib/credentials");
  const savedBinding = process.env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
  const ids: string[] = [];

  async function stored(source: string) {
    const rows = await sql()`
      select status, detail, beat_at::text as beat_at, received_at::text as received_at
      from watch_beats where source = ${source}
    `;
    return rows[0] ?? null;
  }

  try {
    await sql()`delete from watch_beats where source in ('mini', 'macbook', 'watcher')`;
    const mini = await createCredential({ label: `${tag} mini`, scopes: ["watch:write", "watch:read"] });
    const mac = await createCredential({ label: `${tag} mac`, scopes: ["watch:write"] });
    assert.equal(mini.ok, true);
    assert.equal(mac.ok, true);
    if (!mini.ok || !mac.ok) return;
    ids.push(mini.credential.id, mac.credential.id);
    process.env.WATCH_SOURCE_CREDENTIAL_IDS_JSON = JSON.stringify({
      mini: [mini.credential.id],
      macbook: [mac.credential.id],
    });

    const oldBeat = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const futureBeat = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const post = (token: string, body: unknown, extra: Record<string, string> = {}) => POST(new Request("http://localhost/api/watch/beat", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    }));

    const wrote = await post(mini.token, {
      source: "mini",
      status: "ok",
      detail: "scheduler healthy",
      beat_at: oldBeat,
    });
    assert.equal(wrote.status, 200);
    assert.deepEqual(await wrote.json(), { ok: true });

    const listed = await GET(new Request("http://localhost/api/watch/beats", {
      headers: { authorization: `Bearer ${mini.token}` },
    }));
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    const body = await listed.json() as { beats: { source: string; beat_at: string; received_at: string; age_s: number; detail: string }[] };
    const row = body.beats.find((beat) => beat.source === "mini");
    assert.ok(row);
    assert.equal(Date.parse(row.beat_at), Date.parse(oldBeat));
    assert.equal(row.detail, "scheduler healthy");
    assert.equal(typeof row.age_s, "number");
    assert.ok(row.age_s >= 0 && row.age_s < 60);
    assert.ok(Math.abs(Date.now() - Date.parse(row.received_at)) < 60_000);

    const before = await stored("mini");
    const rejected: unknown[] = [
      { source: "macbook", status: "failing", detail: "wrong host", beat_at: futureBeat },
      { source: "watcher", status: "failing", detail: "wrong host", beat_at: futureBeat },
      { source: "mini", status: "ok", detail: "bad clock", beat_at: "2026-10-27T12:00:00" },
      { source: "mini", status: "ok", detail: "client clock", beat_at: oldBeat, received_at: oldBeat },
      { source: "mini", status: "ok", detail: "client age", beat_at: oldBeat, age_s: 1 },
    ];
    for (const payload of rejected) {
      const res = await post(mini.token, payload);
      assert.ok(res.status === 400 || res.status === 403, `expected 400 or 403, got ${res.status}`);
      assert.deepEqual(await stored("mini"), before);
    }

    const bound = process.env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
    for (const raw of ["{}", JSON.stringify({ mini: [] }), JSON.stringify({ mini: [], macbook: [] })]) {
      process.env.WATCH_SOURCE_CREDENTIAL_IDS_JSON = raw;
      const res = await post(mini.token, {
        source: "mini",
        status: "failing",
        detail: "empty binding must not land",
        beat_at: futureBeat,
      });
      assert.equal(res.status, 503, raw);
      assert.deepEqual(await stored("mini"), before);
    }
    for (const contentType of [
      "application/json, text/plain",
      "application/json+x",
      "application/jsonx",
      "text/json",
      "",
    ]) {
      const res = await post(mini.token, {
        source: "mini",
        status: "failing",
        detail: "bad content type must not land",
        beat_at: futureBeat,
      }, { "content-type": contentType });
      assert.equal(res.status, 415, JSON.stringify(contentType));
      assert.deepEqual(await stored("mini"), before);
    }
    const missingType = await POST(new Request("http://localhost/api/watch/beat", {
      method: "POST",
      headers: { authorization: `Bearer ${mini.token}` },
      body: JSON.stringify({
        source: "mini",
        status: "failing",
        detail: "missing content type must not land",
        beat_at: futureBeat,
      }),
    }));
    assert.equal(missingType.status, 415);
    assert.deepEqual(await stored("mini"), before);
    process.env.WATCH_SOURCE_CREDENTIAL_IDS_JSON = bound;

    const ahead = await post(mini.token, {
      source: "mini",
      status: "held",
      detail: "sender ahead",
      beat_at: futureBeat,
    });
    assert.equal(ahead.status, 200);
    const again = await GET(new Request("http://localhost/api/watch/beats", {
      headers: { authorization: `Bearer ${mini.token}` },
    }));
    const fresh = (await again.json() as { beats: { source: string; beat_at: string; age_s: number; status: string }[] })
      .beats.find((beat) => beat.source === "mini");
    assert.ok(fresh);
    assert.equal(fresh.status, "held");
    assert.equal(Date.parse(fresh.beat_at), Date.parse(futureBeat));
    assert.ok(fresh.age_s >= 0 && fresh.age_s < 60);
  } finally {
    if (savedBinding === undefined) delete process.env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
    else process.env.WATCH_SOURCE_CREDENTIAL_IDS_JSON = savedBinding;
    if (ids.length > 0) {
      await sql()`delete from agent_credentials where id in (${ids[0]}, ${ids[1] ?? ids[0]})`;
    }
    await sql()`delete from watch_beats where source in ('mini', 'macbook', 'watcher')`;
  }
}

/**
 * Keyset pages on Postgres. An insert ahead of the cursor must not repeat or
 * skip a row, and two timestamps that differ only after the millisecond still
 * page in id order.
 */
async function testListCursors(tag: string): Promise<void> {
  const probe = `${tag}-cursor`;
  const agent = `${tag}-cursor`;
  await sql()`delete from tasks where status = 'cursorprobe' and title like ${probe + "%"}`;
  await sql()`delete from memory where key like ${probe + "%"}`;
  await sql()`delete from spans where agent_id = ${agent}`;
  try {
    const taskId = async (name: string, at: string) => {
      const rows = await sql()`
        insert into tasks (title, status, priority, platform, updated_at)
        values (${`${probe}-${name}`}, 'cursorprobe', 2, 'any', ${at}::timestamptz)
        returning id::text as id
      `;
      return String(rows[0].id);
    };
    const a = await taskId("a", "2026-10-28 12:00:00.200000+00");
    const b = await taskId("b", "2026-10-28 12:00:00.123456+00");
    const c = await taskId("c", "2026-10-28 12:00:00.123789+00");
    const d = await taskId("d", "2026-10-28 12:00:00.100000+00");
    const seen: string[] = [];
    let cursor: ReturnType<typeof taskKeyset> | null = null;
    let planted = false;
    let tie: string | null = null;
    for (let n = 0; n < 8; n++) {
      const batch = await listTasks({ status: "cursorprobe", limit: 2, keyset: true, cursor });
      for (const row of batch) assert.equal("list_sort_at" in row, false);
      const page = splitPage(batch as never, parseToolList(TASK_REST, { limit: 1 }));
      assert.equal(page.rows.length > 0, true, "a cursorprobe page must not be empty before the end");
      seen.push(String(page.rows[0].id));
      if (tie === null && n === 1) tie = page.next_cursor;
      if (!page.next_cursor) break;
      if (!planted) {
        await taskId("e", "2026-10-28 12:00:00.900000+00");
        planted = true;
      } else if (tie && page.next_cursor) {
        const firstTie = decodeCursor(TASK_REST, tie);
        const nextTie = decodeCursor(TASK_REST, page.next_cursor);
        if (String(firstTie.k[2]) === String(nextTie.k[2])) {
          assert.equal(String(nextTie.k[2]).endsWith(".123Z"), true, "microseconds collapse to the same millisecond");
        }
      }
      cursor = taskKeyset(decodeCursor(TASK_REST, page.next_cursor));
    }
    assert.deepEqual(seen, [a, b, c, d], "keyset returns each original task once after a newer insert");
    const bCursor = decodeCursor(TASK_REST, tie as string);
    assert.equal(String(bCursor.k[2]), "2026-10-28T12:00:00.123Z");

    const noteId = async (name: string, at: string) => {
      const rows = await sql()`
        insert into memory (key, content, tags, updated_at)
        values (${`${probe}-${name}`}, ${name}, ${[probe]}::text[], ${at}::timestamptz)
        returning id::text as id
      `;
      return String(rows[0].id);
    };
    const newer = await noteId("newer", "2026-10-28 13:00:00.500000+00");
    const low = await noteId("low", "2026-10-28 13:00:00.123111+00");
    const high = await noteId("high", "2026-10-28 13:00:00.123999+00");
    const notes: string[] = [];
    let memoryCursor: ReturnType<typeof memoryKeyset> | null = null;
    let memoryPlanted = false;
    let memoryTie: string | null = null;
    for (let n = 0; n < 8; n++) {
      const batch = await recall({ tags: [probe], limit: 2, keyset: true, cursor: memoryCursor });
      for (const row of batch) assert.equal("list_sort_at" in row, false);
      const page = splitPage(batch as never, parseToolList(MEMORY_REST, { limit: 1 }));
      if (page.rows.length === 0) break;
      notes.push(String(page.rows[0].id));
      if (n === 1) memoryTie = page.next_cursor;
      if (!page.next_cursor) break;
      if (!memoryPlanted) {
        await noteId("front", "2026-10-28 13:00:01.000000+00");
        memoryPlanted = true;
      }
      memoryCursor = memoryKeyset(decodeCursor(MEMORY_REST, page.next_cursor));
    }
    assert.deepEqual(notes, [newer, low, high], "keyset returns each original note once");
    assert.equal(String(decodeCursor(MEMORY_REST, memoryTie as string).k[0]), "2026-10-28T13:00:00.123Z");

    const hex = (ch: string) => ch.repeat(32);
    const span = (trace: string, at: string): SpanInput => ({
      trace_id: trace,
      span_id: "0000000000000001",
      parent_span_id: null,
      agent_id: agent,
      session_id: null,
      name: "session",
      kind: "session",
      status: "ok",
      status_message: null,
      started_at: at,
      ended_at: at,
      attributes: {},
      model: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
    });
    const traceC = hex("c");
    const traceA = hex("a");
    const traceB = hex("b");
    await upsertSpans([span(traceC, "2026-10-28T16:00:00.000000Z")]);
    await upsertSpans([span(traceA, "2026-10-28T15:00:00.123456Z")]);
    await upsertSpans([span(traceB, "2026-10-28T15:00:00.123999Z")]);
    const traces: string[] = [];
    let traceCursor: ReturnType<typeof traceKeyset> | null = null;
    let tracePlanted = false;
    let traceTie: string | null = null;
    for (let n = 0; n < 8; n++) {
      const batch = await listTraces({ agent, limit: 2, keyset: true, cursor: traceCursor });
      const page = splitPage(batch as never, parseToolList(TRACE_LIST, { limit: 1 }));
      if (page.rows.length === 0) break;
      traces.push(String(page.rows[0].trace_id));
      assert.equal("list_sort_at" in page.rows[0], false);
      if (n === 1) traceTie = page.next_cursor;
      if (!page.next_cursor) break;
      if (!tracePlanted) {
        await upsertSpans([span(hex("d"), "2026-10-28T17:00:00.000000Z")]);
        tracePlanted = true;
      }
      traceCursor = traceKeyset(decodeCursor(TRACE_LIST, page.next_cursor));
    }
    assert.deepEqual(traces, [traceC, traceA, traceB], "keyset returns each original trace once, trace_id ascending on a tie");
    assert.equal(String(decodeCursor(TRACE_LIST, traceTie as string).k[0]), "2026-10-28T15:00:00.123Z");
  } finally {
    await sql()`delete from tasks where status = 'cursorprobe' and title like ${probe + "%"}`;
    await sql()`delete from memory where key like ${probe + "%"}`;
    await sql()`delete from spans where agent_id = ${agent}`;
  }
}

/** Real claim SQL: one message per alert, a 12h repeat, and a migration that applies twice. */
async function testBriefAlerts(tag: string): Promise<void> {
  const slug = tag.replace(/\W/g, "").slice(-18);
  const agentId = `alerta${slug}`;
  const repo = `pgtest/z${slug}`;
  const now = new Date("2026-10-28T12:00:00.000Z");
  const hour = 3_600_000;
  const minute = 60_000;
  const day = 24 * hour;
  const iso = (delta: number) => new Date(now.getTime() + delta).toISOString();
  const settings: BriefSettings = {
    decisionLabels: ["needs-owner"],
    stuckPrHours: 48,
    staleIssueDays: 21,
    coordinator: { agentId, maxSilenceHours: 3, workKinds: ["session_end", "milestone", "status"] },
    alerts: {
      enabled: true,
      coordinatorRepeatHours: 12,
      zeroMergeHours: 72,
      zeroMergeLookbackDays: 7,
      decisionAgeDays: 14,
    },
  };
  const coordKey = `coordinator-silent:${agentId}`;
  const mergeKey = `zero-merge:${repo}`;
  const cleanup = async () => {
    await sql()`delete from messages where created_by = 'brief-alerts' and body like ${"%" + slug + "%"}`;
    await sql()`delete from brief_alerts where key like ${"%" + slug + "%"}`;
    await sql()`delete from events where agent_id = ${agentId}`;
    await sql()`delete from agents where id = ${agentId}`;
    await sql()`delete from repo_snapshots where repo = ${repo}`;
    await sql()`delete from watched_repos where repo = ${repo}`;
    await sql()`delete from decisions where repo = ${repo}`;
  };

  const migration = fs.readFileSync("supabase/migrations/20261028_brief_alerts.sql", "utf8");
  const statements = migration
    .split(";")
    .map((part) => part.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of statements) await client.query(statement);
    }
  } finally {
    await client.end();
  }
  const cols = await sql()`
    select column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'brief_alerts'
  `;
  const nullable = new Map(cols.map((row) => [String(row.column_name), String(row.is_nullable)]));
  assert.equal(nullable.get("key"), "NO");
  assert.equal(nullable.get("first_sent_at"), "NO");
  assert.equal(nullable.get("last_sent_at"), "NO");
  assert.equal(nullable.get("cleared_at"), "YES");
  assert.equal(nullable.get("claim_token"), "YES");

  await cleanup();
  try {
    await sql()`insert into agents (id, platform) values (${agentId}, 'other')`;
    await sql()`
      insert into events (agent_id, kind, title, created_at)
      values
        (${agentId}, 'session_end', 'work', ${iso(-4 * hour)}::timestamptz),
        (${agentId}, 'heartbeat', 'beat', ${iso(-minute)}::timestamptz),
        (${agentId}, 'telemetry', 'tick', ${iso(-minute)}::timestamptz),
        (${agentId}, 'turn_start', 'turn', ${iso(-minute)}::timestamptz),
        (${agentId}, 'status_update', 'status', ${iso(-minute)}::timestamptz),
        (${agentId}, 'error', 'boom', ${iso(-minute)}::timestamptz)
    `;
    await sql()`
      insert into watched_repos (repo, label, short, color, position)
      values (${repo}, 'Alert', ${slug.slice(0, 12)}, '#000000', 0)
      on conflict (repo) do nothing
    `;
    await sql()`
      insert into repo_snapshots (repo, collected_at, detail)
      values (
        ${repo},
        ${iso(0)}::timestamptz,
        ${JSON.stringify({ merged: [{ merged_at: iso(-72 * hour) }] })}::jsonb
      )
    `;
    const oldDecision = await sql()`
      insert into decisions (key, source, repo, number, title, status, opened_at, first_seen_at)
      values (
        ${`github:${repo}#1`}, 'github-label', ${repo}, 1, ${`old ${slug}`}, 'open',
        ${iso(-14 * day - minute)}::timestamptz, ${iso(-14 * day - minute)}::timestamptz
      )
      returning id
    `;
    const youngDecision = await sql()`
      insert into decisions (key, source, repo, number, title, status, opened_at, first_seen_at)
      values (
        ${`github:${repo}#2`}, 'github-label', ${repo}, 2, ${`young ${slug}`}, 'open',
        ${iso(-14 * day + minute)}::timestamptz, ${iso(-14 * day + minute)}::timestamptz
      )
      returning id
    `;
    await sql()`
      insert into decisions (key, source, repo, number, title, status, opened_at, first_seen_at)
      values (
        ${`github:${repo}#3`}, 'github-label', ${repo}, 3, ${`done ${slug}`}, 'decided',
        ${iso(-40 * day)}::timestamptz, ${iso(-40 * day)}::timestamptz
      )
    `;
    const oldId = Number(oldDecision[0].id);
    const youngId = Number(youngDecision[0].id);
    const count = async (needle: string) => {
      const rows = await sql()`
        select count(*)::int as n from messages
        where created_by = 'brief-alerts' and position(${needle} in body) > 0
      `;
      return Number(rows[0].n);
    };
    const bodyKey = (key: string) => `brief-alert ${key}\n`;

    const raced = await Promise.all([
      evaluateAlerts({ now, settings }),
      evaluateAlerts({ now, settings }),
    ]);
    assert.equal(raced.reduce((sum, report) => sum + report.sent_count, 0) >= 3, true);
    assert.equal(await count(bodyKey(coordKey)), 1, "a recent heartbeat does not stop the silence alert");
    assert.equal(await count(bodyKey(mergeKey)), 1, "a merge exactly 72h ago fires once");
    assert.equal(await count(bodyKey(`decision:${oldId}`)), 1);
    assert.equal(await count(bodyKey(`decision:${youngId}`)), 0, "14d minus one minute does not alert");
    assert.equal(await count(`github:${repo}#3`), 0, "a decided row does not alert");

    const hourLater = new Date(now.getTime() + hour);
    const held = await evaluateAlerts({ now: hourLater, settings });
    assert.equal(held.alerts.find((alert) => alert.key === coordKey)?.condition, "firing");
    assert.equal(await count(bodyKey(coordKey)), 1, "one hour later does not repeat");

    const halfDay = new Date(now.getTime() + 12 * hour);
    const repeated = await evaluateAlerts({ now: halfDay, settings });
    assert.equal(repeated.alerts.find((alert) => alert.key === coordKey)?.condition, "firing");
    assert.equal(await count(bodyKey(coordKey)), 2, "exactly 12h repeats the coordinator alert");
    assert.equal(await count(bodyKey(mergeKey)), 1, "a zero-merge episode does not repeat at 12h");
    assert.equal(await count(bodyKey(`decision:${oldId}`)), 1, "a decision does not alert twice");

    await sql()`
      insert into events (agent_id, kind, title, created_at)
      values (${agentId}, 'milestone', 'back', ${iso(12 * hour)}::timestamptz)
    `;
    const clearAt = new Date(halfDay.getTime() + minute);
    const cleared = await evaluateAlerts({ now: clearAt, settings });
    assert.equal(cleared.alerts.find((alert) => alert.key === coordKey)?.condition, "clear");
    assert.equal(await count(bodyKey(coordKey)), 2, "a work event clears without another message");
    const latch = await sql()`select cleared_at from brief_alerts where key = ${coordKey}`;
    assert.ok(latch[0]?.cleared_at, "the coordinator latch is cleared");
    const decisionLatch = await sql()`select cleared_at from brief_alerts where key = ${`decision:${oldId}`}`;
    assert.equal(decisionLatch[0]?.cleared_at ?? null, null, "a decision latch is never cleared");

    const instant = (value: unknown) => value instanceof Date ? value.getTime() : Date.parse(String(value));

    // 1. A clear that observed a later instant rejects the stale claim.
    const tClaim = new Date(now.getTime() + 30_000);
    const tClear = new Date(now.getTime() + 90_000);
    await sql()`delete from events where agent_id = ${agentId} and kind = 'milestone'`;
    await sql()`
      update brief_alerts
      set cleared_at = null, last_sent_at = ${tClaim.toISOString()}::timestamptz
      where key = ${coordKey}
    `;
    const beforeStale = await count(bodyKey(coordKey));
    const seen: { report: Awaited<ReturnType<typeof evaluateAlerts>> | null } = { report: null };
    setBeforeClaimForTests(async (key) => {
      if (key !== coordKey) return;
      setBeforeClaimForTests(null);
      await sql()`
        insert into events (agent_id, kind, title, created_at)
        values (${agentId}, 'milestone', 'later-clear', ${tClear.toISOString()}::timestamptz)
      `;
      seen.report = await evaluateAlerts({ now: tClear, settings });
    });
    const stale = await evaluateAlerts({ now: tClaim, settings });
    setBeforeClaimForTests(null);
    const concurrentClear = seen.report;
    if (!concurrentClear) throw new Error("the later clear ran before the stale claim");
    assert.equal(concurrentClear.alerts.find((alert) => alert.key === coordKey)?.condition, "clear");
    assert.equal(stale.failures, undefined, "the stale claim statement ran");
    assert.equal(await count(bodyKey(coordKey)), beforeStale, "a later clear rejects the stale claim");
    assert.equal(stale.sent_count, 0);
    const staleLatch = await sql()`select cleared_at, last_sent_at from brief_alerts where key = ${coordKey}`;
    assert.equal(instant(staleLatch[0]?.cleared_at), tClear.getTime(), "the later clear stays cleared");
    assert.equal(instant(staleLatch[0]?.last_sent_at), tClaim.getTime(), "the stale claim does not rewrite last_sent_at");

    // 2. A delayed clear with an earlier compute instant leaves the newer claim.
    const tNewer = new Date(now.getTime() + 30 * hour);
    const tOlder = new Date(now.getTime() + 29 * hour);
    await sql()`delete from events where agent_id = ${agentId} and kind = 'milestone'`;
    const newerClaim = await evaluateAlerts({ now: tNewer, settings });
    assert.equal(newerClaim.alerts.find((alert) => alert.key === coordKey)?.condition, "firing");
    const afterNewer = await count(bodyKey(coordKey));
    assert.equal(afterNewer, beforeStale + 1, "silence after the clear arms a fresh claim");
    await sql()`
      insert into events (agent_id, kind, title, created_at)
      values (${agentId}, 'milestone', 'already-claimed', ${tNewer.toISOString()}::timestamptz)
    `;
    const delayed = await evaluateAlerts({ now: tOlder, settings });
    assert.equal(delayed.alerts.find((alert) => alert.key === coordKey)?.condition, "clear");
    assert.equal(await count(bodyKey(coordKey)), afterNewer, "a delayed clear sends nothing");
    const kept = await sql()`select cleared_at from brief_alerts where key = ${coordKey}`;
    assert.equal(kept[0]?.cleared_at ?? null, null, "a delayed clear does not erase the newer claim");

    // 3. A decision resolved between compute and claim inserts nothing.
    const dKey = `decision:${oldId}`;
    await sql()`delete from messages where created_by = 'brief-alerts' and position(${bodyKey(dKey)} in body) > 0`;
    await sql()`delete from brief_alerts where key = ${dKey}`;
    assert.equal(await count(bodyKey(dKey)), 0);
    setBeforeClaimForTests(async (key) => {
      if (key !== dKey) return;
      setBeforeClaimForTests(null);
      await sql()`update decisions set status = 'decided' where id = ${oldId}`;
    });
    const resolvedLate = await evaluateAlerts({ now, settings });
    setBeforeClaimForTests(null);
    assert.equal(resolvedLate.alerts.find((alert) => alert.key === dKey)?.condition, "firing");
    assert.equal(resolvedLate.alerts.find((alert) => alert.key === dKey)?.sent, false);
    assert.equal(await count(bodyKey(dKey)), 0, "a decision resolved before the claim sends nothing");
    const gone = await sql()`select key from brief_alerts where key = ${dKey}`;
    assert.equal(gone.length, 0, "a resolved decision does not leave a latch");
  } finally {
    setBeforeClaimForTests(null);
    setBriefSettingsForTests(null);
    await cleanup();
  }
}

/**
 * Snapshot rows stored as `PgCase/A…` count for the watched row `pgcase/a…`.
 * One quiet window sends one lowercase latch. A second evaluate sends nothing.
 * A sent latch under the stored casing is not cleared as absent.
 */
async function testZeroMergeCaseFold(tag: string): Promise<void> {
  const slug = tag.replace(/\W/g, "").slice(-12);
  const watched = `pgcase/a${slug}`;
  const stored = `PgCase/A${slug}`;
  const key = `zero-merge:${watched}`;
  const oldKey = `zero-merge:${stored}`;
  const now = new Date("2026-10-28T12:00:00.000Z");
  const hour = 3_600_000;
  const minute = 60_000;
  const iso = (delta: number) => new Date(now.getTime() + delta).toISOString();
  const settings: BriefSettings = {
    decisionLabels: ["needs-owner"],
    stuckPrHours: 48,
    staleIssueDays: 21,
    coordinator: { agentId: null, maxSilenceHours: 3, workKinds: ["session_end"] },
    alerts: {
      enabled: true,
      coordinatorRepeatHours: 12,
      zeroMergeHours: 72,
      zeroMergeLookbackDays: 7,
      decisionAgeDays: 14,
    },
  };
  const cleanup = async () => {
    await sql()`delete from messages where created_by = 'brief-alerts' and body like ${"%" + slug + "%"}`;
    await sql()`delete from brief_alerts where key = ${key} or key = ${oldKey}`;
    await sql()`delete from repo_snapshots where lower(repo) = lower(${watched})`;
    await sql()`delete from watched_repos where lower(repo) = lower(${watched})`;
  };
  await cleanup();
  try {
    await sql()`
      insert into watched_repos (repo, label, short, color, position)
      values (${watched}, 'Case', ${`c${slug}`.slice(0, 12)}, '#000000', 0)
    `;
    await sql()`
      insert into repo_snapshots (repo, collected_at, detail)
      values (
        ${stored},
        ${iso(0)}::timestamptz,
        ${JSON.stringify({ merged: [{ merged_at: iso(-72 * hour) }] })}::jsonb
      )
    `;
    const count = async () => {
      const rows = await sql()`
        select count(*)::int as n from messages
        where created_by = 'brief-alerts' and position(${`brief-alert ${key}\n`} in body) > 0
      `;
      return Number(rows[0].n);
    };
    const first = await evaluateAlerts({ now, settings });
    assert.equal(first.alerts.find((alert) => alert.key === key)?.condition, "firing");
    assert.equal(first.alerts.some((alert) => alert.key === oldKey), false);
    assert.equal(await count(), 1, "quiet history under another casing sends one lowercase alert");

    const second = await evaluateAlerts({ now: new Date(now.getTime() + minute), settings });
    assert.equal(second.alerts.find((alert) => alert.key === key)?.condition, "firing");
    assert.equal(await count(), 1, "a second evaluate sends nothing more");

    await sql()`
      insert into brief_alerts (key, first_sent_at, last_sent_at)
      values (${oldKey}, ${iso(-hour)}::timestamptz, ${iso(-hour)}::timestamptz)
    `;
    const later = new Date(now.getTime() + 2 * minute);
    await evaluateAlerts({ now: later, settings });
    const kept = await sql()`select cleared_at from brief_alerts where key = ${oldKey}`;
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.cleared_at ?? null, null, "a case-variant latch of a visible repo is not cleared");
  } finally {
    setBriefSettingsForTests(null);
    await cleanup();
  }
}

/** Case-insensitive repo identity and a swept_at activity cutoff, on real SQL. */
async function testRepoCaseIdentity(tag: string): Promise<void> {
  const slug = tag.replace(/\D/g, "").slice(-10);
  const owner = `pgc${slug}`;
  const stored = `${owner}/app`;
  const short = `s${slug}`.slice(0, 12);
  const brand = `Bn${slug}`;
  try {
    await sql()`insert into watched_owners (owner, activity_days) values (${owner}, 30)`;
    await sql()`
      insert into watched_repos (repo, label, short, color, position, origin)
      values (${stored}, 'App', ${short}, '#2563eb', 0, 'manual')
    `;
    const outcome = await applyOwnerDiscovery(
      { owner, activityDays: 30, includeForks: false, includeArchived: false },
      [],
      {
        repos: [
          { name: "App", pushedAt: "2026-01-15T00:00:00.000Z", isFork: false, isArchived: false },
          { name: brand, pushedAt: "2026-01-01T00:00:00.000Z", isFork: false, isArchived: false },
          { name: `Old${slug}`, pushedAt: "2025-12-31T23:59:59.999Z", isFork: false, isArchived: false },
        ],
        error: null,
        sweptAt: "2026-01-31T00:00:00.000Z",
      },
      new Date("2026-10-29T00:00:00.000Z"),
    );
    assert.equal(outcome.failure, null, outcome.failure ?? "");
    const rows = await sql()`
      select repo, pinned
      from watched_repos
      where lower(repo) like ${`${owner.toLowerCase()}/%`}
      order by repo
    `;
    const names = rows.map((row) => String(row.repo));
    assert.deepEqual(names.filter((name) => name.toLowerCase() === stored.toLowerCase()), [stored]);
    assert.ok(names.includes(`${owner}/${brand}`), `expected GitHub casing, saw ${names.join(", ")}`);
    assert.equal(names.some((name) => name.toLowerCase().includes("old")), false);
    const pinned = await setRepoOverride(stored.toUpperCase(), { pinned: true });
    assert.equal(pinned, true);
    const after = await sql()`
      select repo, pinned from watched_repos where lower(repo) = lower(${stored})
    `;
    assert.equal(after.length, 1);
    assert.equal(after[0]?.repo, stored);
    assert.equal(after[0]?.pinned, true);
  } finally {
    await sql()`delete from watched_repos where lower(repo) like ${`${owner.toLowerCase()}/%`}`;
    await sql()`delete from watched_owners where owner = ${owner}`;
  }
}

/**
 * Claim, stamp, and reopen predicates, plus the crash-window retry population.
 * Tagged by repo so the delete cannot touch another test's rows.
 */
async function testDecisionWritebackHardening(tag: string) {
  const repo = `pgtest/h${tag.replace(/\W/g, "")}`;
  const key = (n: number) => `github:${repo}#${n}`;
  const drop = () => sql()`delete from decisions where repo = ${repo}`;
  const body = (n: number): UpsertInput => ({
    key: key(n),
    source: "github-label",
    repo,
    repo_short: "app",
    number: n,
    url: null,
    title: `harden ${n}`,
    why: null,
    options: null,
    recommended: null,
    requested_by: "owner",
    kind: "issue",
    labels: ["needs-owner"],
    opened_at: "2026-07-21T12:00:00.000Z",
    first_seen_at: "2026-07-21T12:00:00.000Z",
    github_present: true,
    force: false,
  });
  const decide = async (id: number, revision: number) => {
    const row = await patchDecision(id, {
      status: "decided",
      decision: "ship",
      setDecision: true,
      decided_by: "mark",
      setDecidedBy: true,
      defer_until: null,
      setDefer: false,
      guardTerminal: true,
      expectedRevision: revision,
    });
    assert.ok(row);
    assert.equal(row.status, "decided");
    return row;
  };

  await drop();
  try {
    const seeded = await upsertDecision(body(1));
    const decided = await decide(seeded.decision.id, seeded.decision.revision);
    const claim = await claimDecisionWriteback(decided.id, decided.revision);
    assert.ok(claim);
    assert.equal(claim.revision, decided.revision + 1);
    const locked = await sql()`
      select writeback_lock, writeback, revision, status from decisions where id = ${decided.id}
    `;
    assert.equal(locked[0].writeback_lock, claim.token);
    assert.equal(locked[0].writeback, null);
    assert.equal(Number(locked[0].revision), claim.revision);

    assert.equal(await claimDecisionWriteback(decided.id, decided.revision), null);
    assert.equal(await claimDecisionWriteback(decided.id, claim.revision), null);
    assert.equal(await setDecisionWriteback(decided.id, "written", claim.revision, "wrong-token"), null);
    assert.equal(await setDecisionWriteback(decided.id, "not_written", claim.revision, null), null);
    const fenced = await sql()`
      select writeback_lock, writeback, revision from decisions where id = ${decided.id}
    `;
    assert.equal(fenced[0].writeback_lock, claim.token);
    assert.equal(fenced[0].writeback, null);
    assert.equal(Number(fenced[0].revision), claim.revision);

    const reopened = await patchDecision(decided.id, {
      status: "open",
      setDecision: false,
      setDecidedBy: false,
      defer_until: null,
      setDefer: false,
      guardTerminal: true,
      expectedRevision: claim.revision,
    });
    assert.equal(reopened, null);
    assert.equal((await getDecision(decided.id))?.status, "decided");

    const stamped = await setDecisionWriteback(decided.id, "written", claim.revision, claim.token);
    assert.equal(stamped?.writeback, "written");
    assert.equal(stamped?.revision, claim.revision + 1);
    const cleared = await sql()`select writeback_lock from decisions where id = ${decided.id}`;
    assert.equal(cleared[0].writeback_lock, null);

    const takeoverSeed = await upsertDecision(body(2));
    const takeoverDecided = await decide(takeoverSeed.decision.id, takeoverSeed.decision.revision);
    const firstClaim = await claimDecisionWriteback(takeoverDecided.id, takeoverDecided.revision);
    assert.ok(firstClaim);
    await sql()`
      update decisions
      set writeback_lock_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS + 1})
      where id = ${takeoverDecided.id}
    `;
    const took = await claimDecisionWriteback(takeoverDecided.id, firstClaim.revision);
    assert.ok(took);
    assert.notEqual(took.token, firstClaim.token);
    assert.equal(took.revision, firstClaim.revision + 1);

    const reopenSeed = await upsertDecision(body(3));
    const reopenDecided = await decide(reopenSeed.decision.id, reopenSeed.decision.revision);
    const reopenClaim = await claimDecisionWriteback(reopenDecided.id, reopenDecided.revision);
    assert.ok(reopenClaim);
    await sql()`
      update decisions
      set writeback_lock_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS + 1})
      where id = ${reopenDecided.id}
    `;
    const opened = await patchDecision(reopenDecided.id, {
      status: "open",
      setDecision: false,
      setDecidedBy: false,
      defer_until: null,
      setDefer: false,
      guardTerminal: true,
      expectedRevision: reopenClaim.revision,
    });
    assert.equal(opened?.status, "open");
    const openedLock = await sql()`select writeback_lock, status from decisions where id = ${reopenDecided.id}`;
    assert.equal(openedLock[0].writeback_lock, null);
    assert.equal(openedLock[0].status, "open");

    const insideSeed = await upsertDecision(body(4));
    const outsideSeed = await upsertDecision(body(5));
    const stampedSeed = await upsertDecision(body(6));
    const writtenSeed = await upsertDecision(body(7));
    const inside = await decide(insideSeed.decision.id, insideSeed.decision.revision);
    const outside = await decide(outsideSeed.decision.id, outsideSeed.decision.revision);
    const freshStamp = await decide(stampedSeed.decision.id, stampedSeed.decision.revision);
    const written = await decide(writtenSeed.decision.id, writtenSeed.decision.revision);
    await sql()`
      update decisions
      set writeback = null,
          writeback_lock = null,
          writeback_lock_at = null,
          decided_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS - 30}),
          updated_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS - 30})
      where id = ${inside.id}
    `;
    await sql()`
      update decisions
      set writeback = null,
          writeback_lock = null,
          writeback_lock_at = null,
          decided_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS + 30}),
          updated_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS + 30})
      where id = ${outside.id}
    `;
    await sql()`
      update decisions set writeback = 'not_written', updated_at = now() where id = ${freshStamp.id}
    `;
    await sql()`
      update decisions
      set writeback = 'written',
          updated_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS + 30})
      where id = ${written.id}
    `;

    // A claimed row whose process died before the stamp. The collector
    // upserts the still-labeled row and refreshes updated_at. The lock
    // timestamp and decided_at stay, so an expired claim is still due.
    const expiredSeed = await upsertDecision(body(8));
    const expiredDecided = await decide(expiredSeed.decision.id, expiredSeed.decision.revision);
    const expiredClaim = await claimDecisionWriteback(expiredDecided.id, expiredDecided.revision);
    assert.ok(expiredClaim);
    await sql()`
      update decisions
      set writeback_lock_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS + 30}),
          decided_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS + 30})
      where id = ${expiredDecided.id}
    `;
    const expiredAgain = await upsertDecision(body(8));
    assert.equal(expiredAgain.decision.id, expiredDecided.id);
    assert.equal(expiredAgain.status_held, true);
    assert.equal(expiredAgain.decision.writeback, null);
    const expiredRow = await sql()`
      select writeback_lock, writeback,
        writeback_lock_at < now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS}) as lock_old,
        decided_at < now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS}) as decided_old,
        updated_at >= now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS}) as updated_fresh
      from decisions where id = ${expiredDecided.id}
    `;
    assert.equal(expiredRow[0].writeback_lock, expiredClaim.token);
    assert.equal(expiredRow[0].writeback, null);
    assert.equal(expiredRow[0].lock_old === true || expiredRow[0].lock_old === "t", true);
    assert.equal(expiredRow[0].decided_old === true || expiredRow[0].decided_old === "t", true);
    assert.equal(expiredRow[0].updated_fresh === true || expiredRow[0].updated_fresh === "t", true);

    // Same crash, but the claim is still inside its lease. The collector
    // refresh must not put that row in the retry population.
    const liveSeed = await upsertDecision(body(9));
    const liveDecided = await decide(liveSeed.decision.id, liveSeed.decision.revision);
    const liveClaim = await claimDecisionWriteback(liveDecided.id, liveDecided.revision);
    assert.ok(liveClaim);
    await sql()`
      update decisions
      set writeback_lock_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS - 30}),
          decided_at = now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS + 30})
      where id = ${liveDecided.id}
    `;
    const liveAgain = await upsertDecision(body(9));
    assert.equal(liveAgain.decision.id, liveDecided.id);
    assert.equal(liveAgain.decision.writeback, null);
    const liveRow = await sql()`
      select writeback_lock,
        writeback_lock_at >= now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS}) as lock_live,
        updated_at >= now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS}) as updated_fresh
      from decisions where id = ${liveDecided.id}
    `;
    assert.equal(liveRow[0].writeback_lock, liveClaim.token);
    assert.equal(liveRow[0].lock_live === true || liveRow[0].lock_live === "t", true);
    assert.equal(liveRow[0].updated_fresh === true || liveRow[0].updated_fresh === "t", true);

    const flags = await sql()`
      select id,
        (
          writeback = 'not_written'
          or (
            status = 'decided'
            and writeback is null
            and (
              writeback_lock is null
              or writeback_lock_at < now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS})
            )
            and coalesce(writeback_lock_at, decided_at, updated_at) < now() - make_interval(secs => ${WRITEBACK_LOCK_LEASE_SECONDS})
          )
        ) as due
      from decisions
      where repo = ${repo} and status = 'decided'
    `;
    const due = new Map(flags.map((row) => [Number(row.id), row.due === true || row.due === "t"]));
    assert.equal(due.get(inside.id), false, "a null writeback inside the lease is not due");
    assert.equal(due.get(outside.id), true, "a null writeback older than the lease is due");
    assert.equal(due.get(freshStamp.id), true, "not_written stays due at any age");
    assert.equal(due.get(written.id), false, "written is not a retry");
    assert.equal(due.get(expiredDecided.id), true, "an expired claim stays due after a collector upsert refreshes updated_at");
    assert.equal(due.get(liveDecided.id), false, "a live claim stays out of the retry population after a collector upsert");
    const listed = await listDecisions({
      status: "decided",
      repo,
      source: null,
      limit: 100,
      shape: "row",
      writeback: "not_written",
    });
    assert.deepEqual(
      listed.map((row) => row.id).sort((a, b) => a - b),
      [...due.entries()].filter(([, isDue]) => isDue).map(([id]) => id).sort((a, b) => a - b),
    );
  } finally {
    await drop();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("test:pg FAILED", e);
  process.exit(1);
});
