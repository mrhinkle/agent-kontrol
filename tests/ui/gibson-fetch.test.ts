import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fetchGibsonTasks, GIBSON_TASK_PAGE_SIZE } from "../../src/lib/gibson-fetch";
import { LIST_MAX, parseSearchList, TASK_REST } from "../../src/lib/list-params";
import { GET } from "../../src/app/api/tasks/route";
import type { Task } from "../../src/lib/types";

const saved = { ...process.env };
afterEach(() => { for (const key of ["NODE_ENV", "MC_TOKEN", "MC_DASHBOARD_PASSWORD", "DATABASE_URL"]) {
  if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
} });
const task = (id: number) => ({ id } as Task);

test("reproduces rejected old URL and loads the real tasks route with valid limits", async () => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  delete process.env.MC_TOKEN; delete process.env.MC_DASHBOARD_PASSWORD; delete process.env.DATABASE_URL;
  const old = await GET(new Request("https://dashboard.example/api/tasks?status=all&limit=400"));
  assert.equal(old.status, 400);
  assert.match((await old.json()).error, /1 to 200/);
  assert.ok(GIBSON_TASK_PAGE_SIZE <= LIST_MAX);
  const result = await fetchGibsonTasks(async (input) => {
    const request = new Request(new URL(String(input), "https://dashboard.example"));
    assert.doesNotThrow(() => parseSearchList(TASK_REST, new URL(request.url).searchParams));
    return GET(request);
  });
  assert.ok(result.tasks.length > 0);
  assert.equal(result.demo, true);
});

test("follows the cursor and retains all 400 tasks with only two bounded reads", async () => {
  const requests: string[] = [];
  const result = await fetchGibsonTasks(async (input, init) => {
    const url = new URL(String(input), "https://dashboard.example");
    requests.push(url.href);
    assert.equal(url.searchParams.get("limit"), "200");
    assert.equal(url.searchParams.get("status"), "all");
    assert.equal(init?.cache, "no-store");
    if (requests.length === 1) return Response.json({ tasks: Array.from({ length: 200 }, (_, n) => task(n)), next_cursor: "opaque+cursor/=" });
    assert.equal(url.searchParams.get("cursor"), "opaque+cursor/=");
    return Response.json({ tasks: Array.from({ length: 200 }, (_, n) => task(n + 200)), next_cursor: "more" });
  });
  assert.equal(requests.length, 2);
  assert.equal(result.tasks.length, 400);
  assert.equal(result.tasks[399].id, 399);
});

test("empty/single pages stop without unnecessary requests", async () => {
  for (const tasks of [[], [task(1)]]) {
    let calls = 0;
    const result = await fetchGibsonTasks(async () => { calls++; return Response.json({ tasks, next_cursor: null }); });
    assert.equal(calls, 1); assert.deepEqual(result.tasks, tasks);
  }
});

test("any failed page rejects the whole poll instead of replacing good data with a partial result", async () => {
  for (const failure of [1, 2]) {
    let calls = 0;
    await assert.rejects(fetchGibsonTasks(async () => {
      calls++;
      return calls === failure ? Response.json({}, { status: 503 }) : Response.json({ tasks: [task(1)], next_cursor: "more" });
    }), /tasks API 503/);
  }
});
