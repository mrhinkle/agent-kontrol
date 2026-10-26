import { fixtureSnapshot, queries, resetSpy, setFixture, setRejectWrites, writes } from "./dry-run-harness";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PUT as putRepos } from "../../src/app/api/settings/repos/route";
import { PATCH as patchTask } from "../../src/app/api/tasks/[id]/route";
import { POST as postMemory } from "../../src/app/api/memory/route";
import { rememberForTool, updateTaskForTool } from "../../src/lib/dry-run-actions";
import {
  changeDetails,
  diffMemoryWrite,
  diffRepoList,
  diffTaskUpdate,
  readDryRun,
  type DryRunChange,
} from "../../src/lib/dry-run";
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
  if (before === null) assert.equal(hasField(beforeLine, field), false, beforeLine);
  else assert.ok(hasSegment(beforeLine, field, before), beforeLine);
  if (after === null) assert.equal(hasField(afterLine, field), false, afterLine);
  else assert.ok(hasSegment(afterLine, field, after), afterLine);

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
      const value = record[key];
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

  it("keeps the demo-mode text when dry_run is omitted and writes nothing when it is set", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      resetSpy();
      const plain = await rememberForTool({ content: "nope", key: "project/status" });
      assert.equal(plain.content[0].text, "Demo mode; note not stored.");
      const preview = await rememberForTool({ content: "nope", key: "project/status", dry_run: true });
      const body = JSON.parse(preview.content[0].text);
      assert.equal(body.dry_run, true);
      assert.equal(body.would_write, false);
      assert.equal(body.applied, false);
      const task = await updateTaskForTool({ id: 7, status: "cancelled", dry_run: true });
      assert.equal(JSON.parse(task.content[0].text).would_write, false);
      const taskPlain = await updateTaskForTool({ id: 7, status: "done" });
      assert.equal(taskPlain.content[0].text, "Demo mode; task not updated.");
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
  });
});
