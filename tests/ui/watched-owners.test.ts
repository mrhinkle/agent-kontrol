import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { diffRepoList } from "../../src/lib/dry-run";
import {
  MS_PER_DAY,
  briefShown,
  planDiscovery,
  type GhListedRepo,
  type OwnerRule,
  type TrackedRepo,
} from "../../src/lib/owner-discovery";
import { validateOwnerList, validateOwnerName } from "../../src/lib/owner-validation";
import { MAX_REPOS, validateRepoList } from "../../src/lib/repo-validation";
import { authorizeRoute, scopeForRoute } from "../../src/lib/scopes";
import { applyOwnerDiscovery, ownerListVersion } from "../../src/lib/watched-owners";
import { getWatchedRepos, visibleOnBoard } from "../../src/lib/watched-repos";
import { GET as getOwners, PUT as putOwners } from "../../src/app/api/settings/owners/route";
import { POST as postDiscover } from "../../src/app/api/settings/owners/discover/route";

/**
 * Failure cases for watched_owners (#66). Each test tries to make discovery
 * delete, hide, or confuse a repo it should have left alone.
 */

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
  node: env.NODE_ENV,
};
const FIXTURE_URL = "postgres://test:test@127.0.0.1:5432/ak_owners";
const NOW = new Date("2026-10-28T00:00:00.000Z");

