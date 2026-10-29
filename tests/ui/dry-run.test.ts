import {
  appliedWrites,
  armReadCommittedInsertRace,
  divergeAfterNextMemorySelect,
  fixtureSnapshot,
  queries,
  resetSpy,
  setFixture,
  setRejectWrites,
  writes,
} from "./dry-run-harness";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PUT as putRepos } from "../../src/app/api/settings/repos/route";
import { PATCH as patchTask } from "../../src/app/api/tasks/[id]/route";
import { POST as postMemory } from "../../src/app/api/memory/route";
import {
  DEMO_BANNER,
  demoCreateTask,
  demoFindMemoryByKey,
  demoGetTask,
  demoRemember,
  demoStoreSize,
  demoUpdateTask,
  resetDemoStoreForTests,
  setDemoClockForTests,
} from "../../src/lib/demo-store";
import { rememberForTool, updateTaskForTool } from "../../src/lib/dry-run-actions";
import {
  changeDetails,
  diffMemoryWrite,
  diffRepoList,
  diffTaskUpdate,
  readDryRun,
  type DryRunChange,
} from "../../src/lib/dry-run";
import { memoryRevision, stableRowRevision, taskRevision } from "../../src/lib/revision";
import { authorizeRoute } from "../../src/lib/scopes";
import { listVersion } from "../../src/lib/watched-repos";
import type { RepoInput } from "../../src/lib/repo-validation";
import type { Task } from "../../src/lib/types";

const TOKEN = process.env.MC_TOKEN ?? "";

