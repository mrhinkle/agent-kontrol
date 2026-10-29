import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { MS_PER_DAY, planDiscovery, type GhListedRepo, type OwnerRule, type TrackedRepo } from "../../src/lib/owner-discovery";
import { POST as postDiscover } from "../../src/app/api/settings/owners/discover/route";
import { PATCH as patchRepos, PUT as putRepos } from "../../src/app/api/settings/repos/route";
import { groupDuplicateShorts, formatDuplicateShortReport, DUPLICATE_SHORTS_SQL } from "../../scripts/report-duplicate-shorts.mjs";

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
  node: env.NODE_ENV,
};
const FIXTURE_URL = "postgres://test:test@127.0.0.1:5432/ak_followups";

afterEach(() => {
  setSqlForTests(null);
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
});

function openDev() {
  env.NODE_ENV = "test";
  env.DATABASE_URL = FIXTURE_URL;
  env.MC_DB_DRIVER = "pg";
  delete env.MC_TOKEN;
  delete env.MC_DASHBOARD_PASSWORD;
}

interface StoredRepo {
  repo: string;
  label: string;
  short: string;
  color: string;
  blocked_label: string | null;
  position: number;
  origin: "manual" | "auto";
  pinned: boolean;
  hidden: boolean;
  gone: boolean;
  is_fork: boolean;
  is_archived: boolean;
  last_activity_at: string | null;
  fields_overridden: boolean | null;
}

function rowOf(repo: string, patch: Partial<StoredRepo> = {}): StoredRepo {
  return {
    repo,
    label: repo.split("/")[1] ?? "repo",
    short: (repo.split("/")[1] ?? "repo").toLowerCase().slice(0, 12),
    color: "#2563eb",
    blocked_label: null,
    position: 0,
    origin: "manual",
    pinned: false,
    hidden: false,
    gone: false,
    is_fork: false,
    is_archived: false,
    last_activity_at: null,
    fields_overridden: null,
    ...patch,
  };
}

function asRow(row: StoredRepo): Row {
  return { ...row };
}

function install(rows: StoredRepo[]) {
  let inserts = 0;
  const owners = [{
    owner: "acme",
    activity_days: 30,
    include_forks: false,
    include_archived: false,
    last_discovered_at: null as string | null,
  }];
  setSqlForTests(async (strings, ...values) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    if (text === "begin" || text === "commit" || text === "rollback" || text.includes("pg_advisory_xact_lock")) return [];
    if (text.includes("update watched_owners")) {
      const stamp = values.find((value) => typeof value === "string" && value.includes("T"));
      if (typeof stamp === "string") owners[0].last_discovered_at = stamp;
      return [];
    }
    if (text.includes("insert into watched_repos") && text.includes("fields_overridden")) {
      inserts += 1;
      const names = values[0] as string[];
      const labels = values[1] as string[];
      const shorts = values[2] as string[];
      const colors = values[3] as string[];
      const blocked = values[4] as (string | null)[];
      const positions = values[5] as number[];
      const pinned = values[6] as boolean[];
      const hidden = values[7] as boolean[];
      names.forEach((name, i) => {
        const hit = rows.find((row) => row.repo === name);
        const next = hit ?? rowOf(name);
        next.repo = hit ? hit.repo : name;
        next.label = labels[i];
        next.short = shorts[i];
        next.color = colors[i];
        next.blocked_label = blocked[i];
        next.position = positions[i];
        next.pinned = pinned[i] === true;
        next.hidden = hidden[i] === true;
        next.fields_overridden = true;
        if (!hit) rows.push(next);
      });
      if (text.includes("delete from watched_repos")) {
        const fold = text.includes("lower(i.repo)");
        const incoming = new Set(names.map((name) => (fold ? name.toLowerCase() : name)));
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i];
          if (row.origin === "auto") continue;
          const key = fold ? row.repo.toLowerCase() : row.repo;
          if (!incoming.has(key)) rows.splice(i, 1);
        }
      }
      return [];
    }
    if (text.includes("insert into watched_repos")) {
      inserts += 1;
      const names = values[0] as string[];
      const labels = values[1] as string[];
      const shorts = values[2] as string[];
      const gone = values[9] as boolean[];
      const activity = values[12] as (string | null)[];
      names.forEach((name, i) => {
        const hit = rows.find((row) => row.repo === name);
        if (hit) {
          hit.gone = gone[i] === true;
          hit.last_activity_at = activity[i] ?? hit.last_activity_at;
          return;
        }
        rows.push(rowOf(name, {
          label: labels[i],
          short: shorts[i],
          origin: "auto",
          gone: gone[i] === true,
          last_activity_at: activity[i] ?? null,
          position: rows.length,
        }));
      });
      return [];
    }
    if (text.includes("update watched_repos")) {
      const repo = values.find((value) => typeof value === "string" && value.includes("/"));
      const fold = text.includes("lower(repo)");
      const matches = rows.filter((row) => fold
        ? row.repo.toLowerCase() === String(repo).toLowerCase()
        : row.repo === repo);
      if (typeof values[0] === "boolean") {
        for (const row of matches) row.pinned = values[0];
      }
      if (typeof values[1] === "boolean") {
        for (const row of matches) row.hidden = values[1];
      }
      return matches.map((row) => ({ repo: row.repo }));
    }
    // Reads come last. The replace statement both inserts and says
    // "delete from watched_repos", so a from-clause check before the
    // write branches treats the save as a select and stores nothing.
    if (text.includes("from watched_owners")) {
      const wanted = values.find((value) => typeof value === "string");
      const list = wanted ? owners.filter((owner) => owner.owner === wanted) : owners;
      return list.map((owner) => ({ ...owner }));
    }
    if (text.includes("from watched_repos")) {
      return rows
        .slice()
        .sort((a, b) => a.position - b.position || a.repo.localeCompare(b.repo))
        .map(asRow);
    }
    throw new Error(`unhandled sql: ${text.slice(0, 180)}`);
  });
  return {
    rows,
    owners,
    inserts: () => inserts,
  };
}

