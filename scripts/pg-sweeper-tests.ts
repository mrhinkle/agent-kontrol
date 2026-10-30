/**
 * Absence sweeper (#79) against a real Postgres. Called from run-pg-tests.ts.
 *
 * The database clock is the only clock. Tests move it forward with
 * setSweepClockOffsetForTests, never backward: a latch evaluated at a later
 * instant is never overwritten, which is one of the properties under test.
 * Events keep the real now() in created_at, so moving the sweeper clock
 * forward ages them exactly as it ages stored evidence.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "pg";
import { sql } from "../src/lib/db";
import { createCredential } from "../src/lib/credentials";
import { runWithPrincipal } from "../src/lib/actor";
import { report } from "../src/lib/store";
import { setSweepClockOffsetForTests } from "../src/lib/sweep-clock";
import { readPaused, runSweep, type SweepRun } from "../src/lib/sweeper";
import { entityDigest, formatPausedLines, type SweepCondition } from "../src/lib/sweep-logic";
import { loadBrief, formatBriefText } from "../src/lib/brief";

const MIGRATION = "supabase/migrations/20261030013738_absence_sweeper.sql";
const MIN = 60_000;
const HOUR = 60 * MIN;

type Json = Record<string, unknown>;

export async function testSweeper(tag: string, applyCanonicalSchema: () => Promise<void>): Promise<void> {
  const saved = { token: process.env.MC_TOKEN, env: process.env.NODE_ENV, password: process.env.MC_DASHBOARD_PASSWORD };
  const env = process.env as Record<string, string | undefined>;
  const token = `pg-mc-token-${tag}`;
  env.MC_TOKEN = token;
  delete env.MC_DASHBOARD_PASSWORD;
  const { POST: ingestPost } = await import("../src/app/api/ingest/route");
  const { POST: sweepPost, GET: sweepGet } = await import("../src/app/api/sweep/route");
  const { POST: consumerPost } = await import("../src/app/api/sweep/consumers/route");

  let clock = 0;
  const advance = (ms: number) => {
    assert.ok(ms > 0, "the test clock only moves forward");
    clock += ms;
    setSweepClockOffsetForTests(clock);
  };
  const dbNow = async () => new Date((await sql()`select (clock_timestamp() + ${clock}::double precision * interval '1 millisecond') as now`)[0].now).toISOString();
  const isoAgo = async (ms: number) => new Date(new Date(await dbNow()).getTime() - ms).toISOString();
  const isoAhead = async (ms: number) => new Date(new Date(await dbNow()).getTime() + ms).toISOString();

  const req = (url: string, body: unknown, auth: string | null) => new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  const ingest = (kind: string, observation: unknown, auth: string | null = token) =>
    ingestPost(req("/api/ingest", { agent_id: `${tag}-collector`, kind, observation }, auth));
  const observe = async (kind: string, observation: unknown) => {
    const res = await ingest(kind, observation);
    const out = await res.json() as Json;
    assert.equal(res.status, 200, `${kind}: ${JSON.stringify(out)}`);
    return out;
  };
  const register = async (body: Json, auth: string | null = token) => {
    const res = await consumerPost(req("/api/sweep/consumers", body, auth));
    return { status: res.status, body: await res.json() as Json };
  };

  const latch = async (condition: SweepCondition, key: string) => {
    const rows = await sql()`
      select active, episode, seq, last_emitted_at::text as last_emitted_at, last_state, last_evaluated_at::text as last_evaluated_at
      from sweep_latches where condition = ${condition} and entity_key = ${key}
    `;
    return rows[0] ?? null;
  };
  const inbox = async (condition: SweepCondition, key: string) => {
    const digest = entityDigest(key);
    return sql()`
      select delivery_id, event, repo, number, head_sha, payload
      from gh_events
      where delivery_id like ${`sweep:${condition}:${digest}:%`} or delivery_id like ${`sweep:${condition}-cleared:${digest}:%`}
      order by id
    `;
  };
  const verdictOf = (run: SweepRun, condition: SweepCondition, key: string) =>
    run.checks.find((c) => c.check === condition)?.entities.find((e) => e.entity_key === key)?.verdict ?? null;
  const check = (run: SweepRun, condition: SweepCondition) => run.checks.find((c) => c.check === condition)!;

  const wipe = async () => {
    await sql()`delete from sweep_latches`;
    await sql()`delete from sweep_consumers`;
    await sql()`delete from scheduler_jobs`;
    await sql()`delete from sweep_queues`;
    await sql()`delete from sweep_prs`;
    await sql()`delete from sweep_pr_sources`;
    await sql()`delete from sweep_observations`;
    await sql()`delete from gh_events where delivery_id like 'sweep:%'`;
  };

  const credentialIds: string[] = [];
  try {
    // ------------------------------------------------ schema and migration
    await applyCanonicalSchema();
    await applyCanonicalSchema();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const migration = fs.readFileSync(MIGRATION, "utf8");
      await client.query(migration);
      await client.query(migration);
    } finally {
      await client.end();
    }
    const cols = await sql()`
      select table_name, column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'events' and column_name in ('principal_kind', 'principal_id')
    `;
    assert.equal(cols.length, 2);
    assert.ok(cols.every((c) => c.is_nullable === "YES"), "provenance columns are nullable");
    const tables = await sql()`
      select table_name from information_schema.tables where table_schema = 'public'
        and table_name in ('sweep_consumers', 'sweep_observations', 'scheduler_jobs', 'sweep_queues', 'sweep_pr_sources', 'sweep_prs', 'sweep_latches')
    `;
    assert.equal(tables.length, 7);
    await wipe();

    // ------------------------------------------------- empty registry
    {
      const run = await runSweep();
      for (const c of ["consumer-silent", "pr-stuck", "pause-unexplained", "pause-expired", "resume-uncited", "dispatch-ready-empty"] as const) {
        assert.equal(check(run, c).state, "not_configured", c);
        assert.equal(check(run, c).error, null);
        assert.ok(check(run, c).evaluated_at, "every check reports its database instant");
      }
      assert.equal(run.retention.state, "ok");
    }

    // ------------------------------------------ trusted-writer boundary
    const generic = await createCredential({ label: `${tag} generic`, scopes: ["status:write", "progress:read"] });
    const other = await createCredential({ label: `${tag} other`, scopes: ["status:write"] });
    assert.ok(generic.ok && other.ok);
    if (!generic.ok || !other.ok) return;
    credentialIds.push(generic.credential.id, other.credential.id);
    const pausedObs = { source: "mini", job_id: `${tag}-spoof`, state: "paused", transition: 1, observed_at: new Date().toISOString() };
    const counts = async () => Number((await sql()`select (select count(*) from sweep_observations) + (select count(*) from scheduler_jobs) + (select count(*) from sweep_queues) + (select count(*) from sweep_consumers) as n`)[0].n);
    const before = await counts();
    {
      const res = await ingest("sweep.scheduler_job", pausedObs, generic.token);
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as Json).code, "trusted_writer_required");
      const empty = await ingest("sweep.queue", { source: "x", queue: "issues:acme/a", classification: "issue_dispatch", seq: 1, observed_at: new Date().toISOString(), complete: true, ready: { count: 0 }, raw: { count: 0 } }, generic.token);
      assert.equal(empty.status, 403, "a generic credential cannot manufacture an empty queue");
      const condition = await ingestPost(req("/api/ingest", { agent_id: "x", kind: "pr-stuck-cleared" }, generic.token));
      assert.equal(condition.status, 403, "a synthetic event name is not telemetry");
      const bogus = await ingestPost(req("/api/ingest", { agent_id: "x", kind: "sweep.bogus" }, token));
      assert.equal(bogus.status, 400);
      assert.equal((await sweepPost(req("/api/sweep", {}, generic.token))).status, 403, "an agent credential cannot run the sweeper");
      const reg = await register({ id: `${tag}-spoof`, agent_ids: ["x"], reporters: [{ kind: "agent", id: "x" }], queue: { type: "tasks", platform: "codex" } }, generic.token);
      assert.equal(reg.status, 403);
      // dev-open: no MC_TOKEN, NODE_ENV test, no credential. Allowed for telemetry, never for evidence.
      delete env.MC_TOKEN;
      env.NODE_ENV = "test";
      const open = await ingest("sweep.scheduler_job", pausedObs, null);
      assert.equal(open.status, 403);
      assert.equal((await sweepPost(req("/api/sweep", {}, null))).status, 401, "an open dashboard is not an operator");
      assert.equal((await register({ id: `${tag}-open`, agent_ids: ["x"], reporters: [{ kind: "agent", id: "x" }], queue: { type: "tasks", platform: "codex" } }, null)).status, 401);
      const devEvent = await ingestPost(req("/api/ingest", { agent_id: `${tag}-dev`, kind: "milestone", title: "dev" }, null));
      assert.equal(devEvent.status, 200, "ordinary telemetry keeps working");
      env.MC_TOKEN = token;
      env.NODE_ENV = saved.env;
      const devRow = await sql()`select principal_kind, principal_id from events where agent_id = ${`${tag}-dev`}`;
      assert.equal(devRow[0].principal_kind, null, "dev-open stores no provenance");
      assert.equal(await counts(), before, "refused evidence writes nothing");
    }
    {
      // Provenance comes from authentication, not from the body.
      const res = await ingestPost(req("/api/ingest", {
        agent_id: `${tag}-prov`, kind: "milestone", title: "t", principal_kind: "legacy", principal_id: "mc-token",
      }, generic.token));
      assert.equal(res.status, 200);
      const row = await sql()`select principal_kind, principal_id from events where agent_id = ${`${tag}-prov`}`;
      assert.deepEqual({ ...row[0] }, { principal_kind: "agent", principal_id: generic.credential.id });
      await report({ agent_id: `${tag}-mcp`, kind: "status", title: "mcp" }, undefined);
      await runWithPrincipal({ kind: "oauth", id: `${tag}-client` }, () => report({ agent_id: `${tag}-mcp`, kind: "status", title: "mcp" }));
      const mcp = await sql()`select principal_kind, principal_id from events where agent_id = ${`${tag}-mcp`} order by id`;
      assert.deepEqual(mcp.map((r) => [r.principal_kind, r.principal_id]), [[null, null], ["oauth", `${tag}-client`]]);
    }
    {
      // Validation runs before any write.
      const before2 = await counts();
      const bad = await ingest("sweep.scheduler_job", { ...pausedObs, decision: "rm -rf /", extra: 1 });
      assert.equal(bad.status, 400);
      const fields = ((await bad.json()) as { fields: Json }).fields;
      assert.ok("observation.decision" in fields && "observation.extra" in fields);
      const active = await ingest("sweep.scheduler_job", { ...pausedObs, state: "active", until: new Date().toISOString() });
      assert.equal(active.status, 400, "a pause field on an active observation is rejected");
      assert.equal(await counts(), before2);
    }

    // ------------------------------------------------- consumer-silent
    const platform = `${tag}-plat`;
    const consumer = `${tag}-c1`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    const consumerKey = `consumer:${consumer}`;
    const agentId = `${tag}-worker`.toLowerCase();
    {
      const reg = await register({
        id: consumer,
        agent_ids: [agentId],
        reporters: [{ kind: "agent", id: generic.credential.id }],
        queue: { type: "tasks", platform },
        max_silence_hours: 3,
      });
      assert.equal(reg.status, 200, JSON.stringify(reg.body));
      assert.equal(reg.body.created, true);
      const registeredAt = String(reg.body.registered_at);
      // Re-registering does not move registered_at.
      const again = await register({ id: consumer, agent_ids: [agentId], reporters: [{ kind: "agent", id: generic.credential.id }], queue: { type: "tasks", platform } });
      assert.equal(again.body.registered_at, registeredAt);
      assert.equal(again.body.created, false);

      // Measured empty queue: never fires, even long past the limit.
      advance(4 * HOUR);
      let run = await runSweep();
      assert.equal(verdictOf(run, "consumer-silent", consumerKey), "clear");
      assert.equal((await inbox("consumer-silent", consumerKey)).length, 0);

      // Ready work, and a work event from a different credential that claims the agent id.
      await sql()`insert into tasks (title, platform, status) values (${`${tag} ready`}, ${platform}, 'queued')`;
      await ingestPost(req("/api/ingest", { agent_id: agentId, kind: "milestone", title: "impersonated" }, other.token));
      // A burst of newer noise from the right reporter does not count either.
      for (let i = 0; i < 25; i++) await ingestPost(req("/api/ingest", { agent_id: agentId, kind: "heartbeat" }, generic.token));
      await ingestPost(req("/api/ingest", { agent_id: agentId, kind: "error", title: "boom" }, generic.token));
      run = await runSweep();
      assert.equal(verdictOf(run, "consumer-silent", consumerKey), "firing", "impersonation, heartbeats, and errors are not work");
      let rows = await inbox("consumer-silent", consumerKey);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].event, "consumer-silent");
      assert.match(String(rows[0].delivery_id), /^sweep:consumer-silent:[0-9a-f]{24}:e1:s1$/);
      const payload = rows[0].payload as Json;
      assert.equal(payload.source, "agent-kontrol-sweeper");
      assert.equal(payload.state, "firing");
      assert.ok(payload.evaluated_at && payload.evidence);

      // Twice within a minute, and once more an hour later: no repeat.
      await runSweep();
      advance(MIN);
      await runSweep();
      advance(HOUR);
      await runSweep();
      assert.equal((await inbox("consumer-silent", consumerKey)).length, 1, "repeats only after 12 hours");
      advance(11 * HOUR);
      await runSweep();
      rows = await inbox("consumer-silent", consumerKey);
      assert.equal(rows.length, 2, "12 hours after the last emission it repeats once");
      assert.match(String(rows[1].delivery_id), /:e1:s2$/);
      await runSweep();
      assert.equal((await inbox("consumer-silent", consumerKey)).length, 2);

      // A matching authenticated work event clears it exactly once.
      await ingestPost(req("/api/ingest", { agent_id: agentId, kind: "milestone", title: "real work" }, generic.token));
      // The event's created_at is real time; the sweeper clock is ahead, so move the event to the sweeper's now.
      await sql()`update events set created_at = ${await dbNow()}::timestamptz where agent_id = ${agentId} and kind = 'milestone' and principal_id = ${generic.credential.id}`;
      run = await runSweep();
      assert.equal(verdictOf(run, "consumer-silent", consumerKey), "clear");
      rows = await inbox("consumer-silent", consumerKey);
      assert.equal(rows.length, 3);
      assert.equal(rows[2].event, "consumer-silent-cleared");
      assert.match(String(rows[2].delivery_id), /^sweep:consumer-silent-cleared:[0-9a-f]{24}:e1$/);
      await runSweep();
      assert.equal((await inbox("consumer-silent", consumerKey)).length, 3, "already clear emits nothing");
      // A new proven episode fires at once.
      advance(3 * HOUR + MIN);
      await runSweep();
      rows = await inbox("consumer-silent", consumerKey);
      assert.equal(rows.length, 4);
      assert.match(String(rows[3].delivery_id), /:e2:s1$/);
    }
    {
      // Never seen: grace from registration. A missing collector queue is unknown.
      const fresh = `${tag}-c2`.toLowerCase();
      await register({ id: fresh, agent_ids: [`${fresh}-a`], reporters: [{ kind: "legacy", id: "mc-token" }], queue: { type: "tasks", platform } });
      let run = await runSweep();
      assert.equal(verdictOf(run, "consumer-silent", `consumer:${fresh}`), "clear", "inside the grace window");
      advance(3 * HOUR + MIN);
      run = await runSweep();
      assert.equal(verdictOf(run, "consumer-silent", `consumer:${fresh}`), "firing");
      const unknown = `${tag}-c3`.toLowerCase();
      await register({ id: unknown, agent_ids: [`${unknown}-a`], reporters: [{ kind: "legacy", id: "mc-token" }], queue: { type: "collector", queue: `issues:${tag}/missing` } });
      advance(3 * HOUR + MIN);
      run = await runSweep();
      assert.equal(verdictOf(run, "consumer-silent", `consumer:${unknown}`), "unknown");
      assert.equal(check(run, "consumer-silent").state, "firing");
      assert.equal(await latch("consumer-silent", `consumer:${unknown}`).then((l) => l?.active), false);
      // Disabling a firing consumer clears it.
      await register({ id: fresh, agent_ids: [`${fresh}-a`], reporters: [{ kind: "legacy", id: "mc-token" }], queue: { type: "tasks", platform }, enabled: false });
      run = await runSweep();
      assert.equal(verdictOf(run, "consumer-silent", `consumer:${fresh}`), "clear");
      assert.equal((await inbox("consumer-silent", `consumer:${fresh}`)).at(-1)?.event, "consumer-silent-cleared");
    }

    // ---------------------------------------------- scheduler pauses
    const job = `${tag}-job`.toLowerCase();
    const jobKey = `job:mini/${job}`;
    const sched = (over: Json) => observe("sweep.scheduler_job", { source: "mini", job_id: job, observed_at: new Date().toISOString(), ...over });
    {
      // A held pause suppresses the mapped consumer's alarm.
      const heldConsumer = `${tag}-c4`.toLowerCase();
      await register({ id: heldConsumer, agent_ids: [`${heldConsumer}-a`], reporters: [{ kind: "legacy", id: "mc-token" }], queue: { type: "tasks", platform }, scheduler: { source: "mini", job_id: job } });

      const first = await sched({ state: "paused", transition: 1, paused_at: await isoAgo(2 * HOUR) });
      assert.equal(first.outcome, "applied");
      let run = await runSweep();
      assert.equal(verdictOf(run, "pause-unexplained", jobKey), "firing", "no reason, citation, or until");
      assert.equal(verdictOf(run, "pause-expired", jobKey), "clear");
      assert.equal((await inbox("pause-unexplained", jobKey)).length, 1);

      // Same transition again with a citation and a future until: held. A replay without them keeps them.
      const until = await isoAhead(6 * HOUR);
      assert.equal((await sched({ state: "paused", transition: 1, decision: "mrhinkle/agent-kontrol#79", until })).outcome, "refreshed");
      assert.equal((await sched({ state: "paused", transition: 1 })).outcome, "refreshed");
      const stored = await sql()`select decision, until, paused_at from scheduler_jobs where job_id = ${job}`;
      assert.equal(stored[0].decision, "mrhinkle/agent-kontrol#79", "omission does not delete a citation");
      assert.ok(stored[0].until && stored[0].paused_at);
      run = await runSweep();
      assert.equal(verdictOf(run, "pause-unexplained", jobKey), "held");
      assert.equal(verdictOf(run, "pause-expired", jobKey), "held");
      assert.equal((await inbox("pause-unexplained", jobKey)).map((r) => r.event).join(","), "pause-unexplained,pause-unexplained-cleared");
      advance(3 * HOUR + MIN);
      await sched({ state: "paused", transition: 1 });
      run = await runSweep();
      assert.equal(verdictOf(run, "consumer-silent", `consumer:${heldConsumer}`), "held", "a held pause suppresses consumer-silent");

      // Older transition: audited, ignored. Same transition, other state: 409, nothing written.
      const auditBefore = Number((await sql()`select count(*) as n from sweep_observations where subject = ${`mini/${job}`}`)[0].n);
      const conflict = await ingest("sweep.scheduler_job", { source: "mini", job_id: job, state: "active", transition: 1, observed_at: new Date().toISOString() });
      assert.equal(conflict.status, 409);
      assert.equal(Number((await sql()`select count(*) as n from sweep_observations where subject = ${`mini/${job}`}`)[0].n), auditBefore);

      // until passes: expired, and not also unexplained.
      advance(3 * HOUR);
      await sched({ state: "paused", transition: 1 });
      run = await runSweep();
      assert.equal(verdictOf(run, "pause-expired", jobKey), "firing");
      assert.equal(verdictOf(run, "pause-unexplained", jobKey), "clear");
      assert.equal((await inbox("pause-unexplained", jobKey)).length, 2, "expired is not duplicated as unexplained");
      assert.equal((await inbox("pause-expired", jobKey)).length, 1);

      // Stale record: unknown, and the active latch is preserved.
      advance(31 * MIN);
      run = await runSweep();
      assert.equal(verdictOf(run, "pause-expired", jobKey), "unknown");
      assert.equal((await latch("pause-expired", jobKey))?.active, true);
      assert.equal((await inbox("pause-expired", jobKey)).length, 1);

      // Brief: Paused shows the expired pause with its citation.
      await sched({ state: "paused", transition: 1 });
      const paused = await readPaused();
      const row = paused.jobs.find((j) => j.job_id === job);
      assert.equal(row?.classification, "expired");
      assert.equal(row?.decision, "mrhinkle/agent-kontrol#79");
      assert.ok(formatPausedLines(paused).some((l) => l.includes(`mini/${job}`) && l.includes("EXPIRED")));

      // Resume without a citation. The pause's citation does not cover it.
      assert.equal((await sched({ state: "active", transition: 2 })).outcome, "applied");
      const resumed = await sql()`select resumed, decision, prior_decision, prior_state from scheduler_jobs where job_id = ${job}`;
      assert.deepEqual({ ...resumed[0] }, { resumed: true, decision: null, prior_decision: "mrhinkle/agent-kontrol#79", prior_state: "paused" });
      run = await runSweep();
      assert.equal(verdictOf(run, "resume-uncited", jobKey), "firing");
      assert.equal(verdictOf(run, "pause-expired", jobKey), "clear");
      // A replay of the resume, and an older pause replay, do not erase the finding.
      assert.equal((await sched({ state: "active", transition: 2 })).outcome, "refreshed");
      assert.equal((await sched({ state: "paused", transition: 1 })).outcome, "older");
      run = await runSweep();
      assert.equal(verdictOf(run, "resume-uncited", jobKey), "firing");
      assert.equal((await inbox("resume-uncited", jobKey)).length, 1);
      // A citation on that same transition clears it once.
      await sched({ state: "active", transition: 2, decision: "decision:42" });
      run = await runSweep();
      assert.equal(verdictOf(run, "resume-uncited", jobKey), "clear");
      assert.equal((await inbox("resume-uncited", jobKey)).map((r) => r.event).join(","), "resume-uncited,resume-uncited-cleared");

      // A refresh that omits stale_after_minutes keeps the stored window.
      const windowJob = `${tag}-window`.toLowerCase();
      await observe("sweep.scheduler_job", { source: "mini", job_id: windowJob, state: "paused", transition: 1, observed_at: new Date().toISOString(), stale_after_minutes: 5 });
      assert.equal((await observe("sweep.scheduler_job", { source: "mini", job_id: windowJob, state: "paused", transition: 1, observed_at: new Date().toISOString() })).outcome, "refreshed");
      assert.equal(Number((await sql()`select stale_after_minutes from scheduler_jobs where job_id = ${windowJob}`)[0].stale_after_minutes), 5);
      advance(6 * MIN);
      assert.equal(verdictOf(await runSweep(), "pause-unexplained", `job:mini/${windowJob}`), "unknown", "the five-minute window still applies");

      // A first active observation proves no resume.
      const lone = `${tag}-lone`.toLowerCase();
      await observe("sweep.scheduler_job", { source: "mini", job_id: lone, state: "active", transition: 5, observed_at: new Date().toISOString() });
      run = await runSweep();
      assert.equal(verdictOf(run, "resume-uncited", `job:mini/${lone}`), "clear");
    }

    // ------------------------------------------------------------- PRs
    const repo = `Acme-${tag.slice(-6)}/Widgets`;
    const repoKeyValue = repo.toLowerCase();
    const head1 = "a".repeat(40);
    const head2 = "b".repeat(40);
    let seq = 0;
    const snapshot = async (prs: Json[], over: Json = {}) => observe("sweep.pr_snapshot", {
      source: "collector", repo, seq: ++seq, observed_at: new Date().toISOString(), complete: true, prs, ...over,
    });
    const pr = (number: number, over: Json) => ({ number, draft: false, mergeable: "mergeable", head_sha: head1, ...over });
    const prKey = (n: number) => `pr:${repoKeyValue}#${n}`;
    {
      const young = await isoAgo(HOUR);
      await snapshot([
        pr(1, { opened_at: await isoAgo(49 * HOUR), required_checks: { state: "unknown" } }),
        pr(2, { opened_at: young, mergeable: "conflicting" }),
        pr(3, { opened_at: young, required_checks: { state: "success", head_sha: head1 }, review: { started: false } }),
        pr(4, { opened_at: young, required_checks: { state: "unknown" } }),
        pr(5, { opened_at: await isoAgo(72 * HOUR), draft: true }),
        pr(6, { opened_at: young, required_checks: { state: "success", head_sha: head1 }, review: { started: true, head_sha: head1 } }),
      ]);
      let run = await runSweep();
      assert.equal(verdictOf(run, "pr-stuck", prKey(1)), "firing", "age fires despite unknown checks");
      assert.equal(verdictOf(run, "pr-stuck", prKey(2)), "firing", "conflicting");
      assert.equal(verdictOf(run, "pr-stuck", prKey(3)), "clear", "green, but not yet for 30 minutes");
      assert.equal(verdictOf(run, "pr-stuck", prKey(4)), "unknown", "young with unknown checks");
      assert.equal(verdictOf(run, "pr-stuck", prKey(5)), "clear", "drafts never fire");
      assert.equal(verdictOf(run, "pr-stuck", prKey(6)), "clear", "review started at this head");
      const one = await inbox("pr-stuck", prKey(1));
      assert.equal(one.length, 1);
      assert.equal(one[0].repo, repo);
      assert.equal(Number(one[0].number), 1);
      assert.equal(one[0].head_sha, head1);

      // Green duration survives fresh snapshots at the same head and fires at 30 minutes.
      const same = async () => snapshot([
        pr(1, { opened_at: await isoAgo(50 * HOUR) }),
        pr(3, { opened_at: young, required_checks: { state: "success", head_sha: head1 }, review: { started: true, head_sha: "c".repeat(40) } }),
        pr(4, { opened_at: young, required_checks: { state: "unknown" } }),
      ]);
      advance(15 * MIN);
      await same();
      advance(16 * MIN);
      await same();
      run = await runSweep();
      assert.equal(verdictOf(run, "pr-stuck", prKey(3)), "firing", "a review at an older head does not count");
      // PRs 2, 5, 6 left a complete snapshot: closed, so 2 clears.
      assert.equal(verdictOf(run, "pr-stuck", prKey(2)), "clear");
      assert.equal((await inbox("pr-stuck", prKey(2))).at(-1)?.event, "pr-stuck-cleared");

      // A new head resets green duration.
      advance(5 * MIN);
      await snapshot([
        pr(1, { opened_at: await isoAgo(50 * HOUR) }),
        pr(3, { opened_at: young, head_sha: head2, required_checks: { state: "success", head_sha: head2 }, review: { started: false } }),
        pr(4, { opened_at: young, required_checks: { state: "unknown" } }),
      ]);
      run = await runSweep();
      assert.equal(verdictOf(run, "pr-stuck", prKey(3)), "clear");
      const greenSince = await sql()`select green_since, head_sha from sweep_prs where repo_key = ${repoKeyValue} and number = 3`;
      assert.equal(greenSince[0].head_sha, head2);

      // An incomplete snapshot is unknown for every PR in the repo; latches are kept.
      const auditOnly = await snapshot([], { complete: false, error: "gh api rate limited" });
      assert.equal(auditOnly.outcome, "applied");
      run = await runSweep();
      assert.equal(verdictOf(run, "pr-stuck", prKey(1)), "unknown");
      assert.equal((await latch("pr-stuck", prKey(1)))?.active, true);
      // An older complete snapshot does not replace the newer failure.
      const replay = await observe("sweep.pr_snapshot", { source: "collector", repo: repo.toLowerCase(), seq: 2, observed_at: new Date().toISOString(), complete: true, prs: [] });
      assert.equal(replay.outcome, "older", "repo casing is one identity");
      run = await runSweep();
      assert.equal(verdictOf(run, "pr-stuck", prKey(1)), "unknown");
      // A fresh complete snapshot without #1 proves it closed.
      await snapshot([pr(4, { opened_at: young })]);
      run = await runSweep();
      assert.equal(verdictOf(run, "pr-stuck", prKey(1)), "clear");
      assert.equal((await inbox("pr-stuck", prKey(1))).map((r) => r.event).join(","), "pr-stuck,pr-stuck-cleared");
      // Stale evidence is unknown.
      advance(31 * MIN);
      run = await runSweep();
      assert.equal(verdictOf(run, "pr-stuck", prKey(4)), "unknown");
    }

    // -------------------------------------------------- decision-aging
    const decisionKey = `${tag}-dec`;
    const dKey = `decision:${decisionKey}`;
    {
      await sql()`
        insert into decisions (key, source, repo, number, title, status, opened_at, first_seen_at)
        values (${decisionKey}, 'manual', ${repo}, 9, 'aging', 'open', ${await isoAgo(15 * 24 * HOUR)}::timestamptz, ${await dbNow()}::timestamptz)
      `;
      let run = await runSweep();
      assert.equal(verdictOf(run, "decision-aging", dKey), "firing", "opened_at wins over first_seen_at");
      await sql()`update decisions set status = 'deferred', defer_until = ${await isoAhead(2 * HOUR)}::timestamptz where key = ${decisionKey}`;
      run = await runSweep();
      assert.equal(verdictOf(run, "decision-aging", dKey), "held");
      assert.equal((await inbox("decision-aging", dKey)).at(-1)?.event, "decision-aging-cleared");
      advance(2 * HOUR + MIN);
      run = await runSweep();
      assert.equal(verdictOf(run, "decision-aging", dKey), "firing", "an expired deferral ages again, at once");
      assert.match(String((await inbox("decision-aging", dKey)).at(-1)?.delivery_id), /:e2:s1$/);
      advance(12 * HOUR);
      await runSweep();
      assert.equal((await inbox("decision-aging", dKey)).length, 4, "decision-aging repeats after 12 hours too");
      await sql()`update decisions set status = 'decided', decision = 'ship' where key = ${decisionKey}`;
      run = await runSweep();
      assert.equal(verdictOf(run, "decision-aging", dKey), "clear");
      // first_seen_at baseline when opened_at is null.
      const fallback = `${tag}-dec2`;
      await sql()`insert into decisions (key, source, title, status, first_seen_at) values (${fallback}, 'manual', 'fallback', 'open', ${await isoAgo(14 * 24 * HOUR + MIN)}::timestamptz)`;
      run = await runSweep();
      assert.equal(verdictOf(run, "decision-aging", `decision:${fallback}`), "firing");
      await sql()`delete from decisions where key = ${fallback}`;
      run = await runSweep();
      assert.equal(verdictOf(run, "decision-aging", `decision:${fallback}`), "clear", "a removed decision clears");
    }

    // ----------------------------------------------- dispatch-ready-empty
    const queue = `issues:${repoKeyValue}`;
    const qKey = `queue:${queue}`;
    let qseq = 0;
    const queueObs = (over: Json) => observe("sweep.queue", {
      source: "collector", queue, classification: "issue_dispatch", repo, seq: ++qseq, observed_at: new Date().toISOString(),
      complete: true, ready: { count: 0 }, raw: { count: 3, refs: ["#1", "#2", "#3"] }, ...over,
    });
    {
      await queueObs({});
      for (let i = 0; i < 3; i++) {
        advance(15 * MIN);
        await queueObs({});
      }
      let run = await runSweep();
      assert.equal(verdictOf(run, "dispatch-ready-empty", qKey), "clear", "45 minutes is still pending");
      advance(16 * MIN);
      await queueObs({});
      run = await runSweep();
      assert.equal(verdictOf(run, "dispatch-ready-empty", qKey), "firing");
      assert.equal((await inbox("dispatch-ready-empty", qKey)).length, 1);
      const queued = Number((await sql()`select count(*) as n from tasks where created_at > now() - interval '1 minute' and title ilike '%spec%'`)[0].n);
      assert.equal(queued, 0, "emit only: nothing is queued");
      // Incomplete: unknown, latch kept, and the interval resets.
      advance(10 * MIN);
      await queueObs({ complete: false, error: "timeout", ready: undefined, raw: undefined });
      run = await runSweep();
      assert.equal(verdictOf(run, "dispatch-ready-empty", qKey), "unknown");
      assert.equal((await latch("dispatch-ready-empty", qKey))?.active, true);
      advance(5 * MIN);
      await queueObs({});
      const since = await sql()`select empty_since, received_at from sweep_queues where queue = ${queue}`;
      assert.equal(new Date(since[0].empty_since).getTime(), new Date(since[0].received_at).getTime(), "unknown evidence does not extend the interval");
      run = await runSweep();
      assert.equal(verdictOf(run, "dispatch-ready-empty", qKey), "clear", "pending again after the reset, so it clears");
      // Ready work appearing keeps it clear; a replayed older observation cannot undo that.
      await queueObs({ ready: { count: 1 } });
      const older = await observe("sweep.queue", { source: "collector", queue, classification: "issue_dispatch", seq: 1, observed_at: new Date().toISOString(), complete: true, ready: { count: 0 }, raw: { count: 3 } });
      assert.equal(older.outcome, "older");
      run = await runSweep();
      assert.equal(verdictOf(run, "dispatch-ready-empty", qKey), "clear");
    }

    // ------------------------------------------------ races and replays
    {
      const raceJob = `${tag}-race`.toLowerCase();
      await observe("sweep.scheduler_job", { source: "mini", job_id: raceJob, state: "paused", transition: 1, observed_at: new Date().toISOString() });
      const runs = await Promise.all(Array.from({ length: 6 }, () => runSweep()));
      assert.equal((await inbox("pause-unexplained", `job:mini/${raceJob}`)).length, 1, "concurrent sweeps emit once");
      assert.equal(runs.filter((r) => verdictOf(r, "pause-unexplained", `job:mini/${raceJob}`) === "firing").length, 6);
      // A committed run whose response was lost: the retry writes nothing new.
      const allBefore = Number((await sql()`select count(*) as n from gh_events where delivery_id like 'sweep:%'`)[0].n);
      await runSweep();
      assert.equal(Number((await sql()`select count(*) as n from gh_events where delivery_id like 'sweep:%'`)[0].n), allBefore);

      // Forced inbox failure: the domain rolls back and reports unknown; other domains still run.
      const doomed = `${tag}-doomed`.toLowerCase();
      await observe("sweep.scheduler_job", { source: "mini", job_id: doomed, state: "paused", transition: 1, observed_at: new Date().toISOString() });
      await sql()`
        create or replace function pg_test_fail_sweep_insert() returns trigger language plpgsql as $$
        begin
          if new.payload->>'entity_key' like '%-doomed' then raise exception 'forced inbox failure'; end if;
          return new;
        end $$
      `;
      await sql()`drop trigger if exists pg_test_fail_sweep_insert on gh_events`;
      await sql()`create trigger pg_test_fail_sweep_insert before insert on gh_events for each row execute function pg_test_fail_sweep_insert()`;
      try {
        const run = await runSweep();
        const pauses = check(run, "pause-unexplained");
        assert.equal(pauses.state, "unknown");
        assert.match(String(pauses.error), /could not read or write/);
        assert.doesNotMatch(String(pauses.error), /forced inbox failure/, "the exception text is not returned");
        assert.equal(check(run, "decision-aging").error, null, "other domains are isolated");
        assert.equal(await latch("pause-unexplained", `job:mini/${doomed}`), null, "the latch insert rolled back with the event");
      } finally {
        await sql()`drop trigger if exists pg_test_fail_sweep_insert on gh_events`;
        await sql()`drop function if exists pg_test_fail_sweep_insert()`;
      }
      await runSweep();
      assert.equal((await inbox("pause-unexplained", `job:mini/${doomed}`)).length, 1, "the next run emits once");

      // A latch already evaluated at a later instant is not overwritten by this one.
      await sql()`update sweep_latches set last_evaluated_at = ${await isoAhead(HOUR)}::timestamptz, active = false where condition = 'pause-unexplained' and entity_key = ${`job:mini/${doomed}`}`;
      await runSweep();
      assert.equal((await latch("pause-unexplained", `job:mini/${doomed}`))?.active, false);
      assert.equal((await inbox("pause-unexplained", `job:mini/${doomed}`)).length, 1);
    }

    // ---------------------------------------------- clock failure and skew
    {
      const latchesBefore = await sql()`select condition, entity_key, active, episode, seq, last_emitted_at from sweep_latches order by 1, 2`;
      const eventsBefore = Number((await sql()`select count(*) as n from gh_events`)[0].n);
      setSweepClockOffsetForTests(Number.NaN);
      try {
        const run = await runSweep();
        assert.ok(run.checks.every((c) => c.state === "unknown" && c.error), "no clock, no verdict");
        assert.equal(run.retention.state, "unknown");
      } finally {
        setSweepClockOffsetForTests(clock);
      }
      assert.deepEqual(await sql()`select condition, entity_key, active, episode, seq, last_emitted_at from sweep_latches order by 1, 2`, latchesBefore);
      assert.equal(Number((await sql()`select count(*) as n from gh_events`)[0].n), eventsBefore);

      // Host clock ten years ahead: nothing changes, because the host clock is not consulted.
      const realNow = Date.now;
      Date.now = () => realNow() + 10 * 365 * 24 * HOUR;
      let skewed: SweepRun;
      try {
        skewed = await runSweep();
      } finally {
        Date.now = realNow;
      }
      assert.equal(Number((await sql()`select count(*) as n from gh_events`)[0].n), eventsBefore);
      assert.ok(skewed.checks.every((c) => c.emitted.length === 0 && c.error === null), "same evidence, same database instant range: nothing new");
      // A source instant far in the future is a fact, not the clock.
      const skewJob = `${tag}-skew`.toLowerCase();
      await observe("sweep.scheduler_job", { source: "mini", job_id: skewJob, state: "paused", transition: 1, observed_at: "2099-01-01T00:00:00Z", decision: "doc:runbook", until: "2099-01-02T00:00:00Z" });
      const run = await runSweep();
      assert.equal(verdictOf(run, "pause-unexplained", `job:mini/${skewJob}`), "held");
      advance(31 * MIN);
      assert.equal(verdictOf(await runSweep(), "pause-unexplained", `job:mini/${skewJob}`), "unknown", "freshness is database receipt time, not observed_at");
    }

    // --------------------------------------------------------- retention
    {
      const now = await dbNow();
      const old = new Date(new Date(now).getTime() - 31 * 24 * HOUR).toISOString();
      const recent = new Date(new Date(now).getTime() - 29 * 24 * HOUR).toISOString();
      await sql()`
        insert into gh_events (delivery_id, event, payload, received_at) values
          (${`${tag}-old-gh`}, 'push', '{}'::jsonb, ${old}::timestamptz),
          (${`sweep:${tag}-old`}, 'pr-stuck', '{}'::jsonb, ${old}::timestamptz),
          (${`${tag}-recent-gh`}, 'push', '{}'::jsonb, ${recent}::timestamptz)
      `;
      const latchesBefore = Number((await sql()`select count(*) as n from sweep_latches`)[0].n);
      const run = await runSweep();
      assert.equal(run.retention.state, "ok");
      assert.ok(run.retention.deleted >= 2);
      assert.equal(run.retention.complete, true);
      const left = await sql()`select delivery_id from gh_events where delivery_id in (${`${tag}-old-gh`}, ${`sweep:${tag}-old`}, ${`${tag}-recent-gh`})`;
      assert.deepEqual(left.map((r) => r.delivery_id), [`${tag}-recent-gh`], "30 days by database time, GitHub and synthetic rows alike");
      assert.equal(Number((await sql()`select count(*) as n from sweep_latches`)[0].n), latchesBefore, "latches outlive the inbox");
      await sql()`delete from gh_events where delivery_id = ${`${tag}-recent-gh`}`;
    }

    // ------------------------------------------------- routes and brief
    {
      const before = Number((await sql()`select (select count(*) from sweep_latches) + (select count(*) from gh_events) + (select count(*) from sweep_observations) as n`)[0].n);
      const status = await sweepGet(new Request("http://localhost/api/sweep", { headers: { authorization: `Bearer ${generic.token}` } }));
      assert.equal(status.status, 200, "progress:read can read status");
      const body = await status.json() as { paused: { measured: boolean; counts: Json }; consumers: unknown[]; latches: unknown[]; latches_truncated: boolean; consumers_truncated: boolean };
      assert.equal(body.paused.measured, true);
      assert.equal(body.latches_truncated, false);
      assert.equal(body.consumers_truncated, false);
      assert.ok(Array.isArray(body.consumers) && Array.isArray(body.latches));
      assert.equal(Number((await sql()`select (select count(*) from sweep_latches) + (select count(*) from gh_events) + (select count(*) from sweep_observations) as n`)[0].n), before, "GET never mutates");
      // Over the bounded read: unmeasured, never a partial "none"; latch list says it is partial.
      await sql()`
        insert into scheduler_jobs (source, job_id, state, transition, transition_received_at, last_received_at)
        select 'bulk', ${`${tag}-bulk-`} || g, 'active', 1, now(), now() from generate_series(1, 1001) g
      `;
      await sql()`
        insert into sweep_latches (condition, entity_key, active)
        select 'pr-stuck', ${`pr:${tag}-bulk/x#`} || g, true from generate_series(1, 501) g
      `;
      try {
        const bounded = await readPaused();
        assert.equal(bounded.measured, false);
        assert.match(formatPausedLines(bounded)[0], /^PAUSED: DATA INCOMPLETE \(more than 1000 scheduler jobs/);
        const partial = await (await sweepGet(new Request("http://localhost/api/sweep", { headers: { authorization: `Bearer ${token}` } }))).json() as { latches: unknown[]; latches_truncated: boolean; errors: string[] };
        assert.equal(partial.latches.length, 500);
        assert.equal(partial.latches_truncated, true);
        assert.ok(partial.errors.some((e) => e.includes("truncated")));
      } finally {
        await sql()`delete from scheduler_jobs where source = 'bulk'`;
        await sql()`delete from sweep_latches where entity_key like ${`pr:${tag}-bulk/%`}`;
      }

      const viaRoute = await sweepPost(req("/api/sweep", {}, token));
      assert.equal(viaRoute.status, 200);
      const out = await viaRoute.json() as { ok: boolean; checks: unknown[] };
      assert.equal(out.ok, true);
      assert.equal(out.checks.length, 7);

      const brief = await loadBrief("24h");
      assert.equal(brief.paused.measured, true);
      const text = formatBriefText(brief);
      assert.match(text, /\nPAUSED: DATA INCOMPLETE \u2014 \d+ job\(s\) stale; known rows below\n  \?\? mini\//, "stale jobs are unknown, never none");
      assert.match(text, /\nHELD VERSUS UNEXPLAINED: \d+ held, \d+ unexplained, \d+ expired/);
    }
  } finally {
    setSweepClockOffsetForTests(0);
    await wipe();
    await sql()`delete from tasks where platform = ${`${tag}-plat`}`;
    await sql()`delete from decisions where key like ${`${tag}-dec%`}`;
    await sql()`delete from events where agent_id like ${`${tag.toLowerCase()}%`}`;
    if (credentialIds.length) await sql()`delete from agent_credentials where id = any(${credentialIds}::text[])`;
    if (saved.token === undefined) delete env.MC_TOKEN; else env.MC_TOKEN = saved.token;
    if (saved.env === undefined) delete env.NODE_ENV; else env.NODE_ENV = saved.env;
    if (saved.password !== undefined) env.MC_DASHBOARD_PASSWORD = saved.password;
  }
}