const STORED: RepoInput = {
  repo: "acme/app",
  label: "App",
  short: "app",
  color: "#112233",
  blockedLabel: null,
};
const STORED_ROW = {
  repo: STORED.repo,
  label: STORED.label,
  short: STORED.short,
  color: STORED.color,
  blocked_label: null,
};
const NEXT: RepoInput = {
  repo: "acme/new-app",
  label: "New App",
  short: "new",
  color: "#335bb2",
  blockedLabel: null,
};
const TASK: Task = {
  id: 7,
  title: "Fix the form",
  description: "do it",
  project: "acme/app",
  platform: "grok",
  machine: null,
  priority: 2,
  status: "queued",
  reviewer_platform: null,
  assigned_agent: null,
  session_id: null,
  result: null,
  cost_usd: null,
  created_by: "dashboard",
  actor_type: null,
  actor_id: null,
  created_at: "2026-10-25T00:00:00.000Z",
  claimed_at: null,
  updated_at: "2026-10-25T00:00:00.000Z",
  completed_at: null,
};
const NOTE = {
  id: 4,
  key: "project/status",
  content: "old note",
  tags: ["ops"],
  agent_id: "grok",
  source: "automatic-session",
  facts_at: "2026-10-01T00:00:00.000Z",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

function authed(url: string, body: unknown, method: string) {
  return new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function detailSide(change: DryRunChange, label: "Before" | "After"): string | undefined {
  return changeDetails(change).find((line) => line.startsWith(`${label}: `));
}

function segments(line: string): string[] {
  return line.replace(/^(Before|After): /, "").split("; ");
}

function hasSegment(line: string | undefined, field: string, shown: string): boolean {
  return line !== undefined && segments(line).includes(`${field}: ${shown}`);
}

function hasField(line: string | undefined, field: string): boolean {
  return line !== undefined && segments(line).some((part) => part.startsWith(`${field}:`));
}

/** The dialog line for each side must include every key the server put on that record. */
function assertRendersRecord(change: DryRunChange, field: string, before: string | null, after: string | null) {
  const beforeLine = detailSide(change, "Before");
  const afterLine = detailSide(change, "After");
  if (before === null) assert.equal(hasField(beforeLine, field), false, beforeLine ?? "");
  else assert.ok(hasSegment(beforeLine, field, before), beforeLine ?? "");
  if (after === null) assert.equal(hasField(afterLine, field), false, afterLine ?? "");
  else assert.ok(hasSegment(afterLine, field, after), afterLine ?? "");

  for (const [label, record] of [
    ["Before", change.before],
    ["After", change.after],
  ] as const) {
    if (!record) {
      assert.equal(detailSide(change, label), undefined);
      continue;
    }
    const line = detailSide(change, label);
    assert.ok(line, label);
    for (const key of Object.keys(record)) {
      if (record[key] === undefined) continue;
      // @types/node 26 assert signatures make an unannotated index read circular
      // when the formatted value is passed to assert.ok.
      const value: unknown = record[key];
      const shown =
        value === null ? "null" : Array.isArray(value) ? value.map((item) => String(item)).join(", ") : String(value);
      assert.ok(hasSegment(line, key, shown), `${label} missing ${key}: ${shown} in ${line}`);
    }
  }
}

function assertReadOnly() {
  assert.equal(writes.length, 0, writes.join("\n"));
  for (const query of queries) {
    assert.equal(/\b(insert|update|delete|alter|drop|truncate)\b/i.test(query), false, query);
  }
}

beforeEach(() => {
  resetSpy();
  setFixture({ repos: [{ ...STORED_ROW }], tasks: [{ ...TASK }], memory: [{ ...NOTE }] });
});

describe("dry run diffs", () => {
  it("treats only boolean true as a preview", () => {
    assert.deepEqual(readDryRun(true), { ok: true, dryRun: true });
    assert.deepEqual(readDryRun(false), { ok: true, dryRun: false });
    assert.deepEqual(readDryRun(undefined), { ok: true, dryRun: false });
    assert.deepEqual(readDryRun("true"), { ok: false });
  });

  it("diffs adds, removes, updates, and reorders against the repo primary key", () => {
    const second: RepoInput = { ...STORED, repo: "acme/web", label: "Web", short: "web" };
    const renamed: RepoInput = { ...second, label: "Website" };
    const diff = diffRepoList([STORED, second], [renamed, NEXT]);
    assert.deepEqual(
      diff.changes.map((change) => change.op),
      ["remove", "update", "add"],
    );
    assert.match(diff.changes[0].summary, /Remove acme\/app/);
    assert.match(diff.changes[1].summary, /Update acme\/web: label/);
    assert.match(diff.changes[1].summary, /Move from position 2 to position 1/);
    assert.match(diff.changes[2].summary, /Add acme\/new-app/);
    assert.equal(diff.would_write, true);
    assert.equal(diff.applied, false);

    const swapped = diffRepoList([STORED, second], [second, STORED]);
    assert.deepEqual(
      swapped.changes.map((change) => change.summary),
      [
        "Move acme/web from position 2 to position 1.",
        "Move acme/app from position 1 to position 2.",
      ],
    );

    const same = diffRepoList([STORED], [STORED]);
    assert.equal(same.changes.length, 0);
    assert.match(same.note ?? "", /refresh timestamps/);

    const recased = diffRepoList([STORED], [{ ...STORED, repo: "Acme/App" }]);
    assert.deepEqual(
      recased.changes.map((change) => change.op),
      ["remove", "add"],
    );
  });

  it("shows a cancel and a memory overwrite from the stored row", () => {
    const cancel = diffTaskUpdate(TASK, { status: "cancelled", agent_id: "grok-lane" });
    assert.equal(cancel.action, "cancel_task");
    assert.equal(cancel.affected[0]?.id, 7);
    assert.match(cancel.changes[0].summary, /status queued → cancelled/);
    assert.match(cancel.changes[1].summary, /grok-lane/);
    const lines = changeDetails(cancel.changes[0]);
    assert.match(lines.join("\n"), /Before:.*status: queued/);
    assert.match(lines.join("\n"), /After:.*status: cancelled/);

    const overwrite = diffMemoryWrite(NOTE, {
      content: "new note",
      key: NOTE.key,
      tags: NOTE.tags,
      agent_id: NOTE.agent_id,
    });
    assert.equal(overwrite.action, "overwrite_memory");
    assert.match(overwrite.changes[0].summary, /Would replace content, source \(cleared\), facts_at \(cleared\)/);
    assert.equal(overwrite.changes[0].before?.content, "old note");
    assert.equal(overwrite.changes[0].after?.content, "new note");
    assert.equal(overwrite.changes[0].after?.source, null);

    const insert = diffMemoryWrite(null, { content: "fresh", key: "other/key" });
    assert.equal(insert.action, "insert_memory");
    assert.equal(insert.affected.length, 0);
  });

  const second: RepoInput = { ...STORED, repo: "acme/web", label: "Web", short: "web" };
  const overwritten = () =>
    diffMemoryWrite(NOTE, {
      content: "new note",
      key: NOTE.key,
      tags: ["ops", "run"],
      agent_id: "codex",
    }).changes[0];

  const fields: { field: string; before: string | null; after: string | null; change: () => DryRunChange }[] = [
    {
      field: "repo",
      before: "acme/app",
      after: null,
      change: () => diffRepoList([STORED], []).changes[0],
    },
    {
      field: "label",
      before: "App",
      after: "Renamed",
      change: () => diffRepoList([STORED], [{ ...STORED, label: "Renamed" }]).changes[0],
    },
    {
      field: "short",
      before: "app",
      after: "svc",
      change: () => diffRepoList([STORED], [{ ...STORED, short: "svc" }]).changes[0],
    },
    {
      field: "color",
      before: "#112233",
      after: "#335bb2",
      change: () => diffRepoList([STORED], [{ ...STORED, color: "#335bb2" }]).changes[0],
    },
    {
      field: "blockedLabel",
      before: "null",
      after: "paused",
      change: () => diffRepoList([STORED], [{ ...STORED, blockedLabel: "paused" }]).changes[0],
    },
    {
      field: "position",
      before: "1",
      after: "0",
      change: () => diffRepoList([STORED, second], [second, STORED]).changes[0],
    },
    {
      field: "status",
      before: "queued",
      after: "cancelled",
      change: () => diffTaskUpdate(TASK, { status: "cancelled" }).changes[0],
    },
    {
      field: "result",
      before: "old output",
      after: "new output",
      change: () => diffTaskUpdate({ ...TASK, result: "old output" }, { result: "new output" }).changes[0],
    },
    {
      field: "cost_usd",
      before: "1.5",
      after: "2.25",
      change: () => diffTaskUpdate({ ...TASK, cost_usd: 1.5 }, { cost_usd: 2.25 }).changes[0],
    },
    {
      field: "session_id",
      before: "null",
      after: "sess-9",
      change: () => diffTaskUpdate(TASK, { session_id: "sess-9" }).changes[0],
    },
    {
      field: "assigned_agent",
      before: "null",
      after: "lane-grok",
      change: () => diffTaskUpdate(TASK, { assigned_agent: "lane-grok" }).changes[0],
    },
    {
      field: "updated_at",
      before: TASK.updated_at,
      after: "(set when the write runs)",
      change: () => diffTaskUpdate(TASK, { status: "running" }).changes[0],
    },
    {
      field: "completed_at",
      before: "null",
      after: "(set when the write runs)",
      change: () => diffTaskUpdate(TASK, { status: "done" }).changes[0],
    },
    {
      field: "agent_id",
      before: null,
      after: "grok-lane",
      change: () => diffTaskUpdate(TASK, { status: "cancelled", agent_id: "grok-lane" }).changes[1],
    },
    {
      field: "task_id",
      before: null,
      after: "7",
      change: () => diffTaskUpdate(TASK, { status: "cancelled", agent_id: "grok-lane" }).changes[1],
    },
    {
      field: "id",
      before: "4",
      after: null,
      change: overwritten,
    },
    {
      field: "key",
      before: "project/status",
      after: "project/status",
      change: overwritten,
    },
    {
      field: "content",
      before: "old note",
      after: "new note",
      change: overwritten,
    },
    {
      field: "tags",
      before: "ops",
      after: "ops, run",
      change: overwritten,
    },
    {
      field: "source",
      before: "automatic-session",
      after: "null",
      change: overwritten,
    },
    {
      field: "facts_at",
      before: "2026-10-01T00:00:00.000Z",
      after: "null",
      change: overwritten,
    },
  ];

  for (const entry of fields) {
    it(`renders ${entry.field} in the confirm dialog`, () => {
      const change = entry.change();
      if (entry.field === "color") assert.equal(change.summary, "Update acme/app: color.");
      if (entry.field === "position") assert.equal(change.summary, "Move acme/web from position 2 to position 1.");
      assertRendersRecord(change, entry.field, entry.before, entry.after);
    });
  }

  it("renders repo on an added row", () => {
    const added = diffRepoList([], [NEXT]).changes[0];
    assertRendersRecord(added, "repo", null, "acme/new-app");
  });

  it("renders agent_id on a memory overwrite", () => {
    assertRendersRecord(overwritten(), "agent_id", "grok", "codex");
  });
});

describe("dry run writes nothing", () => {
  it("previews a repo replace and leaves the stored list unread by any write", async () => {
    const before = fixtureSnapshot();
    setRejectWrites(true);
    const res = await putRepos(authed("http://x/api/settings/repos", { repos: [NEXT], dry_run: true }, "PUT"));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.dry_run, true);
    assert.equal(body.applied, false);
    assert.equal(body.action, "replace_repos");
    assert.equal(body.would_write, true);
    assert.match(body.changes[0].summary, /Remove acme\/app/);
    assert.match(body.changes[1].summary, /Add acme\/new-app/);
    assertReadOnly();
    assert.equal(fixtureSnapshot(), before);

    resetSpy();
    setFixture({ repos: [{ ...STORED_ROW }] });
    const again = await putRepos(authed("http://x/api/settings/repos", { repos: [NEXT], dry_run: true }, "PUT"));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).changes.length, 2);
    assertReadOnly();
  });

  it("rejects a non-boolean dry_run and a stale version without writing", async () => {
    setRejectWrites(true);
    const bad = await putRepos(
      authed("http://x/api/settings/repos", { repos: [NEXT], dry_run: "true" }, "PUT"),
    );
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "validation_failed");
    assert.equal(queries.length, 0);
    assertReadOnly();

    const stale = await putRepos(
      authed("http://x/api/settings/repos", { repos: [NEXT], version: "not-the-list", dry_run: true }, "PUT"),
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "stale");
    assertReadOnly();

    const version = listVersion([STORED]);
    resetSpy();
    setRejectWrites(true);
    const fresh = await putRepos(
      authed("http://x/api/settings/repos", { repos: [NEXT], version, dry_run: true }, "PUT"),
    );
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json()).applied, false);
    assertReadOnly();
  });

  it("still writes when dry_run is omitted, so the spy can see a replace", async () => {
    const res = await putRepos(authed("http://x/api/settings/repos", { repos: [NEXT] }, "PUT"));
    assert.equal(res.status, 200);
    assert.ok(writes.some((sql) => /insert into watched_repos/i.test(sql)));
    assert.ok(writes.some((sql) => /delete from watched_repos/i.test(sql)));
  });

  it("previews a task cancel, including the activity event, and does not update", async () => {
    const before = fixtureSnapshot();
    setRejectWrites(true);
    const res = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", agent_id: "dashboard", dry_run: true }, "PATCH"),
      { params: Promise.resolve({ id: "7" }) },
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.action, "cancel_task");
    assert.equal(body.applied, false);
    assert.equal(body.affected[0].id, 7);
    assert.equal(body.affected[0].status, "queued");
    assert.match(body.changes[0].summary, /status queued → cancelled/);
    assert.match(body.changes[1].summary, /dashboard/);
    assertReadOnly();
    assert.equal(fixtureSnapshot(), before);

    const missing = await patchTask(
      authed("http://x/api/tasks/99", { status: "cancelled", dry_run: true }, "PATCH"),
      { params: Promise.resolve({ id: "99" }) },
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "task_not_found");
    assertReadOnly();
  });

  it("rejects a string dry_run on cancel and still updates when the flag is omitted", async () => {
    setRejectWrites(true);
    const bad = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", dry_run: "true" }, "PATCH"),
      { params: Promise.resolve({ id: "7" }) },
    );
    assert.equal(bad.status, 400);
    assertReadOnly();

    setRejectWrites(false);
    resetSpy();
    const applied = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", agent_id: "dashboard" }, "PATCH"),
      { params: Promise.resolve({ id: "7" }) },
    );
    assert.equal(applied.status, 200);
    assert.equal((await applied.json()).ok, true);
    assert.ok(writes.some((sql) => /update tasks/i.test(sql)));
    assert.ok(writes.some((sql) => /insert into agents/i.test(sql)));
  });

  it("rejects a non-boolean dry_run when no database is configured", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      resetSpy();
      for (const dry_run of ["true", 0, {}]) {
        const res = await patchTask(
          authed("http://x/api/tasks/7", { status: "cancelled", dry_run }, "PATCH"),
          { params: Promise.resolve({ id: "7" }) },
        );
        assert.equal(res.status, 400, JSON.stringify(dry_run));
        const body = await res.json();
        assert.equal(body.code, "validation_failed");
        assert.equal(body.fields.dry_run, "Use true to preview, or false to apply.");
        assert.equal(body.ok, undefined);
        assert.equal(body.demo, undefined);
      }

      const preview = await patchTask(
        authed("http://x/api/tasks/7", { status: "cancelled", dry_run: true }, "PATCH"),
        { params: Promise.resolve({ id: "7" }) },
      );
      const previewBody = await preview.json();
      assert.equal(preview.status, 200);
      assert.equal(previewBody.dry_run, true);
      assert.equal(previewBody.would_write, false);
      assert.equal(previewBody.applied, false);
      assert.equal(previewBody.action, "cancel_task");

      const omitted = await patchTask(
        authed("http://x/api/tasks/7", { status: "cancelled" }, "PATCH"),
        { params: Promise.resolve({ id: "7" }) },
      );
      const omittedBody = await omitted.json();
      assert.equal(omitted.status, 200);
      assert.equal(omittedBody.ok, true);
      assert.equal(omittedBody.demo, true);

      const explicit = await patchTask(
        authed("http://x/api/tasks/7", { status: "done", dry_run: false }, "PATCH"),
        { params: Promise.resolve({ id: "7" }) },
      );
      const explicitBody = await explicit.json();
      assert.equal(explicit.status, 200);
      assert.equal(explicitBody.ok, true);
      assert.equal(explicitBody.demo, true);

      const nullBody = await patchTask(authed("http://x/api/tasks/7", null, "PATCH"), {
        params: Promise.resolve({ id: "7" }),
      });
      assert.equal(nullBody.status, 400);
      const nullJson = await nullBody.json();
      assert.equal(nullJson.code, "invalid_json");
      assert.equal(nullJson.ok, undefined);
      assert.equal(nullJson.demo, undefined);
      assert.equal(queries.length, 0);
      assert.equal(writes.length, 0);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("previews a memory overwrite and does not upsert", async () => {
    const before = fixtureSnapshot();
    setRejectWrites(true);
    const res = await postMemory(
      authed(
        "http://x/api/memory",
        {
          content: "new note",
          key: "project/status",
          tags: ["ops"],
          agent_id: "grok",
          dry_run: true,
        },
        "POST",
      ),
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.action, "overwrite_memory");
    assert.equal(body.applied, false);
    assert.equal(body.would_write, true);
    assert.equal(body.changes[0].before.content, "old note");
    assert.equal(body.changes[0].after.content, "new note");
    assert.equal(body.changes[0].after.source, null);
    assert.match(changeDetails(body.changes[0]).join("\n"), /Before:.*content: old note/);
    assertReadOnly();
    assert.equal(fixtureSnapshot(), before);

    resetSpy();
    setRejectWrites(true);
    const created = await postMemory(
      authed("http://x/api/memory", { content: "fresh", key: "other/key", dry_run: true }, "POST"),
    );
    const insert = await created.json();
    assert.equal(insert.action, "insert_memory");
    assert.equal(insert.affected.length, 0);
    assertReadOnly();
  });

  it("rejects a bad key and a non-boolean dry_run before any query", async () => {
    setRejectWrites(true);
    const badKey = await postMemory(
      authed("http://x/api/memory", { content: "x", key: "", dry_run: true }, "POST"),
    );
    assert.equal(badKey.status, 400);
    assert.equal((await badKey.json()).code, "memory_key_invalid");
    const badFlag = await postMemory(
      authed("http://x/api/memory", { content: "x", key: "project/status", dry_run: "true" }, "POST"),
    );
    assert.equal(badFlag.status, 400);
    assert.equal(queries.length, 0);
    assertReadOnly();
  });

  it("returns 400 invalid_json for a JSON null body on POST /api/memory", async () => {
    const res = await postMemory(authed("http://x/api/memory", null, "POST"));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_json");
    assert.equal(queries.length, 0);
    assert.equal(writes.length, 0);
  });

  it("returns 400 invalid_json for a JSON null body on task PATCH", async () => {
    const res = await patchTask(authed("http://x/api/tasks/7", null, "PATCH"), {
      params: Promise.resolve({ id: "7" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_json");
    assert.equal(queries.length, 0);
    assert.equal(writes.length, 0);
  });

  it("stores a note when dry_run is omitted, so the spy can see the upsert", async () => {
    const res = await postMemory(
      authed("http://x/api/memory", { content: "new note", key: "project/status", agent_id: "grok" }, "POST"),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).applied, true);
    const upsert = writes.find((sql) => /insert into memory/i.test(sql));
    assert.ok(upsert);
    assert.match(upsert, /on conflict \(key\) do update set/);
    assert.match(upsert, /source = null/);
    assert.match(upsert, /facts_at = null/);
  });

  it("MCP remember and update_task preview without writing, and still write when asked", async () => {
    setRejectWrites(true);
    const remembered = await rememberForTool({
      content: "new note",
      key: "project/status",
      tags: ["ops"],
      agent_id: "grok",
      dry_run: true,
    });
    const memoryPreview = JSON.parse(remembered.content[0].text);
    assert.equal(memoryPreview.applied, false);
    assert.equal(memoryPreview.action, "overwrite_memory");
    assert.equal(remembered.isError, undefined);

    const updated = await updateTaskForTool({
      id: 7,
      status: "cancelled",
      agent_id: "grok-lane",
      dry_run: true,
    });
    const taskPreview = JSON.parse(updated.content[0].text);
    assert.equal(taskPreview.action, "cancel_task");
    assert.equal(taskPreview.applied, false);
    assert.match(taskPreview.changes[1].summary, /grok-lane/);
    assertReadOnly();

    setRejectWrites(false);
    resetSpy();
    const stored = await rememberForTool({ content: "new note", key: "project/status" });
    assert.match(stored.content[0].text, /^Stored memory #/);
    const task = await updateTaskForTool({ id: 7, status: "cancelled", agent_id: "grok-lane" });
    assert.match(task.content[0].text, /^Task #7 updated/);
    assert.ok(writes.some((sql) => /insert into memory/i.test(sql)));
    assert.ok(writes.some((sql) => /update tasks/i.test(sql)));
    assert.ok(writes.some((sql) => /insert into agents/i.test(sql)));
  });

  it("stores a demo remember in memory, previews dry_run without writing, and returns task_not_found for a missing task", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      resetSpy();
      resetDemoStoreForTests();
      const plain = await rememberForTool({ content: "kept", key: "project/status" });
      assert.equal(plain.content[0].text.startsWith(`${DEMO_BANNER}\n`), true);
      assert.match(plain.content[0].text, /Stored memory #/);
      assert.equal(demoStoreSize().notes, 1);
      const preview = await rememberForTool({ content: "ghost", key: "project/ghost", dry_run: true });
      const body = JSON.parse(preview.content[0].text);
      assert.equal(body.dry_run, true);
      assert.equal(body.would_write, true);
      assert.equal(body.applied, false);
      assert.equal(demoStoreSize().notes, 1);
      const task = await updateTaskForTool({ id: 7, status: "cancelled", dry_run: true });
      assert.equal(task.isError, true);
      assert.equal(JSON.parse(task.content[0].text).code, "task_not_found");
      assert.equal(JSON.parse(task.content[0].text).error, "Task not found");
      const taskPlain = await updateTaskForTool({ id: 7, status: "done" });
      assert.equal(taskPlain.isError, true);
      assert.equal(JSON.parse(taskPlain.content[0].text).error, "Task not found");
      assert.equal(demoStoreSize().tasks, 0);
      assert.equal(queries.length, 0);
      assert.equal(writes.length, 0);
    } finally {
      process.env.DATABASE_URL = previous;
    }
  });
});

describe("dry run wiring", () => {
  it("grants POST /api/memory to memory:write and not to memory:read", () => {
    const writer = authorizeRoute({ kind: "agent", id: "a", scopes: ["memory:write"] }, "POST", "/api/memory");
    const reader = authorizeRoute({ kind: "agent", id: "a", scopes: ["memory:read"] }, "POST", "/api/memory");
    assert.equal(writer.ok, true);
    assert.equal(reader.ok, false);
  });

  it("keeps the preview module free of the database, and points MCP and the dialogs at it", () => {
    const preview = fs.readFileSync("src/lib/dry-run.ts", "utf8");
    assert.doesNotMatch(preview, /from "\.\/(db|store)"/);
    const route = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    assert.match(route, /rememberForTool\(args\)/);
    assert.match(route, /updateTaskForTool\(args\)/);
    assert.match(route, /dry_run: z\.boolean\(\)/);
    const dialog = fs.readFileSync("src/components/PreviewDialog.tsx", "utf8");
    assert.match(dialog, /changeDetails\(change\)/);
    assert.match(dialog, /preview\.changes/);
    assert.match(dialog, /preview\.would_write/);
    for (const file of ["src/components/RepoSettings.tsx", "src/app/tasks/page.tsx", "src/app/memory/page.tsx"]) {
      const src = fs.readFileSync(file, "utf8");
      assert.match(src, /dry_run: true/, file);
      assert.match(src, /PreviewDialog/, file);
    }
    const memoryPage = fs.readFileSync("src/app/memory/page.tsx", "utf8");
    const tasksPage = fs.readFileSync("src/app/tasks/page.tsx", "utf8");
    assert.match(memoryPage, /expected_revision/);
    assert.match(memoryPage, /stale_write/);
    assert.match(memoryPage, /Review the new preview before overwriting/);
    assert.match(tasksPage, /expected_revision/);
    assert.match(tasksPage, /stale_write/);
    assert.match(tasksPage, /Review the new preview before cancelling/);
  });

  it("keeps each preview hash expression identical to its compare-and-write predicate", () => {
    const src = fs.readFileSync("src/lib/store.ts", "utf8");
    const exprs = src.match(/md5\([^)]*\)/g) ?? [];
    assert.ok(exprs.length >= 6);
    for (const expr of exprs) assert.match(expr, /^md5\([mt]::text\)$/);
    assert.ok((src.match(/md5\(m::text\)/g) ?? []).length >= 3);
    assert.ok((src.match(/md5\(t::text\)/g) ?? []).length >= 3);
    assert.equal(/updated_at\s*=\s*\$\{[^}]+\}::timestamptz/.test(src), false);
  });
});

function taskParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function storedMemory(): { key: string; content: string; updated_at: string | null } | undefined {
  const snapshot = JSON.parse(fixtureSnapshot()) as {
    memory: { key: string; content: string; updated_at: string | null }[];
  };
  return snapshot.memory.find((row) => row.key === "project/status");
}

function storedTask(): { id: number; status: string; updated_at: string | null } | undefined {
  const snapshot = JSON.parse(fixtureSnapshot()) as {
    tasks: { id: number; status: string; updated_at: string | null }[];
  };
  return snapshot.tasks.find((row) => row.id === 7);
}

function storedMemoryRow(): Record<string, unknown> {
  const snapshot = JSON.parse(fixtureSnapshot()) as { memory: Record<string, unknown>[] };
  const row = snapshot.memory.find((item) => item.key === "project/status");
  if (!row) throw new Error("missing memory row");
  return row;
}

function storedTaskRow(): Record<string, unknown> {
  const snapshot = JSON.parse(fixtureSnapshot()) as { tasks: Record<string, unknown>[] };
  const row = snapshot.tasks.find((item) => item.id === 7);
  if (!row) throw new Error("missing task row");
  return row;
}

describe("stale preview confirmations", () => {
  it("F1 rejects a memory confirm after another writer commits the same key", async () => {
    const previewRes = await postMemory(
      authed(
        "http://x/api/memory",
        { content: "from the preview", key: "project/status", tags: ["ops"], dry_run: true },
        "POST",
      ),
    );
    const preview = await previewRes.json();
    assert.equal(previewRes.status, 200);
    assert.equal(preview.expected_revision, stableRowRevision(NOTE));
    assert.match(preview.expected_revision, /^[0-9a-f]{32}$/);
    assert.equal(preview.would_write, true);
    const seen = preview.expected_revision as string;

    resetSpy();
    const other = await postMemory(
      authed(
        "http://x/api/memory",
        { content: "newer note", key: "project/status", expected_revision: seen },
        "POST",
      ),
    );
    assert.equal(other.status, 200);
    assert.equal(storedMemory()?.content, "newer note");
    const current = stableRowRevision(storedMemoryRow());
    assert.notEqual(current, seen);

    resetSpy();
    const before = fixtureSnapshot();
    const stale = await postMemory(
      authed(
        "http://x/api/memory",
        { content: "stale confirm", key: "project/status", expected_revision: seen },
        "POST",
      ),
    );
    const body = await stale.json();
    assert.equal(stale.status, 409);
    assert.equal(body.error, "stale_write");
    assert.equal(body.code, "stale_write");
    assert.equal(body.current_revision, current);
    assert.equal(storedMemory()?.content, "newer note");
    assert.equal(fixtureSnapshot(), before);
    assert.equal(appliedWrites(), 0);
    assert.equal(queries[0]?.includes("select"), false);
    assert.match(queries.find((sql) => /update\s+memory/i.test(sql)) ?? "", /md5\(\s*m::text\s*\)/);
    assert.equal(writes.some((sql) => /insert\s+into\s+memory/i.test(sql)), false);
  });

  it("F2 rejects a cancel confirm after the task is already done", async () => {
    const previewRes = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", dry_run: true }, "PATCH"),
      taskParams("7"),
    );
    const preview = await previewRes.json();
    assert.equal(previewRes.status, 200);
    assert.equal(preview.action, "cancel_task");
    assert.equal(preview.expected_revision, stableRowRevision(TASK));
    assert.match(preview.expected_revision, /^[0-9a-f]{32}$/);
    const seen = preview.expected_revision as string;

    resetSpy();
    const done = await patchTask(
      authed("http://x/api/tasks/7", { status: "done", agent_id: "other-writer", expected_revision: seen }, "PATCH"),
      taskParams("7"),
    );
    assert.equal(done.status, 200);
    assert.equal(storedTask()?.status, "done");

    resetSpy();
    const before = fixtureSnapshot();
    const stale = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", agent_id: "dashboard", expected_revision: seen }, "PATCH"),
      taskParams("7"),
    );
    const body = await stale.json();
    assert.equal(stale.status, 409);
    assert.equal(body.error, "stale_write");
    assert.equal(body.code, "stale_write");
    assert.equal(body.current_revision, stableRowRevision(storedTaskRow()));
    assert.notEqual(body.current_revision, seen);
    assert.equal(storedTask()?.status, "done");
    assert.equal(fixtureSnapshot(), before);
    assert.equal(appliedWrites(), 0);
    assert.equal(writes.some((sql) => /insert\s+into\s+agents/i.test(sql)), false);
    assert.match(queries.find((sql) => /update\s+tasks/i.test(sql)) ?? "", /md5\(\s*t::text\s*\)/);
  });

  it("F3 keeps the old response shape when expected_revision is omitted", async () => {
    const memory = await postMemory(
      authed("http://x/api/memory", { content: "new note", key: "project/status", agent_id: "grok" }, "POST"),
    );
    const memoryBody = await memory.json();
    assert.equal(memory.status, 200);
    assert.deepEqual(Object.keys(memoryBody).sort(), ["applied", "item", "ok"]);
    assert.equal(memoryBody.ok, true);
    assert.equal(memoryBody.applied, true);
    assert.equal(memoryBody.current_revision, undefined);
    assert.equal(memoryBody.error, undefined);
    const upsert = writes.find((sql) => /insert\s+into\s+memory/i.test(sql)) ?? "";
    assert.match(upsert, /on conflict \(key\) do update set/);
    assert.doesNotMatch(upsert, /updated_at\s*=\s*\$\d+::timestamptz/);
    assert.doesNotMatch(upsert, /md5\(/);
    assert.equal(upsert.includes("hash-revision"), false);

    resetSpy();
    const task = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", agent_id: "dashboard" }, "PATCH"),
      taskParams("7"),
    );
    const taskBody = await task.json();
    assert.equal(task.status, 200);
    assert.deepEqual(Object.keys(taskBody).sort(), ["ok", "task"]);
    assert.equal(taskBody.ok, true);
    assert.equal(taskBody.current_revision, undefined);
    const update = writes.find((sql) => /update\s+tasks/i.test(sql)) ?? "";
    assert.match(update, /where\s+id\s*=\s*\$\d+/);
    assert.doesNotMatch(update, /updated_at\s*=\s*\$\d+::timestamptz/);
    assert.doesNotMatch(update, /md5\(/);
    assert.equal(update.includes("hash-revision"), false);
  });

  it("F4 lets exactly one of two racing confirms apply", async () => {
    const previewRes = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", dry_run: true }, "PATCH"),
      taskParams("7"),
    );
    const seen = (await previewRes.json()).expected_revision as string;
    assert.equal(seen, stableRowRevision(TASK));
    assert.match(seen, /^[0-9a-f]{32}$/);
    resetSpy();

    const responses = await Promise.all([
      patchTask(
        authed("http://x/api/tasks/7", { status: "cancelled", agent_id: "dashboard", expected_revision: seen }, "PATCH"),
        taskParams("7"),
      ),
      patchTask(
        authed("http://x/api/tasks/7", { status: "cancelled", agent_id: "dashboard", expected_revision: seen }, "PATCH"),
        taskParams("7"),
      ),
    ]);
    const bodies = await Promise.all(responses.map((res) => res.json()));
    const statuses = responses.map((res) => res.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(bodies.filter((body) => body.ok === true).length, 1);
    const loser = bodies.find((body) => body.error === "stale_write");
    assert.ok(loser);
    assert.equal(loser.code, "stale_write");
    assert.equal(loser.current_revision, stableRowRevision(storedTaskRow()));
    assert.notEqual(loser.current_revision, seen);
    assert.equal(storedTask()?.status, "cancelled");
    assert.equal(appliedWrites(), 1);
    assert.equal(writes.filter((sql) => /insert\s+into\s+agents/i.test(sql)).length, 1);
    const updates = writes.filter((sql) => /update\s+tasks/i.test(sql));
    assert.equal(updates.length, 2);
    for (const sql of updates) assert.match(sql, /md5\(\s*t::text\s*\)/);

    resetSpy();
    setFixture({ repos: [{ ...STORED_ROW }], tasks: [{ ...TASK }], memory: [{ ...NOTE }] });
    const memoryPreview = await postMemory(
      authed("http://x/api/memory", { content: "racing", key: "project/status", dry_run: true }, "POST"),
    );
    const memorySeen = (await memoryPreview.json()).expected_revision as string;
    resetSpy();
    const memoryResponses = await Promise.all([
      postMemory(
        authed("http://x/api/memory", { content: "race-a", key: "project/status", expected_revision: memorySeen }, "POST"),
      ),
      postMemory(
        authed("http://x/api/memory", { content: "race-b", key: "project/status", expected_revision: memorySeen }, "POST"),
      ),
    ]);
    const memoryBodies = await Promise.all(memoryResponses.map((res) => res.json()));
    assert.deepEqual(memoryResponses.map((res) => res.status).sort(), [200, 409]);
    assert.equal(memoryBodies.filter((body) => body.error === "stale_write").length, 1);
    assert.equal(appliedWrites(), 1);
    const winner = memoryBodies.find((body) => body.ok === true);
    assert.equal(storedMemory()?.content, winner.item.content);
  });

  it("F5 returns not-found for a deleted memory key or a missing task and does not insert", async () => {
    const memoryPreview = await postMemory(
      authed("http://x/api/memory", { content: "gone", key: "project/status", dry_run: true }, "POST"),
    );
    const memorySeen = (await memoryPreview.json()).expected_revision as string;
    setFixture({ memory: [] });
    resetSpy();
    const memory = await postMemory(
      authed(
        "http://x/api/memory",
        { content: "resurrect", key: "project/status", expected_revision: memorySeen },
        "POST",
      ),
    );
    const memoryBody = await memory.json();
    assert.equal(memory.status, 404);
    assert.equal(memoryBody.code, "not_found");
    assert.equal(memoryBody.error, "not found");
    assert.equal(JSON.parse(fixtureSnapshot()).memory.length, 0);
    assert.equal(writes.some((sql) => /insert\s+into\s+memory/i.test(sql)), false);
    assert.equal(appliedWrites(), 0);

    const taskPreview = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", dry_run: true }, "PATCH"),
      taskParams("7"),
    );
    const taskSeen = (await taskPreview.json()).expected_revision as string;
    setFixture({ tasks: [] });
    resetSpy();
    const task = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", expected_revision: taskSeen }, "PATCH"),
      taskParams("7"),
    );
    const taskBody = await task.json();
    assert.equal(task.status, 404);
    assert.equal(taskBody.code, "task_not_found");
    assert.equal(taskBody.error, "Task not found");
    assert.equal(JSON.parse(fixtureSnapshot()).tasks.length, 0);
    assert.equal(writes.some((sql) => /insert\s+into\s+tasks/i.test(sql)), false);
    assert.equal(appliedWrites(), 0);
  });

  it("F6 rejects a malformed expected_revision before any query", async () => {
    const samples: unknown[] = [1, { rev: "x" }, ["x"], true, null, "", "x".repeat(201), "x".repeat(10000), "bad\nrev"];
    for (const expected_revision of samples) {
      resetSpy();
      const before = fixtureSnapshot();
      const memory = await postMemory(
        authed("http://x/api/memory", { content: "nope", key: "project/status", expected_revision }, "POST"),
      );
      const memoryBody = await memory.json();
      assert.equal(memory.status, 400, JSON.stringify(expected_revision));
      assert.equal(memoryBody.code, "validation_failed");
      assert.equal(memoryBody.fields.expected_revision, "Send the revision from the preview, or omit it.");
      assert.equal(queries.length, 0);
      assert.equal(writes.length, 0);
      assert.equal(fixtureSnapshot(), before);

      resetSpy();
      const task = await patchTask(
        authed("http://x/api/tasks/7", { status: "cancelled", expected_revision }, "PATCH"),
        taskParams("7"),
      );
      const taskBody = await task.json();
      assert.equal(task.status, 400, JSON.stringify(expected_revision));
      assert.equal(taskBody.code, "validation_failed");
      assert.equal(queries.length, 0);
      assert.equal(fixtureSnapshot(), before);
    }
  });

  it("rejects a hash revision after the underlying value changes", async () => {
    setFixture({
      memory: [{ ...NOTE, updated_at: null }],
      tasks: [{ ...TASK, updated_at: null }],
    });
    const memoryPreview = await postMemory(
      authed("http://x/api/memory", { content: "hash note", key: "project/status", dry_run: true }, "POST"),
    );
    const memorySeen = (await memoryPreview.json()).expected_revision as string;
    assert.match(memorySeen, /^[0-9a-f]{32}$/);
    assert.equal(memorySeen, stableRowRevision({ ...NOTE, updated_at: null }));
    setFixture({ memory: [{ ...NOTE, content: "other writer", updated_at: null }] });
    resetSpy();
    const memory = await postMemory(
      authed(
        "http://x/api/memory",
        { content: "stale hash", key: "project/status", expected_revision: memorySeen },
        "POST",
      ),
    );
    const memoryBody = await memory.json();
    assert.equal(memory.status, 409);
    assert.equal(memoryBody.error, "stale_write");
    assert.equal(memoryBody.current_revision, stableRowRevision(storedMemoryRow()));
    assert.match(memoryBody.current_revision, /^[0-9a-f]{32}$/);
    assert.notEqual(memoryBody.current_revision, memorySeen);
    assert.equal(storedMemory()?.content, "other writer");
    assert.match(writes.find((sql) => /update\s+memory/i.test(sql)) ?? "", /md5\(\s*m::text\s*\)/);
    assert.equal(appliedWrites(), 0);

    const taskPreview = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", dry_run: true }, "PATCH"),
      taskParams("7"),
    );
    const taskSeen = (await taskPreview.json()).expected_revision as string;
    assert.match(taskSeen, /^[0-9a-f]{32}$/);
    assert.equal(taskSeen, stableRowRevision({ ...TASK, updated_at: null }));
    setFixture({ tasks: [{ ...TASK, status: "done", updated_at: null }] });
    resetSpy();
    const task = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", expected_revision: taskSeen }, "PATCH"),
      taskParams("7"),
    );
    const taskBody = await task.json();
    assert.equal(task.status, 409);
    assert.equal(taskBody.error, "stale_write");
    assert.equal(taskBody.current_revision, stableRowRevision(storedTaskRow()));
    assert.notEqual(taskBody.current_revision, taskSeen);
    assert.equal(storedTask()?.status, "done");
    assert.match(writes.find((sql) => /update\s+tasks/i.test(sql)) ?? "", /md5\(\s*t::text\s*\)/);
    assert.equal(appliedWrites(), 0);
  });

  it("F7 applies the same stale guard in demo mode and leaves an omitted revision unchanged", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    let clock = Date.parse("2026-10-28T12:00:00.000Z");
    setDemoClockForTests(() => clock);
    try {
      resetDemoStoreForTests();
      resetSpy();
      const seeded = await demoRemember({ content: "old note", key: "project/status", tags: ["ops"], agent_id: "grok" });
      const memoryPreview = await postMemory(
        authed("http://x/api/memory", { content: "from the preview", key: "project/status", dry_run: true }, "POST"),
      );
      const memoryPreviewBody = await memoryPreview.json();
      assert.equal(memoryPreview.status, 200);
      assert.equal(memoryPreviewBody.would_write, false);
      assert.equal(memoryPreviewBody.note, "DATABASE_URL not set; note not stored.");
      assert.equal(memoryPreviewBody.expected_revision, memoryRevision(seeded));
      assert.match(memoryPreviewBody.expected_revision, /^[0-9a-f]{32}$/);
      clock += 5000;
      const newer = await demoRemember({ content: "newer note", key: "project/status" });
      assert.notEqual(memoryRevision(newer), memoryRevision(seeded));
      const staleMemory = await postMemory(
        authed(
          "http://x/api/memory",
          { content: "stale confirm", key: "project/status", expected_revision: memoryPreviewBody.expected_revision },
          "POST",
        ),
      );
      const staleMemoryBody = await staleMemory.json();
      assert.equal(staleMemory.status, 409);
      assert.equal(staleMemoryBody.error, "stale_write");
      assert.equal(staleMemoryBody.code, "stale_write");
      assert.equal(staleMemoryBody.current_revision, memoryRevision(newer));
      assert.equal((await demoFindMemoryByKey("project/status"))?.content, "newer note");

      clock += 5000;
      const created = await demoCreateTask({ title: "Fix the form", platform: "grok" });
      const taskPreview = await patchTask(
        authed(`http://x/api/tasks/${created.id}`, { status: "cancelled", dry_run: true }, "PATCH"),
        taskParams(String(created.id)),
      );
      const taskPreviewBody = await taskPreview.json();
      assert.equal(taskPreview.status, 200);
      assert.equal(taskPreviewBody.would_write, false);
      assert.equal(taskPreviewBody.note, "DATABASE_URL not set; nothing would be written.");
      assert.equal(taskPreviewBody.expected_revision, taskRevision(created));
      assert.match(taskPreviewBody.expected_revision, /^[0-9a-f]{32}$/);
      clock += 5000;
      await demoUpdateTask({ id: created.id, status: "done" });
      const staleTask = await patchTask(
        authed(
          `http://x/api/tasks/${created.id}`,
          { status: "cancelled", expected_revision: taskPreviewBody.expected_revision },
          "PATCH",
        ),
        taskParams(String(created.id)),
      );
      const staleTaskBody = await staleTask.json();
      assert.equal(staleTask.status, 409);
      assert.equal(staleTaskBody.error, "stale_write");
      assert.equal(staleTaskBody.current_revision, taskRevision((await demoGetTask(created.id))!));
      assert.equal((await demoGetTask(created.id))?.status, "done");

      const notesBefore = demoStoreSize().notes;
      const tasksBefore = demoStoreSize().tasks;
      const dropped = await postMemory(
        authed("http://x/api/memory", { content: "dropped", key: "project/fresh" }, "POST"),
      );
      assert.deepEqual(await dropped.json(), {
        ok: true,
        demo: true,
        applied: false,
        note: "DATABASE_URL not set; note not stored.",
      });
      const droppedTask = await patchTask(
        authed(`http://x/api/tasks/${created.id}`, { status: "cancelled" }, "PATCH"),
        taskParams(String(created.id)),
      );
      assert.deepEqual(await droppedTask.json(), { ok: true, demo: true });
      assert.equal(demoStoreSize().notes, notesBefore);
      assert.equal(demoStoreSize().tasks, tasksBefore);
      assert.equal((await demoGetTask(created.id))?.status, "done");
      assert.equal(queries.length, 0);
      assert.equal(writes.length, 0);
    } finally {
      setDemoClockForTests(null);
      resetDemoStoreForTests();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("confirms a row whose updated_at has microseconds with the preview token", async () => {
    const micro = "2026-10-28T12:00:00.123456Z";
    setFixture({
      memory: [{ ...NOTE, updated_at: micro }],
      tasks: [{ ...TASK, updated_at: micro }],
    });

    const memoryPreview = await postMemory(
      authed("http://x/api/memory", { content: "confirmed note", key: "project/status", dry_run: true }, "POST"),
    );
    const memoryBody = await memoryPreview.json();
    assert.equal(memoryPreview.status, 200);
    const memorySeen = memoryBody.expected_revision as string;
    assert.match(memorySeen, /^[0-9a-f]{32}$/);
    assert.equal(memorySeen, stableRowRevision({ ...NOTE, updated_at: micro }));
    resetSpy();
    const memory = await postMemory(
      authed(
        "http://x/api/memory",
        { content: "confirmed note", key: "project/status", expected_revision: memorySeen },
        "POST",
      ),
    );
    assert.equal(memory.status, 200, JSON.stringify(await memory.clone().json()));
    assert.equal(storedMemory()?.content, "confirmed note");
    const memorySql = writes.find((sql) => /update\s+memory/i.test(sql)) ?? "";
    assert.match(memorySql, /md5\(\s*m::text\s*\)/);
    assert.doesNotMatch(memorySql, /updated_at\s*=\s*\$\d+::timestamptz/);

    const taskPreview = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", dry_run: true }, "PATCH"),
      taskParams("7"),
    );
    const taskBody = await taskPreview.json();
    assert.equal(taskPreview.status, 200);
    const taskSeen = taskBody.expected_revision as string;
    assert.match(taskSeen, /^[0-9a-f]{32}$/);
    assert.equal(taskSeen, stableRowRevision({ ...TASK, updated_at: micro }));
    resetSpy();
    const task = await patchTask(
      authed("http://x/api/tasks/7", { status: "cancelled", expected_revision: taskSeen }, "PATCH"),
      taskParams("7"),
    );
    assert.equal(task.status, 200, JSON.stringify(await task.clone().json()));
    assert.equal(storedTask()?.status, "cancelled");
    const taskSql = writes.find((sql) => /update\s+tasks/i.test(sql)) ?? "";
    assert.match(taskSql, /md5\(\s*t::text\s*\)/);
    assert.doesNotMatch(taskSql, /updated_at\s*=\s*\$\d+::timestamptz/);
  });

  it("a memory preview from one read cannot confirm over a concurrent write", async () => {
    divergeAfterNextMemorySelect(() => {
      setFixture({
        memory: [{ ...NOTE, content: "concurrent note", updated_at: "2026-10-28T15:00:00.000Z" }],
      });
    });
    const previewRes = await postMemory(
      authed(
        "http://x/api/memory",
        { content: "from the preview", key: "project/status", dry_run: true },
        "POST",
      ),
    );
    const preview = await previewRes.json();
    assert.equal(previewRes.status, 200);
    assert.equal(preview.changes[0].before.content, "old note");
    const selects = queries.filter((sql) => /from\s+memory/i.test(sql));
    assert.equal(selects.length, 1);
    assert.match(selects[0], /md5\(\s*m::text\s*\)/);
    assert.match(selects[0], /m\.\*/);
    const seen = preview.expected_revision as string;
    assert.equal(seen, stableRowRevision(NOTE));
    assert.notEqual(seen, stableRowRevision({ ...NOTE, content: "concurrent note", updated_at: "2026-10-28T15:00:00.000Z" }));

    resetSpy();
    const stale = await postMemory(
      authed(
        "http://x/api/memory",
        { content: "stale confirm", key: "project/status", expected_revision: seen },
        "POST",
      ),
    );
    const body = await stale.json();
    assert.equal(stale.status, 409, JSON.stringify(body));
    assert.equal(body.error, "stale_write");
    assert.equal(body.code, "stale_write");
    assert.equal(storedMemory()?.content, "concurrent note");
    assert.equal(body.current_revision, stableRowRevision(storedMemoryRow()));
    assert.notEqual(body.current_revision, seen);
    assert.equal(queries[0]?.includes("select"), false);
  });

  it("two racing absent-key confirms return one 200 and one 409", async () => {
    setFixture({ memory: [] });
    const previewRes = await postMemory(
      authed("http://x/api/memory", { content: "first", key: "race/absent", dry_run: true }, "POST"),
    );
    const preview = await previewRes.json();
    assert.equal(previewRes.status, 200);
    assert.equal(preview.action, "insert_memory");
    const seen = preview.expected_revision as string;
    assert.equal(seen, "absent");
    resetSpy();
    armReadCommittedInsertRace();

    const responses = await Promise.all([
      postMemory(
        authed("http://x/api/memory", { content: "race-a", key: "race/absent", expected_revision: seen }, "POST"),
      ),
      postMemory(
        authed("http://x/api/memory", { content: "race-b", key: "race/absent", expected_revision: seen }, "POST"),
      ),
    ]);
    const bodies = await Promise.all(responses.map((res) => res.json()));
    const statuses = responses.map((res) => res.status).sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify(bodies));
    assert.equal(responses.some((res) => res.status === 500), false);
    assert.equal(bodies.filter((body) => body.error === "stale_write").length, 1);
    assert.equal(bodies.filter((body) => body.ok === true).length, 1);
    const stored = JSON.parse(fixtureSnapshot()).memory as { key: string; content: string }[];
    assert.equal(stored.filter((row) => row.key === "race/absent").length, 1);
    const winner = bodies.find((body) => body.ok === true);
    assert.equal(stored.find((row) => row.key === "race/absent")?.content, winner.item.content);
    const inserts = writes.filter((sql) => /insert\s+into\s+memory/i.test(sql));
    assert.equal(inserts.length, 2);
    for (const sql of inserts) {
      assert.match(sql, /on conflict \(key\) do nothing/i);
      assert.doesNotMatch(sql, /where\s+not\s+exists/i);
    }
  });
});
