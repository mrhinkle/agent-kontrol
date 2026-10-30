import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createCredential } from "../src/lib/credentials";
import { sql } from "../src/lib/db";
import { insertGhEvent } from "../src/lib/gh-events";
import { acquireStream, cursorPosition, EventStreamError, readStreamBatch, registerStreamConsumer, streamCursor } from "../src/lib/events-stream";
import { GET } from "../src/app/api/events/stream/route";
import { POST } from "../src/app/api/events/consumers/route";

export async function runEventStreamTests(): Promise<void> {
  const prefix = `stream-${randomUUID()}`;
  const a = `${prefix}-a`, b = `${prefix}-b`;
  const repo = `test/${prefix}`;
  const oldToken = process.env.MC_TOKEN;
  process.env.MC_TOKEN = "stream-test-operator";
  const credentialIds: string[] = [];
  const slow = new Client({ connectionString: process.env.DATABASE_URL });
  let slowOpen = false;
  const forbidden = (e: unknown) => e instanceof EventStreamError && e.status === 403;
  const credential = async (scopes: string[]) => {
    const c = await createCredential({ label: prefix, scopes, rate_limit_per_minute: 1000 });
    assert.ok(c.ok);
    credentialIds.push(c.credential.id);
    return c;
  };
  try {
    const ca = await credential(["events:read"]), cb = await credential(["events:read"]);
    const wrongScope = await credential(["tasks:read"]);
    const registration = { id: a, credential_id: ca.credential.id, repos: [repo], event_types: ["status"], enabled: true };
    const register = await POST(new Request("http://localhost/api/events/consumers", { method: "POST",
      headers: { authorization: "Bearer stream-test-operator", "content-type": "application/json" }, body: JSON.stringify(registration) }));
    assert.equal(register.status, 200);
    await registerStreamConsumer({ ...registration, id: b, credential_id: cb.credential.id });

    // An events:read credential cannot grant itself a broader consumer binding.
    const selfRegister = await POST(new Request("http://localhost/api/events/consumers", { method: "POST",
      headers: { authorization: `Bearer ${ca.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...registration, repos: ["other/private"] }) }));
    assert.equal(selfRegister.status, 403);
    const noScope = await GET(new Request(`http://localhost/api/events/stream?consumer=${a}`, { headers: { authorization: `Bearer ${wrongScope.token}` } }));
    assert.equal(noScope.status, 403);
    const wrongConsumer = await GET(new Request(`http://localhost/api/events/stream?consumer=${a}`, { headers: { authorization: `Bearer ${cb.token}` } }));
    assert.equal(wrongConsumer.status, 403);
    const foreignCursor = await GET(new Request(`http://localhost/api/events/stream?consumer=${b}&since=${encodeURIComponent(streamCursor(a, "1"))}`,
      { headers: { authorization: `Bearer ${cb.token}` } }));
    assert.equal(foreignCursor.status, 403);

    let generation = await acquireStream(a, ca.credential.id);
    assert.deepEqual(await readStreamBatch(a, ca.credential.id, generation, "0"), { expired: false, events: [] });
    const insert = async (suffix: string, event = "status", eventRepo = repo) => {
      const out = await insertGhEvent({ delivery_id: `${prefix}-${suffix}`, event, repo: eventRepo, payload: { marker: suffix } });
      assert.ok(out.stored);
      return out.id;
    };
    const first = await insert("first");
    const hidden = await insert("other-repo", "status", `private/${prefix}`);
    await insert("other-type", "push");
    const second = await insert("second");
    let rows = await readStreamBatch(a, ca.credential.id, generation, "0");
    assert.deepEqual(rows.events.map(e => e.id), [first]);
    assert.deepEqual(rows.events[0].payload, { marker: "first" });
    assert.equal((await readStreamBatch(a, ca.credential.id, generation, first)).events[0].id, second);
    assert.deepEqual((await readStreamBatch(a, ca.credential.id, generation, second)).events, []);
    // Lost response/old acknowledged cursor deliberately replays the event.
    assert.equal((await readStreamBatch(a, ca.credential.id, generation, first)).events[0].id, second);
    await assert.rejects(readStreamBatch(a, cb.credential.id, generation, "0"), forbidden);
    await assert.rejects(readStreamBatch(a, ca.credential.id, generation, hidden), forbidden);
    assert.throws(() => cursorPosition(b, streamCursor(a, first)), forbidden);

    // The wire id is text, but ordering must use the underlying bigint column.
    // These different-width ids also exceed JavaScript's exact integer range;
    // explicit test-only rows leave the real inbox sequence untouched.
    const bigintRepo = `test/${prefix}-bigint`;
    await registerStreamConsumer({ ...registration, id: b, credential_id: cb.credential.id, repos: [bigintRepo] });
    const bigintGeneration = await acquireStream(b, cb.credential.id);
    const lower = "9007199254740993", higher = "10000000000000000";
    await sql()`insert into gh_events(id, delivery_id, event, repo, payload) values
      (${lower}::bigint, ${prefix + "-bigint-low"}, 'status', ${bigintRepo}, '{}'::jsonb),
      (${higher}::bigint, ${prefix + "-bigint-high"}, 'status', ${bigintRepo}, '{}'::jsonb)`;
    assert.equal((await readStreamBatch(b, cb.credential.id, bigintGeneration, "0")).events[0].id, lower);
    assert.equal((await readStreamBatch(b, cb.credential.id, bigintGeneration, lower)).events[0].id, higher);
    await registerStreamConsumer({ ...registration, id: b, credential_id: cb.credential.id });

    // Drive the real authenticated route and cancel without waiting for the 240s cap.
    const stream = await GET(new Request(`http://localhost/api/events/stream?consumer=${a}&since=${encodeURIComponent(streamCursor(a, first))}`,
      { headers: { authorization: `Bearer ${ca.token}` } }));
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.match(frame, new RegExp(`id: ${a}:${second}`));
    assert.doesNotMatch(frame, /other-repo|other-type/);
    await reader.cancel();

    const previousGeneration = await acquireStream(a, ca.credential.id);
    generation = await acquireStream(a, ca.credential.id);
    assert.notEqual(previousGeneration, generation);
    await assert.rejects(readStreamBatch(a, ca.credential.id, previousGeneration, second), (e: unknown) => e instanceof EventStreamError && e.code === "superseded");

    // A lower sequence id can still be uncommitted when a higher id is visible.
    // Without the SHARE barrier the first read returns high and permanently skips low.
    await slow.connect();
    slowOpen = true;
    await slow.query("begin");
    const low = await slow.query("insert into gh_events(delivery_id,event,repo,payload) values($1,'status',$2,$3::jsonb) returning id::text as id",
      [`${prefix}-slow`, repo, JSON.stringify({ marker: "slow" })]);
    const high = await insert("fast");
    const pending = readStreamBatch(a, ca.credential.id, generation, second);
    // Observe an actual ungranted SHARE lock, rather than guessing from a sleep.
    let waiting = false;
    const deadline = Date.now() + 800;
    while (Date.now() < deadline && !waiting) {
      const locks = await sql()`select 1 from pg_locks where relation = 'gh_events'::regclass and mode = 'ShareLock' and not granted`;
      waiting = locks.length > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
    }
    await slow.query("commit");
    rows = await pending;
    assert.ok(waiting, "reader must wait for the uncommitted low-id writer");
    assert.equal(rows.events[0].id, String(low.rows[0].id));
    assert.equal((await readStreamBatch(a, ca.credential.id, generation, rows.events[0].id)).events[0].id, high);

    await sql()`delete from gh_events where id = ${first}::bigint`;
    assert.deepEqual(await readStreamBatch(a, ca.credential.id, generation, first), { expired: true, events: [] });
    await registerStreamConsumer({ ...registration, enabled: false });
    await assert.rejects(acquireStream(a, ca.credential.id), forbidden);
    await registerStreamConsumer(registration);
    generation = await acquireStream(a, ca.credential.id);
    await sql()`update agent_credentials set revoked_at = clock_timestamp() where id = ${ca.credential.id}`;
    await assert.rejects(readStreamBatch(a, ca.credential.id, generation, "0"), forbidden);
    const bGeneration = await acquireStream(b, cb.credential.id);
    await sql()`update agent_credentials set scopes = array['tasks:read'] where id = ${cb.credential.id}`;
    await assert.rejects(readStreamBatch(b, cb.credential.id, bGeneration, "0"), forbidden);
    await sql()`update agent_credentials set scopes = array['events:read'] where id = ${cb.credential.id}`;
    await sql()`update agent_credentials set expires_at = clock_timestamp() - interval '1 second' where id = ${cb.credential.id}`;
    await assert.rejects(acquireStream(b, cb.credential.id), forbidden);
    console.log("test:pg consumer stream: credential/filter isolation, replay, commit-order race, generation fencing, expiry and revocation passed");
  } finally {
    if (slowOpen) { await slow.query("rollback").catch(() => {}); await slow.end(); }
    await sql()`delete from event_stream_consumers where id = ${a} or id = ${b}`;
    await sql()`delete from gh_events where delivery_id like ${prefix + "%"}`;
    if (credentialIds.length) await sql()`delete from agent_credentials where id = any(${credentialIds}::text[])`;
    if (oldToken === undefined) delete process.env.MC_TOKEN; else process.env.MC_TOKEN = oldToken;
  }
}
