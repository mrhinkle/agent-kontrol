import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { GET as getTasks } from "../../src/app/api/tasks/route";
import { GET as getMemory } from "../../src/app/api/memory/route";
import { GET as getTraces } from "../../src/app/api/traces/route";
import { demoMemory, demoTasks } from "../../src/lib/demo-data";
import { demoSpans, demoSummary } from "../../src/lib/demo-traces";
import {
  DEMO_BANNER,
  demoCreateTask,
  demoRecallTool,
  demoRemember,
  demoTaskQueueTool,
  resetDemoStoreForTests,
  setDemoClockForTests,
} from "../../src/lib/demo-store";
import { recallResult, taskQueueResult } from "../../src/lib/list-read";
import {
  CURSOR_MESSAGE,
  FIELDS_MESSAGE,
  LIMIT_MESSAGE,
  MEMORY_REST,
  TASK_REST,
  TRACE_LIST,
  encodeCursor,
  pageRows,
  parseToolList,
  projectFields,
} from "../../src/lib/list-params";

/**
 * Failure cases for list cursors. Each `it` tries to break the page, the
 * allowlist, or the promise that callers who omit the new parameters see
 * the same body as before.
 */

const saved = {
  db: process.env.DATABASE_URL,
  pw: process.env.MC_DASHBOARD_PASSWORD,
};

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.MC_DASHBOARD_PASSWORD;
  resetDemoStoreForTests();
  setDemoClockForTests(null);
});

afterEach(() => {
  if (saved.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = saved.db;
  if (saved.pw === undefined) delete process.env.MC_DASHBOARD_PASSWORD;
  else process.env.MC_DASHBOARD_PASSWORD = saved.pw;
  resetDemoStoreForTests();
  setDemoClockForTests(null);
});

function shape(value: unknown): unknown {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return "#time";
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = shape(inner);
    return out;
  }
  return value;
}