function hand(repo: string, short: string, label = short) {
  return { repo, label, short, color: "#2563eb", blockedLabel: null };
}

const owner = (patch: Partial<OwnerRule> = {}): OwnerRule => ({
  owner: "acme",
  activityDays: 30,
  includeForks: false,
  includeArchived: false,
  ...patch,
});

describe("owner discovery follow-ups", () => {
  it("treats a case variant as the stored row on put, discovery, and patch", async () => {
    openDev();
    const store = install([]);
    const put = await putRepos(new Request("http://localhost/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repos: [hand("acme/app", "app", "App")] }),
    }));
    assert.equal(put.status, 200, JSON.stringify(await put.clone().json()));
    assert.deepEqual(store.rows.map((row) => row.repo), ["acme/app"]);

    const swept = "2026-01-31T00:00:00.000Z";
    const discover = await postDiscover(new Request("http://localhost/api/settings/owners/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        results: [{
          owner: "acme",
          ok: true,
          swept_at: swept,
          repos: [
            { name: "App", pushedAt: "2026-01-15T00:00:00.000Z", isFork: false, isArchived: false },
            { name: "Edge", pushedAt: "2026-01-01T00:00:00.000Z", isFork: false, isArchived: false },
            { name: "Old", pushedAt: "2025-12-31T23:59:59.999Z", isFork: false, isArchived: false },
          ],
        }],
      }),
    }));
    assert.equal(discover.status, 200, JSON.stringify(await discover.clone().json()));
    const names = store.rows.map((row) => row.repo).sort();
    assert.deepEqual(names, ["acme/Edge", "acme/app"]);
    assert.equal(store.rows.filter((row) => row.repo.toLowerCase() === "acme/app").length, 1);
    assert.equal(store.rows.find((row) => row.repo.toLowerCase() === "acme/app")?.repo, "acme/app");

    const patched = await patchRepos(new Request("http://localhost/api/settings/repos", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "ACME/APP", pinned: true }),
    }));
    assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()));
    const body = await patched.json() as { repos: { repo: string; pinned?: boolean }[] };
    const stored = body.repos.filter((row) => row.repo.toLowerCase() === "acme/app");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.repo, "acme/app");
    assert.equal(stored[0]?.pinned, true);
    assert.equal(store.rows.find((row) => row.repo === "acme/app")?.pinned, true);
  });

  it("rejects a case-only duplicate in one payload and does not write", async () => {
    openDev();
    const store = install([rowOf("acme/app")]);
    const before = store.inserts();
    const put = await putRepos(new Request("http://localhost/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repos: [hand("acme/app", "app", "App"), hand("acme/App", "app2", "Other")] }),
    }));
    assert.equal(put.status, 400);
    assert.equal(store.inserts(), before);

    const discover = await postDiscover(new Request("http://localhost/api/settings/owners/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        results: [{
          owner: "acme",
          ok: true,
          swept_at: "2026-01-31T00:00:00.000Z",
          repos: [
            { name: "App", pushedAt: "2026-01-15T00:00:00.000Z", isFork: false, isArchived: false },
            { name: "app", pushedAt: "2026-01-15T00:00:00.000Z", isFork: false, isArchived: false },
          ],
        }],
      }),
    }));
    assert.equal(discover.status, 400, JSON.stringify(await discover.clone().json()));
    const body = await discover.json() as { fields?: { results?: string } };
    assert.match(body.fields?.results ?? "", /casing/);
    assert.equal(store.inserts(), before);
    assert.deepEqual(store.rows.map((row) => row.repo), ["acme/app"]);
  });

  it("does not delete a case-variant sibling when the save names the other casing", async () => {
    openDev();
    const store = install([
      rowOf("acme/App", { position: 0, short: "app" }),
      rowOf("acme/app", { position: 1, short: "app2" }),
    ]);
    const put = await putRepos(new Request("http://localhost/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repos: [hand("acme/app", "app", "App")] }),
    }));
    assert.equal(put.status, 200, JSON.stringify(await put.clone().json()));
    assert.equal(store.rows.length, 2);
  });

  it("uses swept_at for the activity boundary, not the server clock", () => {
    const swept = new Date("2026-01-31T00:00:00.000Z");
    const serverNow = new Date("2026-10-29T00:00:00.000Z");
    const exact = new Date(swept.getTime() - 30 * MS_PER_DAY).toISOString();
    const older = new Date(swept.getTime() - 30 * MS_PER_DAY - 1).toISOString();
    const listed = (name: string, pushedAt: string): GhListedRepo => ({
      name,
      pushedAt,
      isFork: false,
      isArchived: false,
    });
    const outcome = planDiscovery(
      [],
      owner(),
      { repos: [listed("Edge", exact), listed("Old", older), listed("App", exact)], error: null, sweptAt: swept.toISOString() },
      serverNow,
    );
    assert.deepEqual(outcome.added.sort(), ["acme/App", "acme/Edge"]);
    assert.equal(outcome.repos.find((row) => row.repo.endsWith("/App"))?.repo, "acme/App");
    const stored: TrackedRepo = {
      repo: "acme/app",
      label: "app",
      short: "app",
      color: "#2563eb",
      blockedLabel: null,
      origin: "manual",
      pinned: false,
      hidden: false,
      gone: false,
      isFork: false,
      isArchived: false,
      lastActivityAt: null,
      position: 0,
    };
    const kept = planDiscovery(
      [stored],
      owner(),
      { repos: [listed("App", exact)], error: null, sweptAt: swept.toISOString() },
      serverNow,
    );
    assert.deepEqual(kept.added, []);
    assert.equal(kept.repos.filter((row) => row.repo.toLowerCase() === "acme/app").length, 1);
    assert.equal(kept.repos.find((row) => row.repo.toLowerCase() === "acme/app")?.repo, "acme/app");
  });

  it("rejects a swept_at that is not RFC 3339 or is more than five minutes ahead", async () => {
    openDev();
    let calls = 0;
    setSqlForTests(async () => {
      calls += 1;
      return [];
    });
    const post = (sweptAt: unknown, pushedAt: unknown = "2026-01-15T00:00:00.000Z") => postDiscover(new Request("http://localhost/api/settings/owners/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        results: [{
          owner: "acme",
          ok: true,
          swept_at: sweptAt,
          repos: [{ name: "app", pushedAt, isFork: false, isArchived: false }],
        }],
      }),
    }));
    for (const bad of ["2026-01-31 00:00:00Z", "2026-01-31", "2026-02-31T00:00:00Z"]) {
      const res = await post(bad);
      assert.equal(res.status, 400, `${bad} ${JSON.stringify(await res.clone().json())}`);
    }
    const ahead = new Date(Date.now() + 5 * 60 * 1000 + 1000).toISOString();
    const future = await post(ahead);
    assert.equal(future.status, 400, JSON.stringify(await future.clone().json()));
    const pushed = await post("2026-01-31T00:00:00Z", "not-a-timestamp");
    assert.equal(pushed.status, 400, JSON.stringify(await pushed.clone().json()));
    assert.match(JSON.stringify(await pushed.clone().json()), /pushedAt/);
    assert.equal(calls, 0);

    const edge = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const storeCalls = calls;
    const allowed = await post(edge);
    assert.notEqual(allowed.status, 400, "exactly five minutes ahead is inside the skew");
    assert.ok(calls > storeCalls || allowed.status === 200 || allowed.status === 409);
  });

  it("prints duplicate short groups and never issues a write", () => {
    const source = fs.readFileSync("scripts/report-duplicate-shorts.mjs", "utf8");
    assert.match(DUPLICATE_SHORTS_SQL, /^select\b/i);
    assert.doesNotMatch(DUPLICATE_SHORTS_SQL, /\b(update|delete|insert|alter)\b/i);
    assert.doesNotMatch(source, /client\.query\(\s*["'`](update|delete|insert|alter)/i);
    const rows = [
      { repo: "acme/app", short: "App", origin: "auto", position: 1 },
      { repo: "beta/app", short: "app", origin: "manual", position: 0 },
      { repo: "acme/only", short: "only", origin: "auto", position: 2 },
      { repo: "acme/empty", short: "", origin: "manual", position: 3 },
    ];
    const groups = groupDuplicateShorts(rows);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.short, "app");
    assert.deepEqual(groups[0]?.repos.map((row: { repo: string }) => row.repo), ["acme/app", "beta/app"]);
    const report = formatDuplicateShortReport(rows);
    assert.match(report, /acme\/app/);
    assert.match(report, /beta\/app/);
    assert.match(report, /^-- update watched_repos set short/m);
    assert.doesNotMatch(report, /^update watched_repos/m);
    assert.equal(formatDuplicateShortReport([{ repo: "acme/only", short: "only", origin: "auto", position: 0 }]), "No duplicate short names.\n");
  });
});
