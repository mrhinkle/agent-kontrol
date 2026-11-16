import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { authCookieValue } from "../../src/lib/authcrypto";
import { DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID } from "../../src/lib/actor";
import {
  actorDecisionsFixture,
  closeActorDecisionsPool,
  confirmActorDecisionsFixture,
  withOwnedFixtureCleanup,
} from "./fixture";

/**
 * Decision upsert, force-reopen, reconcile, and request_decision receipts.
 * Opt in with AK_ACTOR_DECISIONS_FIXTURE=1. Without that flag this file does
 * not import the database or open a pool. The fixture URL is fixed.
 */
const OPT_IN = process.env.AK_ACTOR_DECISIONS_FIXTURE === "1";
const LEGACY = "actor-decisions-legacy";
const PASSWORD = "actor-decisions-session";
const PREFIX = `akdec-${randomUUID().slice(0, 8)}`;
const REPO = `${PREFIX}/app`;
const RECON_REPO = `${PREFIX}/recon`;
const LEAK = "PROMPT-BODY-SHOULD-NOT-LEAK";

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  node: env.NODE_ENV,
  password: env.MC_DASHBOARD_PASSWORD,
};

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
type Post = (req: Request) => Promise<Response>;
type CreateCredential = (input: { label: string; scopes: string[] }) => Promise<
  { ok: true; token: string; credential: { id: string } } | { ok: false; error: string }
>;

let sql: SqlTag;
let postDecisions: Post;
let createCredential: CreateCredential;
let claimDecisionWriteback: (id: number, revision: number) => Promise<{ token: string; revision: number } | null>;
let requestDecisionTool: (args: { slug: string; title: string; why?: string }) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: { receipt?: { id: string; kind: string; at: string } };
}>;
let runWithPrincipal: <T>(principal: { kind: "agent"; id: string; scopes: string[] } | { kind: "oauth"; id: string } | { kind: "legacy" } | { kind: "dev-open" }, fn: () => T) => T;

function key(n: number): string {
  return `github:${REPO}#${n}`;
}

function decisionBody(n: number, over: Record<string, unknown> = {}) {
  return {
    key: key(n),
    source: "github-label",
    repo: REPO,
    repo_short: "app",
    number: n,
    title: `Decision ${n} ${LEAK}`,
    why: LEAK,
    requested_by: "forged-requested-by",
    actor_type: "human",
    actor_id: "forged-actor",
    agent_id: "forged-agent",
    host: "forged-host",
    force: false,
    ...over,
  };
}