async function read(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function idsOf(body: Record<string, unknown>, key: string): unknown[] {
  const rows = body[key] as { id?: unknown; trace_id?: unknown }[];
  return rows.map((row) => row.trace_id ?? row.id);
}

describe("list cursors", () => {
  it("F1 tasks: no new params matches the current demo sample", async () => {
    const plain = await read(await getTasks(new Request("http://localhost/api/tasks")));
    const filtered = await read(await getTasks(new Request("http://localhost/api/tasks?status=queued")));
    const expected = { demo: true, tasks: demoTasks() };
    assert.equal(plain.status, 200);
    assert.deepEqual(Object.keys(plain.body), ["demo", "tasks"]);
    assert.equal("next_cursor" in plain.body, false);
    assert.deepEqual(shape(plain.body), shape(expected));
    assert.deepEqual(shape(filtered.body), shape(expected));
    assert.deepEqual(idsOf(plain.body, "tasks"), demoTasks().map((task) => task.id));
  });

  it("F1 memory: no new params matches the current demo sample", async () => {
    const plain = await read(await getMemory(new Request("http://localhost/api/memory")));
    const filtered = await read(await getMemory(new Request("http://localhost/api/memory?query=nope&tag=nope")));
    const expected = { demo: true, items: demoMemory() };
    assert.equal(plain.status, 200);
    assert.deepEqual(Object.keys(plain.body), ["demo", "items"]);
    assert.equal("next_cursor" in plain.body, false);
    assert.deepEqual(shape(plain.body), shape(expected));
    assert.deepEqual(shape(filtered.body), shape(expected));
  });

  it("F1 traces: no new params matches the current demo sample", async () => {
    const plain = await read(await getTraces(new Request("http://localhost/api/traces")));
    const filtered = await read(await getTraces(new Request("http://localhost/api/traces?before=not-a-date&agent=nobody&errors=1")));
    const expected = { demo: true, traces: [demoSummary(demoSpans())] };
    assert.equal(plain.status, 200);
    assert.deepEqual(Object.keys(plain.body), ["demo", "traces"]);
    assert.equal("next_cursor" in plain.body, false);
    assert.deepEqual(shape(plain.body), shape(expected));
    assert.deepEqual(shape(filtered.body), shape(expected));
  });

  it("F2: a page walk returns every original row once when a row is inserted between pages", async () => {
    const rows = [
      { id: 1, updated_at: "2026-01-01T00:00:03.000Z" },
      { id: 2, updated_at: "2026-01-01T00:00:02.000Z" },
      { id: 3, updated_at: "2026-01-01T00:00:01.000Z" },
    ];
    const seen: number[] = [];
    let cursor: string | undefined;
    let inserted = false;
    for (let n = 0; n < 6; n++) {
      const parsed = parseToolList(MEMORY_REST, cursor === undefined ? { limit: 2 } : { limit: 2, cursor });
      const page = pageRows(rows, parsed);
      seen.push(...page.rows.map((row) => Number(row.id)));
      if (!inserted) {
        rows.push({ id: 99, updated_at: "2026-01-01T00:00:09.000Z" });
        rows.push({ id: 98, updated_at: "2026-01-01T00:00:01.500Z" });
        inserted = true;
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    assert.deepEqual(seen, [1, 2, 98, 3]);
    assert.equal(seen.includes(99), false);
    assert.equal(new Set(seen).size, seen.length);

    resetDemoStoreForTests();
    const base = Date.UTC(2026, 0, 1);
    const at = (i: number) => base + i * 1000;
    setDemoClockForTests(() => at(0));
    const older = await demoCreateTask({ title: "older" });
    setDemoClockForTests(() => at(1));
    const mid = await demoCreateTask({ title: "mid" });
    setDemoClockForTests(() => at(2));
    const newer = await demoCreateTask({ title: "newer" });
    const first = await taskQueueResult({ status: "all", limit: 2, fields: "id" }, false);
    const firstPage = toolPage(first);
    setDemoClockForTests(() => at(5));
    const front = await demoCreateTask({ title: "inserted-front" });
    setDemoClockForTests(() => at(1) - 100);
    const gap = await demoCreateTask({ title: "inserted-gap" });
    const second = await taskQueueResult({ status: "all", limit: 2, fields: "id", cursor: firstPage.next }, false);
    const secondPage = toolPage(second);
    assert.deepEqual(firstPage.ids, [newer.id, mid.id]);
    assert.deepEqual(secondPage.ids, [gap.id, older.id]);
    assert.equal(secondPage.next, null);
    assert.equal([...firstPage.ids, ...secondPage.ids].includes(front.id), false);
  });

  it("F3: a tampered cursor is 400, and a cursor past the end is an empty page", async () => {
    const first = await read(await getTasks(new Request("http://localhost/api/tasks?limit=2")));
    const firstIds = idsOf(first.body, "tasks");
    assert.equal(firstIds.length, 2);
    const attacks = [
      "%%%",
      "",
      "abc",
      "not a cursor",
      Buffer.from("null", "utf8").toString("base64url"),
      Buffer.from("[]", "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ r: "task", k: ["queued", 1, "2026-01-01T00:00:00.000Z"], id: "1;drop" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ r: "task", k: ["queued", 1, "2026-01-01T00:00:00.000Z"], id: "1", extra: true }), "utf8").toString("base64url"),
      encodeCursor(MEMORY_REST, { id: 1, updated_at: "2026-01-01T00:00:00.000Z" }),
      `${encodeCursor(TASK_REST, { id: 4, status: "queued", priority: 1, updated_at: "2026-01-01T00:00:00.000Z" })}A`,
    ];
    for (const cursor of attacks) {
      const res = await read(await getTasks(new Request(`http://localhost/api/tasks?cursor=${encodeURIComponent(cursor)}`)));
      assert.equal(res.status, 400, cursor);
      assert.equal(res.body.code, "validation_failed");
      assert.equal(res.body.error, CURSOR_MESSAGE);
      const text = JSON.stringify(res.body);
      assert.equal(text.includes("drop"), false);
      assert.equal(text.includes(String(firstIds[0])), false);
      assert.notDeepEqual(res.body.tasks, first.body.tasks);
    }
    const past = encodeCursor(TASK_REST, {
      id: 1,
      status: "zzzz",
      priority: 1,
      updated_at: "2099-01-01T00:00:00.000Z",
    });
    const end = await read(await getTasks(new Request(`http://localhost/api/tasks?cursor=${encodeURIComponent(past)}`)));
    assert.equal(end.status, 200);
    assert.deepEqual(end.body.tasks, []);
    assert.equal(end.body.next_cursor, null);
    assert.notDeepEqual(idsOf(end.body, "tasks"), firstIds);
  });

  it("F4: limit 0, negative, non-integer, and above 200 are 400", async () => {
    const bad = ["0", "-1", "1.5", "201", "abc", "01", "+10", "", "1e2", "200.0", " 1"];
    const routes = [
      ["http://localhost/api/tasks", getTasks],
      ["http://localhost/api/memory", getMemory],
      ["http://localhost/api/traces", getTraces],
    ] as const;
    for (const [base, get] of routes) {
      for (const limit of bad) {
        const res = await read(await get(new Request(`${base}?limit=${encodeURIComponent(limit)}`)));
        assert.equal(res.status, 400, `${base} ${limit}`);
        assert.equal(res.body.code, "validation_failed");
        assert.equal(res.body.error, LIMIT_MESSAGE);
        assert.equal(JSON.stringify(res.body).includes("1.5"), false);
        assert.equal(JSON.stringify(res.body).includes("drop"), false);
      }
    }
    const ok = await read(await getTasks(new Request("http://localhost/api/tasks?limit=200")));
    assert.equal(ok.status, 200);
    assert.equal("next_cursor" in ok.body, true);
    const toolBad = [0, -1, 1.5, 201, Number.NaN, Number.POSITIVE_INFINITY];
    for (const limit of toolBad) {
      const result = await taskQueueResult({ limit }, false);
      assert.equal(result.isError, true);
      const body = JSON.parse(result.content[0].text) as { code: string; error: string };
      assert.equal(body.code, "validation_failed");
      assert.equal(body.error, LIMIT_MESSAGE);
    }
  });

  it("F5: unknown, empty, and injection-like fields are 400 and never return a secret column", async () => {
    const attacks = ["token_hash", "credential_hash", "", "id,", "id,,title", "ID", "id;drop table tasks", "*", "id,token_hash", " title , nope "];
    for (const fields of attacks) {
      const res = await read(await getTasks(new Request(`http://localhost/api/tasks?fields=${encodeURIComponent(fields)}`)));
      assert.equal(res.status, 400, fields);
      assert.equal(res.body.code, "validation_failed");
      assert.equal(res.body.error, FIELDS_MESSAGE);
      const text = JSON.stringify(res.body);
      assert.equal(text.includes("token_hash"), false);
      assert.equal(text.includes("credential_hash"), false);
      assert.equal(text.includes("drop"), false);
    }
    const row = {
      id: 7,
      title: "visible",
      description: "hidden-by-fields",
      token_hash: "sekret-token",
      credential_hash: "sekret-hash",
      status: "queued",
      priority: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const projected = projectFields(row, TASK_REST, ["title"]);
    assert.deepEqual(Object.keys(projected), ["id", "title"]);
    assert.equal(JSON.stringify(projected).includes("sekret"), false);
    assert.equal(JSON.stringify(projected).includes("hidden-by-fields"), false);

    const selected = await read(await getTasks(new Request("http://localhost/api/tasks?fields=title,id")));
    assert.equal(selected.status, 200);
    assert.equal("next_cursor" in selected.body, false);
    const tasks = selected.body.tasks as Record<string, unknown>[];
    assert.deepEqual(Object.keys(tasks[0]), ["id", "title"]);
    assert.equal(JSON.stringify(tasks).includes("token_hash"), false);
    assert.equal(JSON.stringify(tasks).includes("Shipped"), false);
  });

  it("F6: equal timestamps page by id, numeric for tasks and memory", () => {
    const when = "2026-06-01T00:00:00.000Z";
    const memory = [
      { id: "10", updated_at: when },
      { id: 2, updated_at: when },
    ];
    const first = pageRows(memory, parseToolList(MEMORY_REST, { limit: 1 }));
    const second = pageRows(memory, parseToolList(MEMORY_REST, { limit: 1, cursor: first.next_cursor }));
    assert.deepEqual(first.rows.map((row) => String(row.id)), ["2"]);
    assert.deepEqual(second.rows.map((row) => String(row.id)), ["10"]);
    assert.equal(second.next_cursor, null);

    const tasks = [
      { id: 10, status: "queued", priority: 2, updated_at: when },
      { id: 2, status: "queued", priority: 2, updated_at: when },
    ];
    const taskPage = pageRows(tasks, parseToolList(TASK_REST, { limit: 1 }));
    const taskNext = pageRows(tasks, parseToolList(TASK_REST, { limit: 1, cursor: taskPage.next_cursor }));
    assert.deepEqual(taskPage.rows.map((row) => row.id), [2]);
    assert.deepEqual(taskNext.rows.map((row) => row.id), [10]);

    const traceA = `${"a".repeat(30)}10`;
    const traceB = `${"a".repeat(31)}2`;
    const traces = [
      { trace_id: traceB, started_at: when },
      { trace_id: traceA, started_at: when },
    ];
    const tracePage = pageRows(traces, parseToolList(TRACE_LIST, { limit: 1 }));
    const traceNext = pageRows(traces, parseToolList(TRACE_LIST, { limit: 1, cursor: tracePage.next_cursor }));
    assert.equal(traceA < traceB, true);
    assert.deepEqual(tracePage.rows.map((row) => row.trace_id), [traceA]);
    assert.deepEqual(traceNext.rows.map((row) => row.trace_id), [traceB]);
  });

  it("F7: demo mode applies limit, cursor, and fields with the same rules", async () => {
    const queued = await read(await getTasks(new Request("http://localhost/api/tasks?status=queued&limit=10")));
    assert.equal(queued.status, 200);
    assert.deepEqual(idsOf(queued.body, "tasks"), [4]);
    assert.equal(queued.body.next_cursor, null);

    const open = await read(await getTasks(new Request("http://localhost/api/tasks?status=open&limit=1")));
    assert.deepEqual(idsOf(open.body, "tasks"), [4]);
    const openNext = await read(await getTasks(new Request(`http://localhost/api/tasks?status=open&limit=1&cursor=${encodeURIComponent(String(open.body.next_cursor))}`)));
    assert.deepEqual(idsOf(openNext.body, "tasks"), [3]);
    assert.equal(openNext.body.next_cursor, null);

    const walked: unknown[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 10; n++) {
      const url = cursor
        ? `http://localhost/api/tasks?limit=3&cursor=${encodeURIComponent(cursor)}`
        : "http://localhost/api/tasks?limit=3";
      const page = await read(await getTasks(new Request(url)));
      assert.equal(page.status, 200);
      walked.push(...idsOf(page.body, "tasks"));
      cursor = (page.body.next_cursor as string | null) ?? null;
      if (!cursor) break;
    }
    const expected = pageRows(demoTasks() as never, parseToolList(TASK_REST, { limit: 50 })).rows.map((row) => row.id);
    assert.deepEqual(walked, expected);
    assert.equal(new Set(walked).size, walked.length);

    const notes = await read(await getMemory(new Request("http://localhost/api/memory?query=Notion&limit=10")));
    assert.deepEqual(idsOf(notes.body, "items"), [2, 1]);
    const onlyId = await read(await getMemory(new Request("http://localhost/api/memory?fields=content&limit=1")));
    const item = (onlyId.body.items as Record<string, unknown>[])[0];
    assert.deepEqual(Object.keys(item), ["id", "content"]);

    const trace = await read(await getTraces(new Request("http://localhost/api/traces?limit=10&errors=1")));
    assert.equal((trace.body.traces as unknown[]).length, 1);
    assert.equal("next_cursor" in trace.body, true);
    const none = await read(await getTraces(new Request("http://localhost/api/traces?limit=10&agent=nobody")));
    assert.deepEqual(none.body.traces, []);
    assert.equal(none.body.next_cursor, null);
    const badBefore = await read(await getTraces(new Request("http://localhost/api/traces?limit=10&before=not-a-date")));
    assert.equal(badBefore.status, 400);
    assert.equal(badBefore.body.code, "validation_failed");
  });

  it("F8: recall and get_task_queue take the new params and keep the old call", async () => {
    const base = Date.UTC(2026, 5, 1);
    setDemoClockForTests(() => base);
    const task = await demoCreateTask({ title: "queue-row", project: "demo" });
    await demoRemember({ content: "remembered note", key: "cursor-key", tags: ["cursor"], agent_id: "grok" });

    const queueBare = await taskQueueResult({ status: "open" }, false);
    const queueTool = await demoTaskQueueTool({ status: "open" });
    assert.equal(queueBare.content[0].text, queueTool.content[0].text);
    assert.equal(queueBare.content[0].text.includes("next_cursor"), false);
    assert.match(queueBare.content[0].text, new RegExp(`#${task.id} \\[QUEUED\\]`));

    const recallBare = await recallResult({}, false);
    const recallTool = await demoRecallTool({});
    assert.equal(recallBare.content[0].text, recallTool.content[0].text);
    assert.equal(recallBare.content[0].text.includes("next_cursor"), false);
    assert.match(recallBare.content[0].text, /remembered note/);

    const paged = await taskQueueResult({ status: "all", limit: 1, fields: "id,title" }, false);
    assert.equal(paged.isError, undefined);
    assert.ok(paged.content[0].text.startsWith(`${DEMO_BANNER}\n`));
    const page = toolPage(paged);
    assert.deepEqual(page.ids, [task.id]);
    assert.equal(page.titles?.[0], "queue-row");
    assert.equal(page.next, null);
    assert.equal(paged.content[0].text.includes("project"), false);

    const recalled = await recallResult({ limit: 1, fields: "content" }, false);
    const recallPage = toolPage(recalled);
    assert.equal(recallPage.ids.length, 1);
    assert.match(recalled.content[0].text, /remembered note/);
    assert.equal(recalled.content[0].text.includes("cursor-key"), false);

    const rejected = await recallResult({ limit: 0 }, false);
    assert.equal(rejected.isError, true);
    assert.equal(JSON.parse(rejected.content[0].text).code, "validation_failed");
    const keyWins = await recallResult({ key: "", limit: 0, cursor: "%%%" }, false);
    assert.equal(JSON.parse(keyWins.content[0].text).code, "memory_key_invalid");

    const src = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const calls = src.match(/server\.registerTool\(/g)?.length ?? 0;
    const annotated = src.match(/^\s+annotations: (READ_ONLY|WRITE|WRITE_IDEMPOTENT|WRITE_DESTRUCTIVE),$/gm)?.length ?? 0;
    assert.equal(annotated, calls);
    for (const name of ["recall", "get_task_queue"]) {
      const start = src.indexOf(`"${name}"`);
      const slice = src.slice(start, start + 900);
      assert.match(slice, /annotations: READ_ONLY,/);
      assert.match(slice, /cursor: z\.string\(\)/);
      assert.match(slice, /fields: z\.string\(\)/);
      assert.equal(slice.includes(".max(100)"), false);
      assert.equal(slice.includes(".min(1)"), false);
    }
  });
});

function toolPage(result: { content: { text: string }[]; isError?: true }): { ids: number[]; titles?: string[]; next: string | null } {
  assert.equal(result.isError, undefined);
  const body = result.content[0].text.startsWith(`${DEMO_BANNER}\n`)
    ? result.content[0].text.slice(DEMO_BANNER.length + 1)
    : result.content[0].text;
  const lines = body.split("\n");
  const cursorLine = lines[lines.length - 1];
  assert.match(cursorLine, /^next_cursor: /);
  const nextRaw = cursorLine.slice("next_cursor: ".length);
  const rows = lines.slice(0, -1).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { id: number; title?: string });
  return {
    ids: rows.map((row) => row.id),
    titles: rows.map((row) => row.title).filter((title): title is string => typeof title === "string"),
    next: nextRaw === "null" ? null : nextRaw,
  };
}
