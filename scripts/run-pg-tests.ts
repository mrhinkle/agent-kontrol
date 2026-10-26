/**
 * Runs the store against a real Postgres through the pg driver.
 * Usage: DATABASE_URL=postgresql://... npm run test:pg
 * Expects supabase/schema.sql to be applied. Skips (exit 0) when DATABASE_URL is unset.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../src/lib/db";
import { report, remember, recall, createTask, claimNextTask, listTasks } from "../src/lib/store";
import { getWatchedRepos, replaceWatchedRepos } from "../src/lib/watched-repos";
import type { RepoConfig } from "../src/lib/progress-config";
import { getTrace, listTraces, pruneSpans, upsertSpans } from "../src/lib/trace-store";
import { pruneAutomaticNotes, upsertAutomaticNote } from "../src/lib/session-memory";
import type { SpanInput } from "../src/lib/traces";
import {
  ageDays,
  listDecisions,
  patchDecision,
  reconcileDecisions,
  toBriefDecisions,
  upsertDecision,
  type UpsertInput,
} from "../src/lib/decisions";

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

  await testDecisions(tag);

  console.log(`test:pg ok (driver override: ${driverOverride ?? "auto"})`);
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
      insert into decisions (key, source, repo, repo_short, number, title, status, kind, opened_at, first_seen_at, github_present)
      values (${key(9)}, 'github-label', ${repo}, 'app', 9, 'pre-column', 'open', 'issue', ${"2026-10-23T00:00:00.000Z"}, ${"2026-10-23T00:00:00.000Z"}, null)
    `;
    const withNull = toBriefDecisions(
      await listDecisions({ status: "all", repo, source: null, limit: 100 }),
      "2026-10-25T12:00:00Z",
    );
    assert.ok(withNull.some((row) => row.number === 9), "a null github_present still shows in the brief");
  } finally {
    await sql()`delete from decisions where repo = ${repo}`;
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("test:pg FAILED", e);
  process.exit(1);
});