function restoreEnv() {
  for (const [key, value] of [
    ["DATABASE_URL", saved.db],
    ["MC_DB_DRIVER", saved.driver],
    ["MC_TOKEN", saved.token],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["NODE_ENV", saved.node],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

afterEach(() => {
  setSqlForTests(null);
  resetCredentialsForTests();
  restoreEnv();
});

function owner(patch: Partial<OwnerRule> = {}): OwnerRule {
  return { owner: "acme", activityDays: 30, includeForks: false, includeArchived: false, ...patch };
}

function tracked(patch: Partial<TrackedRepo> & { repo: string }): TrackedRepo {
  return {
    label: patch.repo.split("/")[1] ?? "repo",
    short: (patch.repo.split("/")[1] ?? "repo").slice(0, 12),
    color: "#2563eb",
    blockedLabel: null,
    origin: "auto",
    pinned: false,
    hidden: false,
    gone: false,
    isFork: false,
    isArchived: false,
    lastActivityAt: new Date(NOW.getTime() - MS_PER_DAY).toISOString(),
    position: 0,
    ...patch,
  };
}

function listed(name: string, ageDays: number, flags: Partial<GhListedRepo> = {}): GhListedRepo {
  return {
    name,
    pushedAt: new Date(NOW.getTime() - ageDays * MS_PER_DAY).toISOString(),
    isArchived: false,
    isFork: false,
    ...flags,
  };
}

function atAge(days: number, extraMs = 0): string {
  return new Date(NOW.getTime() - (days * MS_PER_DAY + extraMs)).toISOString();
}

describe("watched owners discovery", () => {
  it("F1 a failed, rate-limited, or empty gh list does not delete or hide tracked repos", async () => {
    const existing = [
      tracked({ repo: "acme/app", label: "Keep me", short: "app", pinned: true, hidden: false, origin: "manual" }),
      tracked({ repo: "acme/quiet", origin: "auto", lastActivityAt: atAge(90) }),
    ];
    const sweeps = [
      { repos: null, error: "gh repo list failed: HTTP 403", truncated: false },
      { repos: null, error: "rate limited", truncated: false },
      { repos: [] as GhListedRepo[], error: null, truncated: false },
    ];
    for (const sweep of sweeps) {
      const outcome = planDiscovery(existing, owner(), sweep, NOW);
      assert.ok(outcome.failure, `empty or failed sweep must be visible, got ${JSON.stringify(outcome)}`);
      assert.equal(outcome.added.length, 0);
      assert.equal(outcome.markedGone.length, 0);
      assert.deepEqual(
        outcome.repos.map((row) => ({ repo: row.repo, gone: row.gone, hidden: row.hidden, origin: row.origin, label: row.label })),
        existing.map((row) => ({ repo: row.repo, gone: row.gone, hidden: row.hidden, origin: row.origin, label: row.label })),
      );
    }

    const calls: string[] = [];
    setSqlForTests(async (strings) => {
      calls.push(strings.join(" "));
      return [];
    });
    const failed = await applyOwnerDiscovery(owner(), existing, { repos: [], error: "gh repo list returned no repos", truncated: false }, NOW);
    assert.match(failed.failure ?? "", /no repos/);
    const failedSql = calls.join("\n");
    assert.doesNotMatch(failedSql, /watched_repos/, "a failed sweep must not write watched_repos");
    assert.match(failedSql, /update watched_owners/);
    assert.doesNotMatch(calls.find((sql) => /update watched_owners/i.test(sql)) ?? "", /actor_type/);

    calls.length = 0;
    const truncated = await applyOwnerDiscovery(
      owner(),
      existing,
      { repos: [listed("app", 1)], error: null, truncated: true },
      NOW,
    );
    assert.equal(truncated.failure, null);
    assert.match(truncated.warning ?? "", /not marked gone/);
    assert.equal(truncated.repos.find((row) => row.repo === "acme/quiet")?.gone, false);
    const repoWrite = calls.find((sql) => /insert into watched_repos/i.test(sql)) ?? "";
    assert.match(repoWrite, /insert into watched_repos/);
    assert.doesNotMatch(repoWrite, /origin = excluded\.origin/);
    assert.doesNotMatch(repoWrite, /pinned = excluded\.pinned/);
    assert.doesNotMatch(repoWrite, /actor_type/);
  });

  it("F2 a quiet repo stays stored and leaves the brief only after activity_days", () => {
    const rule = owner({ activityDays: 30 });
    const quiet = tracked({ repo: "acme/quiet", origin: "auto", lastActivityAt: atAge(31) });
    const outcome = planDiscovery([quiet], rule, { repos: [listed("quiet", 31), listed("fresh", 1)], error: null }, NOW);
    assert.equal(outcome.failure, null);
    const kept = outcome.repos.find((row) => row.repo === "acme/quiet");
    assert.ok(kept, "quiet repo must stay in the database");
    assert.equal(kept.gone, false);
    assert.equal(briefShown(kept, rule, NOW), false);
    assert.equal(briefShown(tracked({ repo: "acme/quiet", origin: "auto", lastActivityAt: atAge(29) }), rule, NOW), true);
    assert.equal(briefShown(tracked({ repo: "acme/quiet", origin: "auto", lastActivityAt: atAge(30) }), rule, NOW), true);
    assert.equal(briefShown(tracked({ repo: "acme/quiet", origin: "auto", lastActivityAt: atAge(30, 1) }), rule, NOW), false);
    const boundary = tracked({ repo: "acme/edge", origin: "auto", lastActivityAt: atAge(30) });
    assert.equal(briefShown({ ...boundary, lastActivityAt: atAge(29) }, rule, NOW), true, "activity_days-1 is shown");
    assert.equal(briefShown(boundary, rule, NOW), true, "exactly activity_days is shown");
    assert.equal(briefShown({ ...boundary, lastActivityAt: atAge(31) }, rule, NOW), false, "activity_days+1 is not shown");
  });

  it("F3 forks and archived repos are excluded unless the flags are set", () => {
    const existing = [
      tracked({ repo: "acme/forked", origin: "auto", isFork: true, pinned: false }),
      tracked({ repo: "acme/old-archive", origin: "manual", isArchived: true }),
    ];
    const listedRepos = [listed("forked", 1, { isFork: true }), listed("archived", 1, { isArchived: true }), listed("app", 1)];
    const off = planDiscovery(existing, owner(), { repos: listedRepos, error: null }, NOW);
    assert.equal(off.repos.find((row) => row.repo === "acme/forked")?.gone, false);
    assert.equal(off.repos.some((row) => row.repo === "acme/archived"), false, "a filtered-out repo is not added");
    assert.equal(briefShown(off.repos.find((row) => row.repo === "acme/forked")!, owner(), NOW), false);
    assert.equal(briefShown({ ...existing[1], isArchived: true }, owner(), NOW), false);
    assert.equal(briefShown({ ...existing[0], pinned: true }, owner(), NOW), true, "pin still shows an excluded fork");
    assert.ok(off.repos.some((row) => row.repo === "acme/app" && row.origin === "auto"));

    const on = planDiscovery(
      [],
      owner({ includeForks: true, includeArchived: true }),
      { repos: listedRepos, error: null },
      NOW,
    );
    assert.deepEqual(on.added.sort(), ["acme/app", "acme/archived", "acme/forked"].sort());
    for (const repo of on.repos) assert.equal(briefShown(repo, owner({ includeForks: true, includeArchived: true }), NOW), true);
  });

  it("F4 same-named repos under two owners stay distinct", () => {
    const acme = planDiscovery([], owner({ owner: "acme" }), { repos: [listed("app", 1)], error: null }, NOW);
    const other = planDiscovery(acme.repos, owner({ owner: "other" }), { repos: [listed("app", 2)], error: null }, NOW);
    const names = other.repos.map((row) => row.repo).sort();
    assert.deepEqual(names, ["acme/app", "other/app"]);
    assert.notEqual(other.repos[0].short, other.repos[1].short, "shorts may collide; identity must not");
    const second = planDiscovery(other.repos, owner({ owner: "acme" }), { repos: [listed("App", 1)], error: null }, NOW);
    assert.equal(second.repos.filter((row) => row.repo.toLowerCase() === "acme/app").length, 1);
    assert.equal(second.markedGone.includes("other/app"), false);
    assert.equal(second.repos.find((row) => row.repo === "other/app")?.gone, false);
    assert.equal(second.repos.find((row) => row.short === "app")?.repo, "acme/app");
  });

  it("F5 pin shows, hide collects without showing, and hide beats pin and discovery", () => {
    const rule = owner();
    const quiet = atAge(90);
    const pinned = tracked({ repo: "acme/app", origin: "auto", pinned: true, hidden: false, lastActivityAt: quiet });
    const hidden = tracked({ repo: "acme/app", origin: "auto", pinned: false, hidden: true, lastActivityAt: atAge(1) });
    const both = tracked({ repo: "acme/app", origin: "auto", pinned: true, hidden: true, lastActivityAt: atAge(1) });
    const gone = tracked({ repo: "acme/app", origin: "auto", pinned: true, hidden: false, gone: true, lastActivityAt: atAge(1) });
    assert.equal(briefShown(pinned, rule, NOW), true);
    assert.equal(briefShown(hidden, rule, NOW), false);
    assert.equal(briefShown(both, rule, NOW), false, "Hide wins over pin.");
    assert.equal(briefShown(gone, rule, NOW), false, "A repo marked gone is not shown, including when it is pinned.");
    const discovered = planDiscovery(
      [tracked({ repo: "acme/app", origin: "manual", hidden: true, pinned: true, label: "Mine", short: "mine" })],
      rule,
      { repos: [listed("app", 1)], error: null },
      NOW,
    );
    const row = discovered.repos.find((item) => item.repo === "acme/app");
    assert.equal(row?.hidden, true);
    assert.equal(row?.origin, "manual");
    assert.equal(row?.label, "Mine");
    assert.equal(briefShown(row!, rule, NOW), false);
    const source = fs.readFileSync("src/lib/owner-discovery.ts", "utf8");
    assert.match(source, /Hide wins over pin\./);
    assert.match(source, /A repo marked gone is not shown, including when it is pinned\./);
    assert.match(fs.readFileSync("docs/API.md", "utf8"), /Hide wins over pin\./);
    assert.match(fs.readFileSync("docs/PROGRESS-BOARD.md", "utf8"), /A repo marked gone is not shown, including when it is pinned\./);
  });

  it("F6 a second tick does not duplicate rows or flap auto and manual flags", () => {
    const manual = tracked({
      repo: "acme/app",
      origin: "manual",
      label: "Hand",
      short: "hand",
      color: "#112233",
      pinned: true,
      hidden: false,
      blockedLabel: "blocked",
      position: 4,
      lastActivityAt: "2026-10-27T00:00:00.000Z",
    });
    const sweep = {
      repos: [listed("app", 1), listed("app", 3), listed("other", 1)],
      error: null,
    };
    const first = planDiscovery([manual], owner(), sweep, NOW);
    const second = planDiscovery(first.repos, owner(), sweep, NOW);
    assert.equal(second.repos.filter((row) => row.repo === "acme/app").length, 1);
    assert.equal(second.repos.filter((row) => row.repo === "acme/other").length, 1);
    assert.deepEqual(second.repos, first.repos);
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.updated, []);
    const kept = second.repos.find((row) => row.repo === "acme/app");
    assert.equal(kept?.origin, "manual");
    assert.equal(kept?.label, "Hand");
    assert.equal(kept?.short, "hand");
    assert.equal(kept?.color, "#112233");
    assert.equal(kept?.pinned, true);
    assert.equal(kept?.blockedLabel, "blocked");
    assert.equal(kept?.lastActivityAt, "2026-10-27T00:00:00.000Z");
    const auto = second.repos.find((row) => row.repo === "acme/other");
    assert.equal(auto?.origin, "auto");
    const again = planDiscovery(second.repos, owner(), sweep, NOW);
    assert.equal(again.repos.find((row) => row.repo === "acme/other")?.origin, "auto");
  });

  it("F7 invalid owners are rejected by validation and by the owners route", async () => {
    const bad = ["", " ", "  acme", "acme  ", "acme/app", "../etc", "..", "a\\b", "%2e%2e", "a".repeat(40), "-acme", "acme-", "acme--app", "acme app"];
    for (const ownerName of bad) {
      const one = validateOwnerName(ownerName);
      assert.equal(one.ok, false, `expected reject for ${JSON.stringify(ownerName)}`);
      const list = validateOwnerList([{ owner: ownerName }]);
      assert.equal(list.ok, false);
    }
    assert.equal(validateOwnerName("Acme").ok && validateOwnerName("Acme").ok && (validateOwnerName("Acme") as { owner: string }).owner, "acme");
    const accepted = validateOwnerName("Acme");
    assert.equal(accepted.ok && accepted.owner, "acme");
    assert.equal(validateOwnerList([]).ok, true);
    assert.equal(validateOwnerList([{ owner: "acme" }, { owner: "Acme" }]).ok, false);
    assert.equal(validateOwnerList([{ owner: "acme", activity_days: 1.5 }]).ok, false);
    assert.equal(validateOwnerList([{ owner: "acme", activity_days: 30, activityDays: 30 }]).ok, false);
    assert.equal(validateOwnerList([{ owner: "acme", include_forks: "yes" }]).ok, false);
    assert.equal(validateOwnerList([{ owner: "acme", activity_days: 0 }]).ok, false);
    const settings = fs.readFileSync("src/components/OwnerSettings.tsx", "utf8");
    assert.match(settings, /validateOwnerList/);
    assert.doesNotMatch(settings, /owner\.trim\(\)/);

    env.NODE_ENV = "test";
    delete env.DATABASE_URL;
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    const calls: string[] = [];
    setSqlForTests(async (strings) => {
      calls.push(strings.join(" "));
      return [];
    });
    const res = await putOwners(new Request("http://localhost/api/settings/owners", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owners: [{ owner: "acme/app" }, { owner: " " }, { owner: "../etc" }] }),
    }));
    assert.equal(res.status, 400);
    const body = await res.json() as { code?: string; errors?: { message: string }[] };
    assert.equal(body.code, "validation_failed");
    assert.ok((body.errors?.length ?? 0) >= 3);
    assert.equal(calls.length, 0, "invalid owners must not touch the database");
  });

  it("F8 owner writes use the repos auth and record the actor", async () => {
    assert.equal(scopeForRoute("PUT", "/api/settings/owners"), scopeForRoute("PUT", "/api/settings/repos"));
    assert.equal(scopeForRoute("GET", "/api/settings/owners"), null);
    assert.equal(scopeForRoute("POST", "/api/settings/owners/discover"), null);
    assert.equal(scopeForRoute("PATCH", "/api/settings/repos"), null);
    const agent = { kind: "agent" as const, id: "cred-1", scopes: ["tasks:write"] };
    const legacy = { kind: "legacy" as const, id: "mc-token" };
    assert.equal(authorizeRoute(agent, "PUT", "/api/settings/owners").ok, false);
    assert.equal(authorizeRoute(agent, "PUT", "/api/settings/repos").ok, false);
    assert.equal(authorizeRoute(legacy, "PUT", "/api/settings/owners").ok, true);
    assert.equal(authorizeRoute(legacy, "POST", "/api/settings/owners/discover").ok, true);

    env.NODE_ENV = "test";
    delete env.DATABASE_URL;
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    resetCredentialsForTests();
    const created = await createCredential({ label: "owner probe", scopes: ["tasks:write"] });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const denied = await putOwners(new Request("http://localhost/api/settings/owners", {
      method: "PUT",
      headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" },
      body: JSON.stringify({ owners: [{ owner: "acme" }] }),
    }));
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json() as { code?: string };
    assert.equal(deniedBody.code, "insufficient_scope");

    env.DATABASE_URL = FIXTURE_URL;
    env.MC_DB_DRIVER = "pg";
    env.MC_TOKEN = "owners-mc-token";
    const stored: Row[] = [];
    const writes: unknown[][] = [];
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ").replace(/\s+/g, " ").toLowerCase();
      if (text.includes("insert into watched_owners")) {
        writes.push(values);
        const names = values[0] as string[];
        stored.length = 0;
        names.forEach((name, i) => {
          stored.push({
            owner: name,
            activity_days: (values[1] as number[])[i],
            include_forks: (values[2] as boolean[])[i],
            include_archived: (values[3] as boolean[])[i],
            actor_type: values[4],
            actor_id: values[5],
            last_error: null,
            last_error_at: null,
            last_discovered_at: null,
          });
        });
        return [];
      }
      if (text.includes("from watched_owners")) return stored;
      if (text.includes("from watched_repos") || text.includes("from agent_credentials")) return [];
      return [];
    });

    const tokenRes = await putOwners(new Request("http://localhost/api/settings/owners", {
      method: "PUT",
      headers: { authorization: "Bearer owners-mc-token", "content-type": "application/json" },
      body: JSON.stringify({ owners: [{ owner: "Acme", activity_days: 14 }] }),
    }));
    assert.equal(tokenRes.status, 200, JSON.stringify(await tokenRes.clone().json()));
    assert.equal(writes.at(-1)?.[4], "agent");
    assert.equal(writes.at(-1)?.[5], "mc-token");
    const tokenBody = await tokenRes.json() as { owners: { actor_type: string; actor_id: string; owner: string }[] };
    assert.equal(tokenBody.owners[0].owner, "acme");
    assert.equal(tokenBody.owners[0].actor_type, "agent");
    assert.equal(tokenBody.owners[0].actor_id, "mc-token");

    env.MC_DASHBOARD_PASSWORD = "owners-dashboard";
    const cookie = await authCookieValue("owners-dashboard");
    const sessionRes = await putOwners(new Request("http://localhost/api/settings/owners", {
      method: "PUT",
      headers: { cookie: `mc_auth=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ owners: [{ owner: "acme" }] }),
    }));
    assert.equal(sessionRes.status, 200, JSON.stringify(await sessionRes.clone().json()));
    assert.equal(writes.at(-1)?.[4], "human");
    assert.equal(writes.at(-1)?.[5], "operator");

    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    const openRes = await putOwners(new Request("http://localhost/api/settings/owners", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owners: [{ owner: "acme" }] }),
    }));
    assert.equal(openRes.status, 200, JSON.stringify(await openRes.clone().json()));
    assert.equal(writes.at(-1)?.[4], null);
    assert.equal(writes.at(-1)?.[5], null);
    const discoverSql: string[] = [];
    setSqlForTests(async (strings) => {
      discoverSql.push(strings.join(" "));
      if (strings.join(" ").includes("from watched_owners")) {
        return [{ owner: "acme", activity_days: 30, include_forks: false, include_archived: false, actor_type: "human", actor_id: "operator" }];
      }
      if (strings.join(" ").includes("from watched_repos")) return [];
      return [];
    });
    const discovered = await postDiscover(new Request("http://localhost/api/settings/owners/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        results: [{ owner: "acme", ok: true, repos: [{ name: "app", pushedAt: atAge(1), isFork: false, isArchived: false }] }],
      }),
    }));
    assert.equal(discovered.status, 200, JSON.stringify(await discovered.clone().json()));
    const updates = discoverSql.filter((sql) => /update watched_owners/i.test(sql));
    assert.ok(updates.length > 0);
    assert.ok(updates.every((sql) => !/actor_type\s*=/i.test(sql)));
  });

  it("F9 existing watched_repos rows and routes stay valid", async () => {
    const migration = fs.readFileSync("supabase/migrations/20261028_watched_owners.sql", "utf8");
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    for (const text of [migration, schema]) {
      assert.doesNotMatch(text, /drop table\s+watched_repos/i);
      assert.doesNotMatch(text, /drop column/i);
      assert.match(text, /create table if not exists watched_owners/i);
      assert.match(text, /add column if not exists origin/i);
    }
    const store = fs.readFileSync("src/lib/watched-repos.ts", "utf8");
    assert.match(store, /origin is distinct from 'auto'/);
    assert.match(store, /insert into watched_repos/);
    const old = validateRepoList([{ repo: "acme/app", label: "App", short: "app", color: "#2563eb", blockedLabel: null }]);
    assert.equal(old.ok, true);
    if (old.ok) {
      assert.equal(old.repos[0].pinned, undefined);
      assert.equal(old.repos[0].hidden, undefined);
      assert.equal(old.repos[0].origin, undefined);
    }
    assert.equal(validateRepoList([]).ok, false);
    assert.equal(MAX_REPOS, 25);
    const current = [
      { repo: "acme/app", label: "App", short: "app", color: "#2563eb", blockedLabel: null, origin: "auto" as const, pinned: true },
      { repo: "acme/hand", label: "Hand", short: "hand", color: "#112233", blockedLabel: null, origin: "manual" as const },
    ];
    const diff = diffRepoList(current, [current[1]]);
    assert.equal(diff.changes.some((change) => change.op === "remove" && String(change.summary).includes("acme/app")), false);
    assert.equal(diff.changes.some((change) => change.op === "remove"), false);

    env.DATABASE_URL = FIXTURE_URL;
    env.MC_DB_DRIVER = "pg";
    const fallback = [{ repo: "acme/file", label: "File", short: "file", color: "#2563eb", blockedLabel: null }];
    setSqlForTests(async () => []);
    const loaded = await getWatchedRepos(fallback);
    assert.equal(loaded.source, "file");
    assert.deepEqual(loaded.repos, fallback);
    const fileRepo = loaded.repos[0] as { shown?: boolean };
    assert.equal(fileRepo.shown, undefined);
    assert.equal(visibleOnBoard(fileRepo), true);
  });

  it("F10 a repo that disappears from gh is marked gone and the tick does not throw", () => {
    const existing = [
      tracked({ repo: "acme/app", origin: "auto" }),
      tracked({ repo: "acme/renamed", origin: "manual", position: 1, pinned: true }),
      tracked({ repo: "other/app", origin: "auto", position: 2 }),
    ];
    const outcome = planDiscovery(existing, owner(), { repos: [listed("app", 1)], error: null }, NOW);
    assert.equal(outcome.failure, null);
    assert.deepEqual(outcome.markedGone, ["acme/renamed"]);
    const gone = outcome.repos.find((row) => row.repo === "acme/renamed");
    assert.equal(gone?.gone, true);
    assert.equal(gone?.pinned, true, "gone does not clear a pin, and the row is not deleted");
    assert.equal(briefShown(gone!, owner(), NOW), false);
    assert.equal(outcome.repos.find((row) => row.repo === "other/app")?.gone, false);
    assert.equal(outcome.repos.find((row) => row.repo === "acme/app")?.gone, false);

    const malformed = planDiscovery(existing, owner(), { repos: [listed("app", 1), listed("bad name", 1)], error: null }, NOW);
    assert.match(malformed.failure ?? "", /not safe to store/);
    assert.deepEqual(malformed.repos.map((row) => row.gone), existing.map((row) => row.gone));
    assert.equal(malformed.markedGone.length, 0);
  });

  it("acceptance: one owner shows every active repo after one tick, with none typed by hand", () => {
    const rule = owner({ owner: "acme", activityDays: 30 });
    const outcome = planDiscovery(
      [],
      rule,
      { repos: [listed("app", 1), listed("docs", 30), listed("ancient", 31), listed("fork", 1, { isFork: true })], error: null },
      NOW,
    );
    assert.equal(outcome.failure, null);
    const shown = outcome.repos.filter((row) => briefShown(row, rule, NOW) && visibleOnBoard({ shown: briefShown(row, rule, NOW) }));
    assert.deepEqual(shown.map((row) => row.repo).sort(), ["acme/app", "acme/docs"]);
    for (const row of shown) {
      assert.equal(row.origin, "auto");
      assert.equal(row.pinned, false);
      assert.equal(row.hidden, false);
    }
    assert.equal(outcome.repos.some((row) => row.repo === "acme/ancient"), false);
    assert.equal(outcome.repos.some((row) => row.repo === "acme/fork"), false);

    const collector = fs.readFileSync("scripts/collect-progress.sh", "utf8");
    const discoverAt = collector.indexOf("\ndiscover_watched_owners\n");
    const refreshAt = collector.lastIndexOf("\nrefresh_repos_from_dashboard\n");
    const backfillAt = collector.indexOf('if [[ "$MODE" == "backfill" ]]; then\n  run_backfill');
    assert.ok(discoverAt > 0 && refreshAt > discoverAt && backfillAt > refreshAt);
    assert.match(collector, /gh repo list "\$owner"/);
    assert.match(collector, /if listing="\$\(gh repo list/);
    assert.match(collector, /gh repo list returned no repos/);
    assert.match(collector, /select\(\.gone != true\)/);
    assert.doesNotMatch(collector, /select\(\.shown/);
    assert.match(collector, /\/api\/settings\/owners\/discover/);
    const brief = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    assert.match(brief, /select\(\.shown != false\)/);
    const filtered = execFileSync("jq", ["-c", "[.repos[] | select(.shown != false) | {repo}]"], {
      input: JSON.stringify({
        repos: [
          { repo: "acme/shown" },
          { repo: "acme/hidden", shown: false },
          { repo: "acme/explicit", shown: true },
        ],
      }),
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(filtered), [{ repo: "acme/shown" }, { repo: "acme/explicit" }]);
    const page = fs.readFileSync("src/app/settings/page.tsx", "utf8");
    assert.ok(page.indexOf("<OwnerSettings />") < page.indexOf("<RepoSettings />"));
    assert.match(fs.readFileSync("src/components/RepoSettings.tsx", "utf8"), /origin === "auto"/);
    assert.match(fs.readFileSync("src/components/RepoSettings.tsx", "utf8"), /method: "PATCH"/);
  });

  it("concurrent owner saves with the same version cannot overwrite each other", async () => {
    env.NODE_ENV = "test";
    env.DATABASE_URL = FIXTURE_URL;
    env.MC_DB_DRIVER = "pg";
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;

    const stored: Row[] = [];
    let held = false;
    let reads = 0;
    let blockedOnLock = false;
    const waiters: Array<() => void> = [];
    let markSecond = (): void => {};
    let failSecond = (_err: Error): void => {};
    const secondArrived = new Promise<void>((resolve, reject) => {
      failSecond = reject;
      const timer = setTimeout(() => reject(new Error("second writer did not arrive")), 2000);
      markSecond = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    // The first version read parks until the other writer has either read the
    // same version or blocked on the owner-list lock. That is the two-tab race.
    const arrive = () => markSecond();

    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ").replace(/\s+/g, " ").toLowerCase();
      if (text.includes("commit") || text.includes("rollback")) {
        const next = waiters.shift();
        if (next) next();
        else held = false;
        return [];
      }
      if (text.includes("pg_advisory_xact_lock")) {
        if (held) {
          blockedOnLock = true;
          arrive();
          await new Promise<void>((resolve) => {
            waiters.push(() => {
              held = true;
              resolve();
            });
          });
        } else {
          held = true;
        }
        return [];
      }
      if (text.includes("insert into watched_owners")) {
        const names = values[0] as string[];
        stored.length = 0;
        names.forEach((name, i) => {
          stored.push({
            owner: name,
            activity_days: (values[1] as number[])[i],
            include_forks: (values[2] as boolean[])[i],
            include_archived: (values[3] as boolean[])[i],
            actor_type: values[4],
            actor_id: values[5],
            last_error: null,
            last_error_at: null,
            last_discovered_at: null,
          });
        });
        return [];
      }
      if (text.includes("from watched_owners")) {
        const snapshot = stored.map((row) => ({ ...row }));
        reads += 1;
        if (reads === 1) await secondArrived;
        else arrive();
        return snapshot;
      }
      return [];
    });

    const version = ownerListVersion([]);
    const put = (ownerName: string) => putOwners(new Request("http://localhost/api/settings/owners", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owners: [{ owner: ownerName }], version }),
    }));

    let left: Response;
    let right: Response;
    try {
      [left, right] = await Promise.all([put("alpha"), put("beta")]);
    } catch (err) {
      failSecond(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    const statuses = [left.status, right.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(blockedOnLock, true, "the second writer must wait on the owner-list lock");
    const winner = left.status === 200 ? left : right;
    const loser = left.status === 409 ? left : right;
    const saved = await winner.json() as { owners: { owner: string }[] };
    const rejected = await loser.json() as { code?: string };
    assert.equal(rejected.code, "stale");
    assert.equal(saved.owners.length, 1);
    assert.deepEqual(stored.map((row) => row.owner), saved.owners.map((row) => row.owner));
    assert.ok(saved.owners[0].owner === "alpha" || saved.owners[0].owner === "beta");
  });

  it("a missing watched_owners table is not writable and rejects the save", async () => {
    env.NODE_ENV = "test";
    env.DATABASE_URL = FIXTURE_URL;
    env.MC_DB_DRIVER = "pg";
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    const calls: string[] = [];
    setSqlForTests(async (strings) => {
      calls.push(strings.join(" "));
      const err = new Error('relation "watched_owners" does not exist');
      (err as { code?: string }).code = "42P01";
      throw err;
    });

    const got = await getOwners(new Request("http://localhost/api/settings/owners"));
    assert.equal(got.status, 200);
    const body = await got.json() as { writable?: boolean; owners?: unknown[]; max?: number };
    assert.equal(body.writable, false);
    assert.deepEqual(body.owners, []);
    assert.equal(body.max, 20);

    calls.length = 0;
    const dry = await putOwners(new Request("http://localhost/api/settings/owners", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owners: [{ owner: "acme" }], dry_run: true }),
    }));
    assert.equal(dry.status, 200);
    const preview = await dry.json() as { would_write?: boolean; applied?: boolean };
    assert.equal(preview.would_write, false);
    assert.equal(preview.applied, false);

    calls.length = 0;
    const put = await putOwners(new Request("http://localhost/api/settings/owners", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owners: [{ owner: "acme" }], version: ownerListVersion([]) }),
    }));
    assert.equal(put.status, 409);
    const denied = await put.json() as { code?: string; error?: string; retryable?: boolean };
    assert.equal(denied.code, "conflict");
    assert.equal(typeof denied.error, "string");
    assert.equal(denied.retryable, false);
    assert.equal(calls.some((sql) => /insert into watched_owners/i.test(sql)), false);
  });

  it("a discovery request rejects a duplicate owner", async () => {
    env.NODE_ENV = "test";
    env.DATABASE_URL = FIXTURE_URL;
    env.MC_DB_DRIVER = "pg";
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    const calls: string[] = [];
    setSqlForTests(async (strings) => {
      calls.push(strings.join(" "));
      return [{ owner: "acme", activity_days: 30, include_forks: false, include_archived: false }];
    });
    const res = await postDiscover(new Request("http://localhost/api/settings/owners/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        results: [
          { owner: "acme", ok: true, repos: [{ name: "app", pushedAt: atAge(1), isFork: false, isArchived: false }] },
          { owner: "Acme", ok: true, repos: [{ name: "other", pushedAt: atAge(1), isFork: false, isArchived: false }] },
        ],
      }),
    }));
    assert.equal(res.status, 400);
    const body = await res.json() as { code?: string; fields?: { results?: string } };
    assert.equal(body.code, "validation_failed");
    assert.match(body.fields?.results ?? "", /duplicate/i);
    assert.equal(calls.length, 0, "a duplicate owner must not apply either sweep");
  });

  it("owner discovery metadata and repo rows are one transaction", async () => {
    const calls: string[] = [];
    setSqlForTests(async (strings) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim();
      calls.push(text);
      if (/insert into watched_repos/i.test(text)) {
        throw Object.assign(new Error("repo insert failed"), { code: "53100" });
      }
      return [];
    });
    await assert.rejects(
      () => applyOwnerDiscovery(
        owner(),
        [],
        { repos: [listed("app", 1)], error: null, truncated: false },
        NOW,
      ),
      /repo insert failed/,
    );
    const begin = calls.findIndex((sql) => /^begin\b/i.test(sql));
    const update = calls.findIndex((sql) => /update watched_owners/i.test(sql));
    const insert = calls.findIndex((sql) => /insert into watched_repos/i.test(sql));
    const rollback = calls.findIndex((sql) => /^rollback\b/i.test(sql));
    assert.ok(begin !== -1 && begin < update && update < insert && insert < rollback);
    assert.equal(calls.some((sql) => /^commit\b/i.test(sql)), false);
  });
});