function post(body: unknown, auth: { token?: string | null; cookie?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  return postDecisions(new Request("http://localhost/api/decisions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

async function decisionRows(which: string) {
  return sql`
    select id::text as id, key, status, actor_type, actor_id, requested_by,
           decision, revision, github_present,
           (writeback_lock is not null) as locked
    from decisions
    where key = ${which}
  `;
}

async function receiptsForKey(which: string) {
  return sql`
    select id::text as id, kind, title, detail
    from events
    where detail->>'key' = ${which}
    order by events.id
  `;
}

async function receiptsForRepo(repo = REPO) {
  return sql`
    select id::text as id, kind, title, detail
    from events
    where kind = 'decision.reconcile' and detail->>'repo' = ${repo}
    order by events.id
  `;
}

function detailOf(row: Record<string, unknown>): Record<string, unknown> {
  const detail = row.detail;
  if (typeof detail === "string") return JSON.parse(detail) as Record<string, unknown>;
  return detail as Record<string, unknown>;
}

function assertNoLeak(value: unknown) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(LEAK), false);
  assert.equal(text.includes("forged-actor"), false);
  assert.equal(text.includes("forged-requested-by"), false);
  assert.equal(text.includes("forged-agent"), false);
  assert.equal(text.includes("forged-host"), false);
  assert.equal(text.includes(LEGACY), false);
  assert.equal(text.includes(PASSWORD), false);
}

describe("decision actor receipts", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_DECISIONS_FIXTURE !== "1") return;
    const fixture = actorDecisionsFixture();
    env.DATABASE_URL = fixture.url;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    delete env.MC_DASHBOARD_PASSWORD;
    const db = await import("../../src/lib/db");
    const route = await import("../../src/app/api/decisions/route");
    const credentials = await import("../../src/lib/credentials");
    const decisions = await import("../../src/lib/decisions");
    const resolve = await import("../../src/lib/decision-resolve");
    const actor = await import("../../src/lib/actor");
    sql = db.sql();
    postDecisions = route.POST;
    createCredential = credentials.createCredential as CreateCredential;
    claimDecisionWriteback = decisions.claimDecisionWriteback;
    requestDecisionTool = resolve.requestDecisionTool as typeof requestDecisionTool;
    runWithPrincipal = actor.runWithPrincipal as typeof runWithPrincipal;
    await confirmActorDecisionsFixture(sql, fixture.database);
    await sql`delete from events where detail->>'key' = ${"agent:" + LEGACY_ACTOR_ID + ":legacy-pick"}`;
    await sql`delete from decisions where key = ${"agent:" + LEGACY_ACTOR_ID + ":legacy-pick"}`;
  });

  after(async () => {
    try {
      if (process.env.AK_ACTOR_DECISIONS_FIXTURE !== "1" || !sql) return;
      const fixture = actorDecisionsFixture();
      await withOwnedFixtureCleanup(sql, fixture.database, async () => {
        await sql`drop trigger if exists ak_dec_suppress_receipt on events`;
        await sql`drop function if exists ak_dec_suppress_receipt()`;
        await sql`drop table if exists ak_dec_suppress_key`;
        await sql`drop trigger if exists ak_dec_fail_receipt on events`;
        await sql`drop function if exists ak_dec_fail_receipt()`;
        await sql`drop table if exists ak_dec_fail_key`;
        await sql`delete from events where kind = 'decision.reconcile' and detail->>'repo' like ${PREFIX + "/%"}`;
        await sql`delete from events where detail->>'key' like ${"github:" + REPO + "#%"} or detail->>'key' like ${"github:" + RECON_REPO + "#%"}`;
        await sql`delete from events where detail->>'key' like ${"agent:" + PREFIX + "%"}`;
        await sql`
          delete from events
          where kind = 'credential_create'
            and detail->>'credential_id' in (
              select id from agent_credentials where label like ${PREFIX + "%"}
            )
        `;
        await sql`delete from events where detail->>'key' = ${"agent:" + LEGACY_ACTOR_ID + ":legacy-pick"}`;
        await sql`delete from decisions where repo = ${REPO} or repo = ${RECON_REPO} or key like ${"agent:" + PREFIX + "%"} or key = ${"agent:" + LEGACY_ACTOR_ID + ":legacy-pick"}`;
        await sql`delete from agent_credentials where label like ${PREFIX + "%"}`;
      });
    } finally {
      await closeActorDecisionsPool();
      restoreEnv();
    }
  });

  it("stores the legacy principal on an upsert and ignores forged labels", async () => {
    const res = await post(decisionBody(1), { token: LEGACY });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; decision: { id: number; status: string; actor_type: string | null; actor_id: string | null }; status_held: boolean; receipt?: unknown };
    assert.equal(body.ok, true);
    assert.equal(body.status_held, false);
    assert.equal(body.decision.status, "open");
    assert.equal(body.decision.actor_type, null);
    assert.equal(body.decision.actor_id, null);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "receipt"), false);

    const rows = await decisionRows(key(1));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requested_by, "forged-requested-by");
    assert.equal(rows[0].actor_type, null);
    const proof = await receiptsForKey(key(1));
    assert.equal(proof.length, 1);
    assert.equal(proof[0].kind, "decision.upsert");
    assert.equal(proof[0].title, "Decision upserted");
    const detail = detailOf(proof[0]);
    assert.equal(detail.tool, "decision.upsert");
    assert.equal(detail.operation, "upsert");
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
    assert.equal(detail.decision_id, rows[0].id);
    assert.equal(detail.key, key(1));
    assert.equal(detail.source, "github-label");
    assert.equal(detail.status, "open");
    assertNoLeak(detail);
  });

  it("attributes a session principal and a dev-open null without inventing an operator", async () => {
    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    try {
      const cookie = await authCookieValue(PASSWORD);
      const session = await post(decisionBody(2), { cookie: `mc_auth=${cookie}` });
      assert.equal(session.status, 200);
      const sessionProof = await receiptsForKey(key(2));
      assert.equal(sessionProof.length, 1);
      const sessionDetail = detailOf(sessionProof[0]);
      assert.equal(sessionDetail.actor_type, "human");
      assert.equal(sessionDetail.actor_id, DASHBOARD_ACTOR_ID);
      assertNoLeak(sessionDetail);

      const missing = await post(decisionBody(20), {});
      assert.equal(missing.status, 401);
      assert.equal((await decisionRows(key(20))).length, 0);
      assert.equal((await receiptsForKey(key(20))).length, 0);
    } finally {
      delete env.MC_DASHBOARD_PASSWORD;
    }

    delete env.MC_TOKEN;
    try {
      const open = await post(decisionBody(3), {});
      assert.equal(open.status, 200);
      const proof = await receiptsForKey(key(3));
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.actor_type, null);
      assert.equal(detail.actor_id, null);
      assert.equal(JSON.stringify(detail).includes("operator"), false);
      assert.equal(JSON.stringify(detail).includes(DASHBOARD_ACTOR_ID), false);
      assertNoLeak(detail);
    } finally {
      env.MC_TOKEN = LEGACY;
    }
  });

  it("rejects an agent credential and a bad bearer without a decision or receipt", async () => {
    const made = await createCredential({ label: `${PREFIX}-denied`, scopes: ["decisions:write"] });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const denied = await post(decisionBody(4), { token: made.token });
    assert.equal(denied.status, 403);
    const bad = await post(decisionBody(4), { token: "akc_not-a-real-token" });
    assert.equal(bad.status, 401);
    const invalid = await post({ key: "not a key", source: "github-label", title: "T" }, { token: LEGACY });
    assert.equal(invalid.status, 400);
    assert.equal((await decisionRows(key(4))).length, 0);
    assert.equal((await receiptsForKey(key(4))).length, 0);
  });

  it("keeps the resolver on a held update and clears it only as null on force-reopen", async () => {
    const seeded = await post(decisionBody(5, { title: "hold me", why: null, requested_by: null }), { token: LEGACY });
    assert.equal(seeded.status, 200);
    await sql`
      update decisions
      set status = 'decided',
          decision = 'ship',
          actor_type = 'human',
          actor_id = 'operator',
          decided_by = 'operator',
          decided_at = now()
      where key = ${key(5)}
    `;
    const before = await receiptsForKey(key(5));
    const held = await post(decisionBody(5, { title: "renamed", why: LEAK, force: false }), { token: LEGACY });
    assert.equal(held.status, 200);
    const heldBody = await held.json() as { status_held: boolean; decision: { status: string; actor_type: string | null; actor_id: string | null; decision: string | null } };
    assert.equal(heldBody.status_held, true);
    assert.equal(heldBody.decision.status, "decided");
    assert.equal(heldBody.decision.decision, "ship");
    assert.equal(heldBody.decision.actor_type, "human");
    assert.equal(heldBody.decision.actor_id, "operator");
    const heldProof = await receiptsForKey(key(5));
    assert.equal(heldProof.length, before.length + 1);
    const heldDetail = detailOf(heldProof.at(-1)!);
    assert.equal(heldDetail.operation, "upsert");
    assert.equal(heldDetail.actor_id, LEGACY_ACTOR_ID);
    assert.equal(heldDetail.status, "decided");
    assertNoLeak(heldDetail);

    const reopened = await post(decisionBody(5, { title: "reopened", why: LEAK, force: true }), { token: LEGACY });
    assert.equal(reopened.status, 200);
    const reopenBody = await reopened.json() as { status_held: boolean; decision: { status: string; actor_type: string | null; actor_id: string | null; decision: string | null } };
    assert.equal(reopenBody.status_held, false);
    assert.equal(reopenBody.decision.status, "open");
    assert.equal(reopenBody.decision.actor_type, null);
    assert.equal(reopenBody.decision.actor_id, null);
    assert.equal(reopenBody.decision.decision, null);
    const reopenProof = await receiptsForKey(key(5));
    assert.equal(reopenProof.length, heldProof.length + 1);
    assert.equal(reopenProof.at(-1)?.kind, "decision.force_reopen");
    const reopenDetail = detailOf(reopenProof.at(-1)!);
    assert.equal(reopenDetail.operation, "force_reopen");
    assert.equal(reopenDetail.actor_type, "agent");
    assert.equal(reopenDetail.actor_id, LEGACY_ACTOR_ID);
    assert.notEqual(reopenDetail.actor_id, "operator");
    assertNoLeak(reopenDetail);
  });

  it("refuses a force-reopen while a write-back claim holds the row and writes no receipt", async () => {
    const seeded = await post(decisionBody(6, { title: "locked", why: null, requested_by: null }), { token: LEGACY });
    assert.equal(seeded.status, 200);
    const stamped = await sql`
      update decisions
      set status = 'decided',
          decision = 'ship',
          actor_type = 'human',
          actor_id = 'operator',
          decided_by = 'operator',
          decided_at = now()
      where key = ${key(6)}
      returning id::text as id, revision
    `;
    const claim = await claimDecisionWriteback(Number(stamped[0].id), Number(stamped[0].revision));
    assert.ok(claim);
    const before = await receiptsForKey(key(6));
    const blocked = await post(decisionBody(6, { title: "should not reopen", why: LEAK, force: true }), { token: LEGACY });
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json() as { code: string };
    assert.equal(blockedBody.code, "writeback_in_progress");
    assert.equal(JSON.stringify(blockedBody).includes(LEAK), false);
    const row = await decisionRows(key(6));
    assert.equal(row[0].status, "decided");
    assert.equal(row[0].actor_type, "human");
    assert.equal(row[0].actor_id, "operator");
    assert.equal(row[0].decision, "ship");
    assert.equal(row[0].locked, true);
    assert.equal((await receiptsForKey(key(6))).length, before.length);

    const held = await post(decisionBody(6, { title: "title while locked", why: LEAK, force: false }), { token: LEGACY });
    assert.equal(held.status, 200);
    const after = await decisionRows(key(6));
    assert.equal(after[0].status, "decided");
    assert.equal(after[0].actor_id, "operator");
    assert.equal(after[0].locked, true);
    const proof = await receiptsForKey(key(6));
    assert.equal(proof.length, before.length + 1);
    assert.equal(detailOf(proof.at(-1)!).operation, "upsert");
    assert.equal(detailOf(proof.at(-1)!).actor_id, LEGACY_ACTOR_ID);
    assertNoLeak(detailOf(proof.at(-1)!));
  });

  it("reconciles only changed rows, keeps the prior resolver, and skips a second empty sweep", async () => {
    const reconKey = (n: number) => `github:${RECON_REPO}#${n}`;
    const reconBody = (n: number, over: Record<string, unknown> = {}) => ({
      ...decisionBody(n, over),
      key: reconKey(n),
      repo: RECON_REPO,
    });
    await post(reconBody(7, { title: "seen", why: null, requested_by: null }), { token: LEGACY });
    await post(reconBody(8, { title: "gone", why: null, requested_by: null }), { token: LEGACY });
    await sql`
      update decisions
      set status = 'decided',
          decision = 'keep',
          actor_type = 'human',
          actor_id = 'operator',
          decided_by = 'operator',
          decided_at = now()
      where key = ${reconKey(8)}
    `;
    const seenBefore = await decisionRows(reconKey(7));
    const res = await post({
      reconcile: { repo: RECON_REPO, source: "github-label", seen_keys: [reconKey(7)] },
      actor_id: "forged-actor",
      requested_by: "forged-requested-by",
      host: "forged-host",
    }, { token: LEGACY });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; reconciled: number; withdrawn: number; receipt?: unknown };
    assert.equal(body.ok, true);
    assert.equal(body.withdrawn, 1);
    assert.equal(body.reconciled, 1);
    assert.deepEqual(Object.keys(body).sort(), ["ok", "reconciled", "withdrawn"]);
    const seen = await decisionRows(reconKey(7));
    assert.equal(seen[0].status, "open");
    assert.equal(seen[0].revision, seenBefore[0].revision);
    const gone = await decisionRows(reconKey(8));
    assert.equal(gone[0].status, "withdrawn");
    assert.equal(gone[0].actor_type, "human");
    assert.equal(gone[0].actor_id, "operator");
    assert.equal(gone[0].decision, "keep");
    const proof = await receiptsForRepo(RECON_REPO);
    assert.equal(proof.length, 1);
    const detail = detailOf(proof[0]);
    assert.equal(detail.operation, "reconcile");
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
    assert.deepEqual(detail.decision_ids, [gone[0].id]);
    assert.deepEqual(detail.keys, [reconKey(8)]);
    assert.equal(detail.source, "github-label");
    assert.equal(detail.repo, RECON_REPO);
    assertNoLeak(detail);

    const again = await post({
      reconcile: { repo: RECON_REPO, source: "github-label", seen_keys: [reconKey(7)] },
    }, { token: LEGACY });
    assert.equal(again.status, 200);
    const againBody = await again.json() as { reconciled: number; withdrawn: number };
    assert.equal(againBody.reconciled, 0);
    assert.equal(againBody.withdrawn, 0);
    assert.equal((await receiptsForRepo(RECON_REPO)).length, 1);

    const emptyRepo = `${PREFIX}/empty`;
    const none = await post({
      reconcile: { repo: emptyRepo, source: "github-label", seen_keys: [] },
    }, { token: LEGACY });
    assert.equal(none.status, 200);
    assert.equal(((await none.json()) as { reconciled: number }).reconciled, 0);
    const stray = await sql`
      select count(*)::int as n from events
      where kind = 'decision.reconcile' and detail->>'repo' = ${emptyRepo}
    `;
    assert.equal(Number(stray[0].n), 0);
  });

  it("attributes two concurrent upserts separately", async () => {
    const [left, right] = await Promise.all([
      post(decisionBody(9, { why: LEAK }), { token: LEGACY }),
      post(decisionBody(10, { why: LEAK }), { token: LEGACY }),
    ]);
    assert.equal(left.status, 200);
    assert.equal(right.status, 200);
    for (const n of [9, 10]) {
      const proof = await receiptsForKey(key(n));
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.decision_id, (await decisionRows(key(n)))[0].id);
      assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
      assert.equal(detail.key, key(n));
      assertNoLeak(detail);
    }
  });

  it("rolls the upsert back when its receipt fails or is suppressed", async () => {
    const kept = await post(decisionBody(11, { why: null, requested_by: null }), { token: LEGACY });
    assert.equal(kept.status, 200);
    await installReceiptTrigger("fail", key(12));
    try {
      const failed = await post(decisionBody(12, { why: LEAK }), { token: LEGACY });
      assert.equal(failed.status, 500);
      const failedBody = await failed.json() as { code: string };
      assert.equal(failedBody.code, "internal_error");
      assert.equal(JSON.stringify(failedBody).includes("injected"), false);
      assert.equal(JSON.stringify(failedBody).includes(LEAK), false);
      assert.equal((await decisionRows(key(12))).length, 0);
      assert.equal((await receiptsForKey(key(12))).length, 0);
      assert.equal((await decisionRows(key(11))).length, 1);
      assert.equal((await receiptsForKey(key(11))).length, 1);
    } finally {
      await dropReceiptTrigger("fail");
    }

    await installReceiptTrigger("suppress", key(13));
    try {
      const suppressed = await post(decisionBody(13, { why: LEAK }), { token: LEGACY });
      assert.equal(suppressed.status, 500);
      assert.equal((await decisionRows(key(13))).length, 0);
      assert.equal((await receiptsForKey(key(13))).length, 0);
      assert.equal((await decisionRows(key(11))).length, 1);
    } finally {
      await dropReceiptTrigger("suppress");
    }
  });

  it("rolls a reconcile batch back when its receipt fails or is suppressed", async () => {
    await post(decisionBody(14, { why: null, requested_by: null }), { token: LEGACY });
    await post(decisionBody(15, { why: null, requested_by: null }), { token: LEGACY });
    const beforeReceipts = await receiptsForRepo();
    await installReceiptTrigger("fail", key(14));
    try {
      const failed = await post({
        reconcile: { repo: REPO, source: "github-label", seen_keys: [key(7)] },
      }, { token: LEGACY });
      assert.equal(failed.status, 500);
      const body = await failed.json() as { code: string };
      assert.equal(body.code, "internal_error");
      assert.equal(JSON.stringify(body).includes("injected"), false);
      assert.equal((await decisionRows(key(14)))[0].status, "open");
      assert.equal((await decisionRows(key(15)))[0].status, "open");
      assert.equal((await receiptsForRepo()).length, beforeReceipts.length);
    } finally {
      await dropReceiptTrigger("fail");
    }

    await installReceiptTrigger("suppress", key(14));
    try {
      const suppressed = await post({
        reconcile: { repo: REPO, source: "github-label", seen_keys: [key(7)] },
      }, { token: LEGACY });
      assert.equal(suppressed.status, 500);
      assert.equal((await decisionRows(key(14)))[0].status, "open");
      assert.equal((await decisionRows(key(15)))[0].status, "open");
      assert.equal((await receiptsForRepo()).length, beforeReceipts.length);
    } finally {
      await dropReceiptTrigger("suppress");
    }
  });

  it("returns the upsert receipt from request_decision and does not insert a second one", async () => {
    const agentId = `${PREFIX}-agent`;
    const slug = "pick";
    const decisionKey = `agent:${agentId}:${slug}`;
    const forbidden = await runWithPrincipal({ kind: "dev-open" }, () => requestDecisionTool({
      slug,
      title: `Need a call ${LEAK}`,
      why: LEAK,
    }));
    assert.equal(forbidden.isError, true);
    assert.equal((await decisionRows(decisionKey)).length, 0);
    assert.equal((await receiptsForKey(decisionKey)).length, 0);

    const invalid = await runWithPrincipal({ kind: "agent", id: agentId, scopes: ["decisions:request"] }, () => requestDecisionTool({
      slug: "Not A Slug",
      title: "Nope",
    }));
    assert.equal(invalid.isError, true);
    assert.equal((await receiptsForKey(decisionKey)).length, 0);

    const requested = await runWithPrincipal({ kind: "agent", id: agentId, scopes: ["decisions:request"] }, () => requestDecisionTool({
      slug,
      title: `Need a call ${LEAK}`,
      why: LEAK,
    }));
    assert.equal(requested.isError, undefined);
    const line = requested.content[0].text.split("\n").at(-1) ?? "";
    assert.match(line, /^receipt: \{/);
    const parsed = JSON.parse(line.slice("receipt: ".length)) as { id: string; kind: string };
    assert.equal(parsed.kind, "request_decision");
    assert.equal(requested.structuredContent?.receipt?.id, parsed.id);
    assert.equal(requested.structuredContent?.receipt?.kind, "request_decision");
    const rows = await decisionRows(decisionKey);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requested_by, agentId);
    assert.equal(rows[0].actor_type, null);
    const proof = await receiptsForKey(decisionKey);
    assert.equal(proof.length, 1);
    assert.equal(proof[0].id, parsed.id);
    assert.equal(proof[0].kind, "request_decision");
    assert.equal(proof[0].title, "Decision requested");
    const detail = detailOf(proof[0]);
    assert.equal(detail.operation, "request");
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, agentId);
    assert.equal(detail.decision_id, rows[0].id);
    assert.equal(detail.key, decisionKey);
    assert.equal(detail.source, "agent");
    assertNoLeak(detail);
    const duplicates = await sql`
      select count(*)::int as n from events
      where detail->>'decision_id' = ${String(rows[0].id)}
    `;
    assert.equal(Number(duplicates[0].n), 1);

    const oauthId = `${PREFIX}-oauth`;
    const oauth = await runWithPrincipal({ kind: "oauth", id: oauthId }, () => requestDecisionTool({
      slug: "oauth-pick",
      title: "OAuth request",
      why: LEAK,
    }));
    assert.equal(oauth.isError, undefined);
    const oauthKey = `agent:${oauthId}:oauth-pick`;
    const oauthProof = await receiptsForKey(oauthKey);
    assert.equal(oauthProof.length, 1);
    assert.equal(detailOf(oauthProof[0]).actor_type, "agent");
    assert.equal(detailOf(oauthProof[0]).actor_id, oauthId);
    assertNoLeak(detailOf(oauthProof[0]));

    const legacy = await runWithPrincipal({ kind: "legacy" }, () => requestDecisionTool({
      slug: "legacy-pick",
      title: "Legacy request",
      why: LEAK,
    }));
    assert.equal(legacy.isError, undefined);
    const legacyProof = await receiptsForKey(`agent:${LEGACY_ACTOR_ID}:legacy-pick`);
    assert.equal(legacyProof.length, 1);
    assert.equal(detailOf(legacyProof[0]).actor_id, LEGACY_ACTOR_ID);
    assertNoLeak(detailOf(legacyProof[0]));
  });

  it("rolls a request_decision back when its receipt is suppressed", async () => {
    const agentId = `${PREFIX}-suppress-agent`;
    const decisionKey = `agent:${agentId}:suppressed`;
    await installReceiptTrigger("suppress", decisionKey);
    try {
      await assert.rejects(() => runWithPrincipal(
        { kind: "agent", id: agentId, scopes: ["decisions:request"] },
        () => requestDecisionTool({ slug: "suppressed", title: `Hidden ${LEAK}`, why: LEAK }),
      ));
      assert.equal((await decisionRows(decisionKey)).length, 0);
      assert.equal((await receiptsForKey(decisionKey)).length, 0);
    } finally {
      await dropReceiptTrigger("suppress");
    }
  });

  it("labels a force-reopen from the status locked after a concurrent resolution", async () => {
    for (const [n, status] of [[21, "decided"], [24, "deferred"]] as const) {
      const seeded = await post(decisionBody(n, { title: "open", why: null, requested_by: null }), { token: LEGACY });
      assert.equal(seeded.status, 200);
      const before = await receiptsForKey(key(n));
      const response = await whileInsertWaits(
        (locker) => locker.query(
          "update decisions set status = $2, decision = 'concurrent resolution', actor_type = 'human', actor_id = 'concurrent-resolver' where key = $1",
          [key(n), status],
        ),
        () => post(decisionBody(n, { title: "reopened", why: LEAK, force: true }), { token: LEGACY }),
      );
      assert.equal(response.status, 200);
      const body = await response.json() as { decision: { status: string; actor_id: string | null; decision: string | null } };
      assert.equal(body.decision.status, "open");
      assert.equal(body.decision.actor_id, null);
      assert.equal(body.decision.decision, null);
      const row = await decisionRows(key(n));
      assert.equal(row[0].status, "open");
      assert.equal(row[0].actor_id, null);
      assert.equal(row[0].decision, null);
      const proof = await receiptsForKey(key(n));
      assert.equal(proof.length, before.length + 1);
      assert.equal(proof.at(-1)?.kind, "decision.force_reopen");
      const detail = detailOf(proof.at(-1)!);
      assert.equal(detail.operation, "force_reopen");
      assert.equal(detail.actor_type, "agent");
      assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
      assert.equal(detail.status, "open");
      assert.equal(detail.key, key(n));
      assertNoLeak(detail);
    }
  });

  it("labels a force-reopen when the conflicting row is inserted while the upsert waits", async () => {
    assert.equal((await decisionRows(key(22))).length, 0);
    const response = await whileInsertWaits(
      async (locker) => {
        await locker.query(
          `insert into decisions (
             key, source, repo, number, title, status, decision, actor_type, actor_id, decided_by, decided_at
           ) values ($1, 'github-label', $2, 22, 'born decided', 'decided', 'concurrent resolution', 'human', 'concurrent-resolver', 'concurrent-resolver', now())`,
          [key(22), REPO],
        );
      },
      () => post(decisionBody(22, { title: "reopened", why: LEAK, force: true }), { token: LEGACY }),
    );
    assert.equal(response.status, 200);
    const row = await decisionRows(key(22));
    assert.equal(row[0].status, "open");
    assert.equal(row[0].actor_id, null);
    assert.equal(row[0].decision, null);
    const proof = await receiptsForKey(key(22));
    assert.equal(proof.length, 1);
    assert.equal(proof[0].kind, "decision.force_reopen");
    const detail = detailOf(proof[0]);
    assert.equal(detail.operation, "force_reopen");
    assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
    assert.notEqual(detail.actor_id, "concurrent-resolver");
    assertNoLeak(detail);
  });

  it("keeps a waited force upsert as an upsert when the locked row is still open", async () => {
    const seeded = await post(decisionBody(23, { title: "open", why: null, requested_by: null }), { token: LEGACY });
    assert.equal(seeded.status, 200);
    const before = await receiptsForKey(key(23));
    const response = await whileInsertWaits(
      (locker) => locker.query("update decisions set title = 'held open' where key = $1", [key(23)]),
      () => post(decisionBody(23, { title: "still open", why: LEAK, force: true }), { token: LEGACY }),
    );
    assert.equal(response.status, 200);
    const row = await decisionRows(key(23));
    assert.equal(row[0].status, "open");
    assert.equal(row[0].actor_id, null);
    const proof = await receiptsForKey(key(23));
    assert.equal(proof.length, before.length + 1);
    assert.equal(proof.at(-1)?.kind, "decision.upsert");
    const detail = detailOf(proof.at(-1)!);
    assert.equal(detail.operation, "upsert");
    assert.equal(detail.status, "open");
    assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
    assertNoLeak(detail);
  });

  it("answers demo mode without writing when the database is unset", async () => {
    const beforeRows = await sql`select count(*)::int as n from decisions where repo = ${REPO}`;
    const beforeEvents = await sql`
      select count(*)::int as n from events where detail->>'key' like ${"github:" + REPO + "#%"}
    `;
    delete env.DATABASE_URL;
    try {
      const res = await post(decisionBody(16), { token: LEGACY });
      assert.equal(res.status, 200);
      const body = await res.json() as { demo?: boolean; decision?: unknown };
      assert.equal(body.demo, true);
      assert.equal(body.decision, undefined);
    } finally {
      env.DATABASE_URL = actorDecisionsFixture().url;
    }
    const afterRows = await sql`select count(*)::int as n from decisions where repo = ${REPO}`;
    const afterEvents = await sql`
      select count(*)::int as n from events where detail->>'key' like ${"github:" + REPO + "#%"}
    `;
    assert.equal(afterRows[0].n, beforeRows[0].n);
    assert.equal(afterEvents[0].n, beforeEvents[0].n);
  });
});

