#!/usr/bin/env node
/**
 * Read-only query helper for the bridge end-to-end runner (#213, epic #62).
 *
 * Protocol (L5): exactly one JSON request object on stdin, exactly one JSON
 * response object on stdout.
 *   request:  {"query": <name>, "parameters": [...]}
 *   success:  {"ok": true, "query": <name>, "sql": <text>, "row_count": N, "rows": [...]}
 *   failure:  {"ok": false, "error": <fixed code>}
 * Exit status is 0 for {ok:true} and 1 for {ok:false}. The connection string
 * is read from DATABASE_URL and is never printed.
 *
 * Query table (M4). Every query is one fixed, parameterized SELECT. The helper
 * validates parameter types and every returned row's shape. It does not
 * interpret counts: zero rows and several rows are both returned as data, and
 * the runner decides what count each assertion requires.
 *
 * | name         | parameters ($n: name type)                        | row schema                                                                 | runner's count rule                     |
 * |--------------|---------------------------------------------------|----------------------------------------------------------------------------|-----------------------------------------|
 * | marker       | $1 agent_id text, $2 marker text                  | id text, kind text, agent_id text, marker text, principal_kind text|null, principal_id text|null | exactly 1                     |
 * | task         | $1 created_by text, $2 project text, $3 title text| id text, title, description, project, platform, machine text|null, priority int, status, created_by, reviewer_platform text|null | filtered by authority and node; exactly 1 bound task (0 for bad_input) |
 * | create_event | $1 task_id text                                   | id text, kind text, title text, task_id text                               | exactly 1                               |
 * | work_event   | $1 task_id bigint (decimal text), $2 title text   | id text, kind, title, task_id jsonb number, principal_kind, principal_id, agent_id | exactly 1                   |
 * | idempotency  | $1 idempotency_key text                           | scope text, idempotency_key text, completed bool, task_id text|null (the stored task's id) | exactly 1, task_id = bound id |
 * | status       | $1 task_id bigint (decimal text)                  | id text, status text, assigned_agent text|null, completed_at text|null     | exactly 1                               |
 *
 * The work_event predicate is the spec's exact one:
 *   kind = 'status' AND detail->'task_id' = to_jsonb($1::bigint)
 *   AND title = format('Running task #%s: %s', $1, $2)
 *   AND principal_kind = 'legacy' AND principal_id = 'mc-token'
 * The claim receipt ("Claimed task #N: ...", string task_id) and the PATCH
 * rows never match it.
 */
import pg from "pg";

const TEXT = "text";
const BIGINT = "bigint";

const QUERIES = {
  marker: {
    params: [TEXT, TEXT],
    sql:
      "select id::text as id, kind, agent_id, detail->>'marker' as marker, principal_kind, principal_id " +
      "from events where kind = 'status' and agent_id = $1 and detail->>'marker' = $2 order by id",
    shape: { id: "string", kind: "string", agent_id: "string", marker: "string", principal_kind: "string?", principal_id: "string?" },
  },
  task: {
    params: [TEXT, TEXT, TEXT],
    sql:
      "select id::text as id, title, description, project, platform, machine, priority, status, created_by, reviewer_platform " +
      "from tasks where created_by = $1 and project = $2 and title = $3 order by id",
    shape: {
      id: "string", title: "string", description: "string?", project: "string?", platform: "string",
      machine: "string?", priority: "number", status: "string", created_by: "string?", reviewer_platform: "string?",
    },
  },
  create_event: {
    params: [TEXT],
    sql:
      "select id::text as id, kind, title, detail->>'task_id' as task_id " +
      "from events where kind = 'create_task' and detail->>'task_id' = $1::text order by id",
    shape: { id: "string", kind: "string", title: "string?", task_id: "string" },
  },
  work_event: {
    params: [BIGINT, TEXT],
    sql:
      "select id::text as id, kind, title, detail->'task_id' as task_id, principal_kind, principal_id, agent_id " +
      "from events where kind = 'status' and detail->'task_id' = to_jsonb($1::bigint) " +
      "and title = format('Running task #%s: %s', $1::bigint, $2::text) " +
      "and principal_kind = 'legacy' and principal_id = 'mc-token' order by id",
    shape: { id: "string", kind: "string", title: "string", task_id: "number", principal_kind: "string", principal_id: "string", agent_id: "string?" },
  },
  idempotency: {
    params: [TEXT],
    sql:
      "select scope, idempotency_key, (response is not null) as completed, " +
      "response->>'id' as task_id " +
      "from idempotency_keys where idempotency_key = $1 order by scope",
    shape: { scope: "string", idempotency_key: "string", completed: "boolean", task_id: "string?" },
  },
  status: {
    params: [BIGINT],
    sql:
      "select id::text as id, status, assigned_agent, completed_at::text as completed_at " +
      "from tasks where id = $1::bigint",
    shape: { id: "string", status: "string", assigned_agent: "string?", completed_at: "string?" },
  },
};

function reply(body, code) {
  process.stdout.write(JSON.stringify(body) + "\n");
  process.exitCode = code;
}

function fail(error) {
  reply({ ok: false, error }, 1);
}

function validParams(types, values) {
  if (!Array.isArray(values) || values.length !== types.length) return false;
  return types.every((type, i) => {
    const v = values[i];
    if (typeof v !== "string" || v.length === 0 || v.length > 4096 || v.includes("\0")) return false;
    return type === BIGINT ? /^[1-9][0-9]{0,15}$/.test(v) : true;
  });
}

function validRow(shape, row) {
  const keys = Object.keys(shape);
  if (Object.keys(row).length !== keys.length) return false;
  return keys.every((key) => {
    if (!(key in row)) return false;
    const want = shape[key];
    const value = row[key];
    if (want.endsWith("?") && value === null) return true;
    return typeof value === want.replace("?", "");
  });
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) throw new Error("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch {
    return fail("invalid_request");
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) return fail("invalid_request");
  if (Object.keys(request).sort().join(",") !== "parameters,query") return fail("invalid_request");
  const spec = Object.prototype.hasOwnProperty.call(QUERIES, request.query) ? QUERIES[request.query] : null;
  if (!spec) return fail("unknown_query");
  if (!validParams(spec.params, request.parameters)) return fail("invalid_parameters");
  if (!process.env.DATABASE_URL) return fail("no_database");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
  } catch {
    await client.end().catch(() => {});
    return fail("connect_failed");
  }
  try {
    await client.query("set statement_timeout = 15000");
    await client.query("begin read only");
    const result = await client.query(spec.sql, request.parameters);
    await client.query("rollback");
    if (!result.rows.every((row) => validRow(spec.shape, row))) return fail("unexpected_row_shape");
    reply({ ok: true, query: request.query, sql: spec.sql, row_count: result.rows.length, rows: result.rows }, 0);
  } catch {
    fail("query_failed");
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(() => fail("internal"));
