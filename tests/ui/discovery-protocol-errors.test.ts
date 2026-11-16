import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { discoveryFailureSummary, planDiscovery, type GhListedRepo, type OwnerRule, type TrackedRepo } from "../../src/lib/owner-discovery";
import { POST as postDiscover } from "../../src/app/api/settings/owners/discover/route";
import { GET as getOwners } from "../../src/app/api/settings/owners/route";

/**
 * Issue #52 Q6 owner-discovery item teaching. Real discover route and the
 * planner. Synthetic SQL only. Codes come from the branch that failed, not
 * from the collector's sentence. The public failure text is that code's
 * fixed summary, never the collector diagnostic.
 */

const env = process.env as Record<string, string | undefined>;
const KEYS = ["DATABASE_URL", "NODE_ENV", "MC_TOKEN", "MC_DASHBOARD_PASSWORD", "MC_DB_DRIVER"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
const FIXTURE_URL = "postgresql://discovery-test.invalid/none";
const SECRET = "password=discovery-probe-secret";
const COLLECTOR_SECRET = "SYNTHETIC-COLLECTOR-PRIVATE-VALUE";
const COLLECTION = discoveryFailureSummary("collection_failed");
const EMPTY = discoveryFailureSummary("empty_listing");
const INVALID = discoveryFailureSummary("invalid_listing");
const SWEPT = "2026-11-15T12:00:00.000Z";
const PUSHED = "2026-11-01T00:00:00.000Z";

const RULE: OwnerRule = { owner: "acme", activityDays: 30, includeForks: false, includeArchived: false };

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_TOKEN;
  delete env.MC_DASHBOARD_PASSWORD;
  env.NODE_ENV = "test";
  env.MC_DB_DRIVER = "pg";
  setSqlForTests(null);
});