async function waitForInsertLock(pool: import("pg").Pool): Promise<boolean> {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const check = await pool.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%insert into decisions%' and pid <> pg_backend_pid()",
    );
    if (Number(check.rows[0]?.n) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Hold a conflicting row lock, prove the upsert statement is the waiter, then commit. */
async function whileInsertWaits(
  block: (locker: import("pg").PoolClient) => Promise<unknown>,
  start: () => Promise<Response>,
): Promise<Response> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: actorDecisionsFixture().url });
  const locker = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("begin");
    await block(locker);
    pending = start();
    assert.equal(await waitForInsertLock(pool), true, "decision upsert reached the conflicting row lock");
    await locker.query("commit");
    const response = await pending;
    pending = undefined;
    return response;
  } finally {
    if (pending) {
      await locker.query("rollback").catch(() => undefined);
      await pending.catch(() => undefined);
    }
    locker.release();
    await pool.end();
  }
}

async function installReceiptTrigger(mode: "fail" | "suppress", which: string) {
  await sql`drop trigger if exists ak_dec_fail_receipt on events`;
  await sql`drop trigger if exists ak_dec_suppress_receipt on events`;
  await sql`create table if not exists ak_dec_fail_key (key text primary key)`;
  await sql`create table if not exists ak_dec_suppress_key (key text primary key)`;
  if (mode === "fail") {
    await sql`delete from ak_dec_fail_key`;
    await sql`insert into ak_dec_fail_key (key) values (${which})`;
    await sql`
      create or replace function ak_dec_fail_receipt() returns trigger
      language plpgsql as $$
      begin
        if new.kind in ('decision.upsert', 'decision.force_reopen', 'decision.reconcile', 'request_decision')
           and (
             new.detail->>'key' in (select key from ak_dec_fail_key)
             or exists (
               select 1
               from jsonb_array_elements_text(coalesce(new.detail->'keys', '[]'::jsonb)) as item
               where item in (select key from ak_dec_fail_key)
             )
           ) then
          raise exception 'injected receipt failure';
        end if;
        return new;
      end;
      $$
    `;
    await sql`
      create trigger ak_dec_fail_receipt
      before insert on events
      for each row execute function ak_dec_fail_receipt()
    `;
    return;
  }
  await sql`delete from ak_dec_suppress_key`;
  await sql`insert into ak_dec_suppress_key (key) values (${which})`;
  await sql`
    create or replace function ak_dec_suppress_receipt() returns trigger
    language plpgsql as $$
    begin
      if new.kind in ('decision.upsert', 'decision.force_reopen', 'decision.reconcile', 'request_decision')
         and (
           new.detail->>'key' in (select key from ak_dec_suppress_key)
           or exists (
             select 1
             from jsonb_array_elements_text(coalesce(new.detail->'keys', '[]'::jsonb)) as item
             where item in (select key from ak_dec_suppress_key)
           )
         ) then
        return null;
      end if;
      return new;
    end;
    $$
  `;
  await sql`
    create trigger ak_dec_suppress_receipt
    before insert on events
    for each row execute function ak_dec_suppress_receipt()
  `;
}

async function dropReceiptTrigger(_mode: "fail" | "suppress") {
  await sql`drop trigger if exists ak_dec_fail_receipt on events`;
  await sql`drop trigger if exists ak_dec_suppress_receipt on events`;
  await sql`drop function if exists ak_dec_fail_receipt()`;
  await sql`drop function if exists ak_dec_suppress_receipt()`;
  await sql`drop table if exists ak_dec_fail_key`;
  await sql`drop table if exists ak_dec_suppress_key`;
}

function restoreEnv() {
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
  if (saved.driver === undefined) delete env.MC_DB_DRIVER;
  else env.MC_DB_DRIVER = saved.driver;
  if (saved.token === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = saved.token;
  if (saved.node === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = saved.node;
  if (saved.password === undefined) delete env.MC_DASHBOARD_PASSWORD;
  else env.MC_DASHBOARD_PASSWORD = saved.password;
}