afterEach(() => {
  setSqlForTests(null);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

function repo(name: string): GhListedRepo {
  return { name, pushedAt: PUSHED, isFork: false, isArchived: false };
}

function tracked(row: Partial<TrackedRepo> & { repo: string }): TrackedRepo {
  return {
    label: "App",
    short: "app",
    color: "#2563eb",
    blockedLabel: null,
    origin: "auto",
    pinned: false,
    hidden: false,
    gone: false,
    isFork: false,
    isArchived: false,
    lastActivityAt: PUSHED,
    position: 0,
    ...row,
  };
}

function discover(results: unknown[]): Promise<Response> {
  return postDiscover(new Request("http://localhost/api/settings/owners/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ results }),
  }));
}

function sweep(owner: string, extra: Record<string, unknown>) {
  return { owner, swept_at: SWEPT, ...extra };
}

type Item = {
  owner?: string;
  ok?: boolean;
  error?: string | null;
  code?: string;
  cause?: string;
  fix?: string;
  retryable?: boolean;
  skipped?: string;
  added?: unknown;
  updated?: unknown;
  marked_gone?: unknown;
};

function assertNoTeaching(item: Item) {
  const owner = item.owner ?? "item";
  assert.equal(Object.hasOwn(item, "code"), false, `${owner} code`);
  assert.equal(Object.hasOwn(item, "cause"), false, `${owner} cause`);
  assert.equal(Object.hasOwn(item, "fix"), false, `${owner} fix`);
  assert.equal(Object.hasOwn(item, "retryable"), false, `${owner} retryable`);
}

function assertFailed(item: Item, expected: { code: string; error: string; retryable: boolean; fix: string }) {
  const owner = item.owner ?? "item";
  assert.equal(item.ok, false, owner);
  assert.equal(item.error, expected.error, owner);
  assert.equal(item.cause, expected.error, owner);
  assert.equal(item.code, expected.code, owner);
  assert.equal(item.retryable, expected.retryable, owner);
  assert.equal(item.fix, expected.fix, owner);
}

describe("owner discovery item teaching", () => {
  it("classifies planner failures at the branch that failed", () => {
    const existing = [tracked({ repo: "acme/app" })];
    const collected = planDiscovery(existing, RULE, { repos: null, error: `HTTP 403 from the collector password=${COLLECTOR_SECRET}`, failureCode: null }, new Date(SWEPT));
    assert.equal(collected.failure, COLLECTION);
    assert.equal(collected.failure?.includes(COLLECTOR_SECRET), false);
    assert.equal(collected.failureCode, "collection_failed");
    assert.equal(collected.added.length, 0);
    assert.equal(collected.markedGone.length, 0);

    const misleading = planDiscovery(existing, RULE, { repos: [], error: `gh repo list failed password=${COLLECTOR_SECRET}` }, new Date(SWEPT));
    assert.equal(misleading.failure, EMPTY);
    assert.equal(misleading.failure?.includes(COLLECTOR_SECRET), false);
    assert.equal(misleading.failureCode, "empty_listing");

    const unnamed = planDiscovery(existing, RULE, { repos: null, error: "   " }, new Date(SWEPT));
    assert.equal(unnamed.failure, COLLECTION);
    assert.equal(unnamed.failureCode, "collection_failed");

    const unsafe = planDiscovery(existing, RULE, { repos: [repo("app"), repo("bad name")], error: null }, new Date(SWEPT));
    assert.equal(unsafe.failure, INVALID);
    assert.equal(unsafe.failureCode, "invalid_listing");
    assert.deepEqual(unsafe.repos.map((row) => row.gone), existing.map((row) => row.gone));

    const applied = planDiscovery(existing, RULE, { repos: [repo("app")], error: null, truncated: true }, new Date(SWEPT));
    assert.equal(applied.failure, null);
    assert.equal(applied.failureCode, null);
    assert.match(applied.warning ?? "", /not marked gone/);
    assert.equal(applied.markedGone.length, 0);
  });

  it("teaches each failed batch item and leaves warnings, success, and stale alone", async () => {
    env.DATABASE_URL = FIXTURE_URL;
    const owners = ["acme", "warn", "emptyo", "bado", "downo", "prose", "staleo", "shifted", "removedo"];
    const inserts: unknown[][] = [];
    const updates: unknown[][] = [];
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "begin" || text === "commit" || text === "rollback") return [];
      if (text.includes("from watched_owners") && text.includes("where owner")) {
        const owner = String(values[0]);
        if (owner === "removedo") return [];
        if (owner === "shifted") return [ownerRow(owner, 7, null)];
        if (owner === "staleo") return [ownerRow(owner, 30, SWEPT)];
        return [ownerRow(owner, 30, null)];
      }
      if (text.includes("from watched_owners")) return owners.map((owner) => ownerRow(owner, 30, null));
      if (text.includes("from watched_repos")) return [quietRow()];
      if (text.includes("update watched_owners")) {
        updates.push(values);
        const owner = values[values.length - 1];
        return typeof owner === "string" ? [{ owner }] : [];
      }
      if (text.includes("insert into watched_repos")) {
        inserts.push(values);
        const repos = values[0];
        return Array.isArray(repos) ? repos.map((repo) => ({ repo: String(repo) })) : [];
      }
      if (text.includes("insert into events")) {
        const kind = typeof values[0] === "string" ? values[0] : "";
        return kind ? [{ id: 1, kind, created_at: "2026-11-15T00:00:00.000Z" }] : [];
      }
      return [];
    });

    const res = await discover([
      sweep("acme", { ok: true, repos: [repo("app")] }),
      sweep("warn", { ok: true, truncated: true, repos: [repo("seen")] }),
      sweep("emptyo", { ok: true, repos: [], error: "gh repo list failed" }),
      sweep("bado", { ok: true, repos: [repo("bad name")] }),
      sweep("downo", { ok: false, error: "HTTP 403" }),
      sweep("prose", { ok: false, error: "gh repo list returned no repos" }),
      sweep("ghost", { ok: true, repos: [repo("app")] }),
      { owner: "staleo", ok: true, swept_at: "2020-01-01T00:00:00.000Z", repos: [repo("app")] },
      sweep("shifted", { ok: true, repos: [repo("app")] }),
      sweep("removedo", { ok: true, repos: [repo("app")] }),
    ]);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json() as { code?: string; results: Item[] };
    assert.equal(Object.hasOwn(body, "code"), false);
    assert.equal(body.results.length, 10);
    const byOwner = new Map(body.results.map((item) => [item.owner, item]));

    const acme = byOwner.get("acme")!;
    assert.equal(acme.ok, true);
    assert.equal(acme.error, null);
    assert.equal(acme.added, 1);
    assert.equal(acme.updated, 0);
    assert.equal(acme.marked_gone, 0);
    assertNoTeaching(acme);

    const warn = byOwner.get("warn")!;
    assert.equal(warn.ok, true);
    assert.match(warn.error ?? "", /not marked gone/);
    assert.equal(warn.marked_gone, 0);
    assertNoTeaching(warn);

    assertFailed(byOwner.get("emptyo")!, {
      code: "empty_listing",
      error: EMPTY,
      retryable: true,
      fix: "Retry the tick with the repositories the collector found. An empty list is not a completed sweep.",
    });
    assertFailed(byOwner.get("bado")!, {
      code: "invalid_listing",
      error: INVALID,
      retryable: false,
      fix: "Correct the listing and send the tick again. A value that is not safe to store was not applied.",
    });
    assertFailed(byOwner.get("downo")!, {
      code: "collection_failed",
      error: COLLECTION,
      retryable: true,
      fix: "Retry the tick after the collector can list repositories. This sweep did not change tracked repos.",
    });
    assertFailed(byOwner.get("prose")!, {
      code: "collection_failed",
      error: COLLECTION,
      retryable: true,
      fix: "Retry the tick after the collector can list repositories. This sweep did not change tracked repos.",
    });
    const ghost = byOwner.get("ghost")!;
    assertFailed(ghost, {
      code: "owner_not_watched",
      error: "owner is not watched",
      retryable: false,
      fix: "Watch this owner in owner settings, or send a sweep for an owner that is already watched.",
    });
    assert.equal(ghost.added, 0);
    assert.equal(ghost.updated, 0);
    assert.equal(ghost.marked_gone, 0);

    const stale = byOwner.get("staleo")!;
    assert.equal(stale.ok, true);
    assert.equal(stale.skipped, "stale");
    assert.equal(stale.error, null);
    assert.equal(stale.added, 0);
    assertNoTeaching(stale);

    const shifted = byOwner.get("shifted")!;
    assert.equal(shifted.skipped, "rule_changed");
    assertFailed(shifted, {
      code: "rule_changed",
      error: "skipped: rule_changed",
      retryable: false,
      fix: "Read owner settings again and send a new sweep. The discovery rule changed before this sweep was saved.",
    });
    const removed = byOwner.get("removedo")!;
    assert.equal(removed.skipped, "owner_removed");
    assertFailed(removed, {
      code: "owner_removed",
      error: "skipped: owner_removed",
      retryable: false,
      fix: "Read owner settings again. This owner was removed before the sweep was saved.",
    });

    const written = JSON.stringify(inserts);
    assert.match(written, /acme\/app/);
    assert.match(written, /warn\/seen/);
    for (const owner of ["emptyo", "bado", "downo", "prose", "ghost", "staleo", "shifted", "removedo"]) {
      assert.doesNotMatch(written, new RegExp(`${owner}/`));
    }
    const storedErrors = updates.map((values) => values[0]);
    assert.equal(storedErrors.filter((value) => value === COLLECTION).length, 2);
    assert.ok(storedErrors.includes(EMPTY));
    assert.ok(storedErrors.includes(INVALID));
    assert.equal(storedErrors.includes("HTTP 403"), false);
    assert.equal(storedErrors.includes("gh repo list failed"), false);
    assert.equal(storedErrors.includes("collection_failed"), false);
    assert.equal(storedErrors.includes("empty_listing"), false);
    assert.equal(updates.length, 6, "success, warning, and four listing failures record last_error; skips do not");
    assert.equal(inserts.length, 2, "only the applied owners write repos");
  });

  it("keeps setup and short-name conflicts on the whole request", async () => {
    const missing = await discover([sweep("acme", { ok: true, repos: [repo("app")] })]);
    assert.equal(missing.status, 409);
    const missingBody = await missing.json() as { code: string; retryable: boolean; fix: string; error: string; results: Item[] };
    assert.equal(missingBody.code, "conflict");
    assert.equal(missingBody.retryable, false);
    assert.equal(missingBody.fix, "Connect a database (DATABASE_URL) and retry the tick.");
    assertFailed(missingBody.results[0], {
      code: "discovery_not_configured",
      error: "no database",
      retryable: false,
      fix: "Connect a database (DATABASE_URL) and retry the tick.",
    });
    assert.deepEqual(missingBody.results[0].added, []);

    env.DATABASE_URL = FIXTURE_URL;
    setSqlForTests(async () => {
      const err = new Error('relation "watched_owners" does not exist');
      (err as { code?: string }).code = "42P01";
      throw err;
    });
    const unready = await discover([sweep("acme", { ok: true, repos: [repo("app")] })]);
    assert.equal(unready.status, 409);
    const unreadyBody = await unready.json() as { code: string; retryable: boolean; results: Item[] };
    assert.equal(unreadyBody.code, "conflict");
    assert.equal(unreadyBody.retryable, false);
    assertFailed(unreadyBody.results[0], {
      code: "discovery_not_configured",
      error: "owner store is not writable",
      retryable: false,
      fix: "Apply supabase/migrations/20261028_watched_owners.sql, then retry the tick.",
    });
    assert.deepEqual(unreadyBody.results[0].marked_gone, []);

    let inserts = 0;
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "begin" || text === "commit" || text === "rollback") return [];
      if (text.includes("from watched_owners") && !text.includes("update")) return [ownerRow("acme", 30, null)];
      if (text.includes("update watched_owners")) {
        const owner = values[values.length - 1];
        return typeof owner === "string" ? [{ owner }] : [];
      }
      if (text.includes("insert into watched_repos")) {
        inserts += 1;
        const err = new Error('duplicate key value violates unique constraint "watched_repos_short_key"');
        (err as { code?: string }).code = "23505";
        throw err;
      }
      return [];
    });
    const conflict = await discover([sweep("acme", { ok: true, repos: [repo("app")] })]);
    assert.equal(conflict.status, 409, JSON.stringify(await conflict.clone().json()));
    const conflictBody = await conflict.json() as { code: string; retryable: boolean; fix: string; results: Item[] };
    assert.equal(conflictBody.code, "conflict");
    assert.equal(conflictBody.retryable, false);
    assert.equal(conflictBody.fix, "Retry the tick.");
    assertFailed(conflictBody.results[0], {
      code: "short_name_conflict",
      error: "short name conflict",
      retryable: true,
      fix: "Retry the tick.",
    });
    assert.deepEqual(conflictBody.results[0].added, []);
    assert.deepEqual(conflictBody.results[0].updated, []);
    assert.deepEqual(conflictBody.results[0].marked_gone, []);
    assert.equal(inserts, 2);
  });

  it("rejects a malformed listing for the whole request and does not complete a thrown apply", async () => {
    env.DATABASE_URL = FIXTURE_URL;
    let calls = 0;
    setSqlForTests(async () => {
      calls += 1;
      return [];
    });
    const bad = await discover([sweep("acme", {
      ok: true,
      repos: [repo("App"), { name: "app", pushedAt: PUSHED, isFork: false, isArchived: false }],
    })]);
    assert.equal(bad.status, 400, JSON.stringify(await bad.clone().json()));
    const badBody = await bad.json() as { code?: string; results?: unknown };
    assert.equal(badBody.code, "validation_failed");
    assert.equal(badBody.results, undefined);
    assert.equal(calls, 0);

    setSqlForTests(async (strings) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "begin" || text === "commit" || text === "rollback") return [];
      if (text.includes("from watched_owners")) return [ownerRow("acme", 30, null)];
      if (text.includes("update watched_owners")) throw new Error(`lookup failed ${SECRET}`);
      return [];
    });
    const blown = await discover([sweep("acme", { ok: false, error: "HTTP 403" })]);
    assert.equal(blown.status, 500, JSON.stringify(await blown.clone().json()));
    const blownText = JSON.stringify(await blown.json());
    assert.match(blownText, /Could not apply discovery/);
    assert.match(blownText, /internal_error/);
    assert.doesNotMatch(blownText, /discovery-probe-secret/);
    assert.equal(blownText.includes("\"ok\":true"), false);
  });

  it("does not copy a collector diagnostic into the item, last_error, or owner inventory", async () => {
    env.DATABASE_URL = FIXTURE_URL;
    let repoWrites = 0;
    let storedError: unknown = null;
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ").replace(/\s+/g, " ").toLowerCase();
      if (text.includes("insert into events")) {
        const kind = typeof values[0] === "string" ? values[0] : "";
        return kind ? [{ id: 1, kind, created_at: "2026-11-15T00:00:00.000Z" }] : [];
      }
      if (text.includes("from watched_owners") && !text.includes("update")) {
        return [ownerRow("acme", 30, null, storedError)];
      }
      if (text.includes("update watched_owners")) {
        storedError = values[0];
        const owner = values[values.length - 1];
        return typeof owner === "string" ? [{ owner }] : [];
      }
      if (text.includes("insert into watched_repos")) repoWrites += 1;
      return [];
    });

    const res = await discover([
      sweep("acme", {
        ok: false,
        error: `gh failed password=${COLLECTOR_SECRET}`,
        failureCode: "owner_removed",
      }),
    ]);
    assert.equal(res.status, 200);
    const body = await res.json() as { results: Item[] };
    const item = body.results[0]!;
    assert.equal(item.code, "collection_failed");
    assert.equal(item.error, COLLECTION);
    assert.equal(item.cause, COLLECTION);
    assert.equal(repoWrites, 0);
    assert.equal(storedError, COLLECTION);

    const readback = await getOwners(new Request("http://localhost/api/settings/owners"));
    assert.equal(readback.status, 200);
    const ownerBody = await readback.json() as { owners: { last_error: string | null }[] };
    assert.equal(ownerBody.owners[0]?.last_error, COLLECTION);
    const leaked = JSON.stringify({ item, storedError, owners: ownerBody.owners });
    assert.equal(leaked.includes(COLLECTOR_SECRET), false);
    assert.equal(leaked.includes("owner_removed"), false);
  });
});

function ownerRow(owner: string, activity: number, discovered: string | null, lastError: unknown = null): Row {
  return {
    owner,
    activity_days: activity,
    include_forks: false,
    include_archived: false,
    last_error: lastError,
    last_error_at: null,
    last_discovered_at: discovered,
    actor_type: null,
    actor_id: null,
  };
}

function quietRow(): Row {
  return {
    repo: "warn/quiet",
    label: "Quiet",
    short: "quiet",
    color: "#2563eb",
    blocked_label: null,
    position: 0,
    origin: "auto",
    pinned: false,
    hidden: false,
    gone: false,
    is_fork: false,
    is_archived: false,
    last_activity_at: "2020-01-01T00:00:00.000Z",
    fields_overridden: null,
  };
}
