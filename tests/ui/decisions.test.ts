import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import {
  ageDays,
  collectorDecisionBody,
  hoursBetween,
  isDecisionLabel,
  nextStatusOnUpsert,
  decisionListBody,
  parseDecisionId,
  parseListQuery,
  parsePatch,
  parseReconcile,
  parseUpsert,
  partitionBrief,
  toBriefDecisions,
  type BriefDecision,
  type Decision,
  type GhItem,
} from "../../src/lib/decisions";
import { authorizeRoute, scopeForRoute } from "../../src/lib/scopes";

/**
 * The brief's .decisions list has to come out of the table the same way
 * scripts/morning-brief.sh builds it from GitHub. These tests run that jq.
 */

const NOW = "2026-10-25T12:00:00Z";
const REPO = "mrhinkle/agent-kontrol";
const SHORT = "app";
const PATTERNS = ["needs-owner", "owner-gate-*", "decision"];

const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  node: env.NODE_ENV,
  password: env.MC_DASHBOARD_PASSWORD,
};

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["NODE_ENV", saved.node],
    ["MC_DASHBOARD_PASSWORD", saved.password],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
});

afterEach(() => {
  resetCredentialsForTests();
  restoreEnv();
});

function jq(program: string, args: string[]): unknown {
  const out = execFileSync("jq", ["-n", ...args, program], { encoding: "utf8" });
  return JSON.parse(out);
}

function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing marker ${start}`);
  return src.slice(from, to);
}

function decision(over: Partial<Decision> & Pick<Decision, "key" | "number">): Decision {
  const opened = over.opened_at === undefined ? "2026-10-01T12:00:00Z" : over.opened_at;
  return {
    id: over.id ?? 1,
    key: over.key,
    source: over.source ?? "github-label",
    repo: over.repo === undefined ? REPO : over.repo,
    repo_short: over.repo_short === undefined ? SHORT : over.repo_short,
    number: over.number,
    url: over.url === undefined ? `https://github.com/${REPO}/issues/${over.number}` : over.url,
    title: over.title ?? `item ${over.number}`,
    why: over.why ?? null,
    options: null,
    recommended: null,
    requested_by: over.requested_by ?? "collector",
    status: over.status ?? "open",
    decision: over.decision ?? null,
    decided_by: over.decided_by ?? null,
    decided_at: over.decided_at ?? null,
    defer_until: over.defer_until ?? null,
    kind: over.kind === undefined ? "issue" : over.kind,
    labels: over.labels === undefined ? ["needs-owner"] : over.labels,
    opened_at: opened,
    github_present: over.github_present === undefined ? true : over.github_present,
    first_seen_at: over.first_seen_at ?? opened ?? NOW,
    last_seen_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    revision: over.revision ?? 0,
    age_days: 0,
    actor_type: over.actor_type ?? null,
    actor_id: over.actor_id ?? null,
    chosen_option: over.chosen_option ?? null,
    writeback: over.writeback ?? null,
  };
}

const issues: GhItem[] = [
  {
    number: 10,
    title: "Owner has to pick the schema",
    url: `https://github.com/${REPO}/issues/10`,
    createdAt: "2026-07-21T12:00:00.500Z",
    labels: [{ name: "bug" }, { name: "needs-owner" }, { name: "decision" }],
  },
  {
    number: 40,
    title: "Bare owner-gate is not a decision",
    url: `https://github.com/${REPO}/issues/40`,
    createdAt: "2026-10-01T12:00:00Z",
    labels: [{ name: "owner-gate" }],
  },
  {
    number: 30,
    title: "Tier C still needs an owner",
    url: `https://github.com/${REPO}/issues/30`,
    createdAt: "2026-10-24T00:00:00Z",
    labels: [{ name: "owner-gate-tierc" }],
  },
  {
    number: 60,
    title: "Plural label is not the decision label",
    url: `https://github.com/${REPO}/issues/60`,
    createdAt: "2026-10-22T12:00:00Z",
    labels: [{ name: "decisions" }],
  },
];

const prs: GhItem[] = [
  {
    number: 20,
    title: "Schema gate",
    url: `https://github.com/${REPO}/pull/20`,
    createdAt: "2026-10-20T12:00:00Z",
    labels: [{ name: "owner-gate-schema" }, { name: "bug" }],
    isDraft: false,
  },
];

describe("decision label and age", { concurrency: false }, () => {
  it("matches the brief's wildcard and keeps a bare prefix out", () => {
    assert.equal(isDecisionLabel("needs-owner", PATTERNS), true);
    assert.equal(isDecisionLabel("owner-gate-schema", PATTERNS), true);
    assert.equal(isDecisionLabel("owner-gate-tierc", PATTERNS), true);
    assert.equal(isDecisionLabel("owner-gate", PATTERNS), false);
    assert.equal(isDecisionLabel("decisions", PATTERNS), false);
    assert.equal(isDecisionLabel("bug", PATTERNS), false);
  });

  it("counts hours the way jq does, after dropping fractional seconds", () => {
    assert.equal(hoursBetween("2026-07-21T12:00:00.500Z", NOW), 2304);
    assert.equal(ageDays("2026-07-21T12:00:00.500Z", NOW), 96);
    assert.equal(hoursBetween("2026-10-20T12:00:00Z", NOW), 120);
    assert.equal(ageDays("2026-10-20T12:00:00Z", NOW), 5);
    assert.equal(hoursBetween("2026-10-24T00:00:00Z", NOW), 36);
    assert.equal(ageDays("2026-10-24T00:00:00Z", NOW), 1);
  });

  it("holds decided and deferred unless force, and reopens withdrawn", () => {
    assert.equal(nextStatusOnUpsert(null, false), "open");
    assert.equal(nextStatusOnUpsert("open", false), "open");
    assert.equal(nextStatusOnUpsert("decided", false), "decided");
    assert.equal(nextStatusOnUpsert("deferred", false), "deferred");
    assert.equal(nextStatusOnUpsert("withdrawn", false), "open");
    assert.equal(nextStatusOnUpsert("decided", true), "open");
    assert.equal(nextStatusOnUpsert("deferred", true), "open");
    assert.equal(nextStatusOnUpsert("open", true), "open");
  });
});

describe("brief decisions match morning-brief.sh", { concurrency: false }, () => {
  it("keeps the brief script's label, kind, and age lines", () => {
    const brief = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    assert.match(brief, /def is_decision_label/);
    assert.match(brief, /if has\("isDraft"\) then "pr" else "issue" end/);
    assert.match(brief, /age_days: \(hours\(\.createdAt; \$now\) \/ 24 \| floor\)/);
    assert.match(brief, /sort_by\(-.age_hours\)/);
  });

  it("builds the same .decisions array the brief jq builds", () => {
    const brief = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const labelAt = brief.indexOf("def is_decision_label");
    const tsAt = brief.lastIndexOf("def ts:", labelAt);
    const hoursAt = brief.indexOf("def hours(a; b):", tsAt);
    const hoursEnd = brief.indexOf("\n", hoursAt);
    assert.ok(tsAt >= 0 && hoursAt > tsAt && hoursEnd > hoursAt);
    const tsDefs = brief.slice(tsAt, hoursEnd);
    const decisionExpr = between(brief, "def is_decision_label", " as $decisions");
    const fromBrief = jq(`${tsDefs}\n${decisionExpr}\n| sort_by(-.age_hours)`, [
      "--arg", "repo", REPO,
      "--arg", "short", SHORT,
      "--arg", "now", NOW,
      "--argjson", "decision_labels", JSON.stringify(PATTERNS),
      "--argjson", "issues", JSON.stringify(issues),
      "--argjson", "prs", JSON.stringify(prs),
    ]) as BriefDecision[];

    const rows = [...issues, ...prs]
      .filter((item) => (item.labels ?? []).some((label) => isDecisionLabel(label.name ?? "", PATTERNS)))
      .map((item) => {
        const body = collectorDecisionBody(item, REPO, SHORT, PATTERNS);
        return decision({
          key: body.key,
          number: body.number,
          title: body.title,
          url: body.url,
          kind: body.kind,
          labels: body.labels ?? [],
          opened_at: body.opened_at,
          first_seen_at: body.first_seen_at ?? body.opened_at ?? NOW,
          why: body.why,
          repo: body.repo,
          repo_short: body.repo_short,
        });
      });
    rows.push(
      decision({ key: "github:mrhinkle/agent-kontrol#70", number: 70, status: "withdrawn", opened_at: "2026-01-01T00:00:00Z", title: "gone" }),
      decision({ key: "github:mrhinkle/agent-kontrol#71", number: 71, status: "decided", github_present: false, opened_at: "2026-01-02T00:00:00Z", title: "label removed" }),
      decision({ key: "agent:lane:pick", number: 72, source: "agent", opened_at: "2026-01-03T00:00:00Z", title: "not from github" }),
    );
    const fromTable = toBriefDecisions(rows, NOW);

    assert.equal(fromBrief.length, 3);
    assert.deepEqual(fromBrief.map((row) => row.number), [10, 20, 30]);
    assert.equal(fromBrief[0].age_hours, 2304);
    assert.equal(fromBrief[0].age_days, 96);
    assert.equal(fromBrief[0].repo, REPO);
    assert.equal(fromBrief[0].repo_short, SHORT);
    assert.equal(fromBrief[0].kind, "issue");
    assert.deepEqual(fromBrief[0].labels, ["needs-owner", "decision"]);
    assert.equal(fromBrief[1].kind, "pr");
    assert.equal(fromBrief[1].age_hours, 120);
    assert.equal(fromBrief[1].age_days, 5);
    assert.deepEqual(fromBrief[1].labels, ["owner-gate-schema"]);
    assert.equal(fromBrief[2].age_hours, 36);
    assert.equal(fromBrief[2].age_days, 1);
    assert.deepEqual(
      fromTable.map((row) => ({ ...row, age_hours: Math.round(row.age_hours * 1e6) / 1e6 })),
      fromBrief.map((row) => ({ ...row, age_hours: Math.round(row.age_hours * 1e6) / 1e6 })),
    );
  });

  it("keeps a null github_present and a deferred row, and does not guess a missing short name", () => {
    const rows = [
      decision({ key: "github:mrhinkle/agent-kontrol#1", number: 1, github_present: null, opened_at: "2026-10-20T12:00:00Z" }),
      decision({ key: "github:mrhinkle/agent-kontrol#2", number: 2, status: "deferred", opened_at: "2026-10-24T12:00:00Z" }),
      decision({ key: "github:mrhinkle/agent-kontrol#3", number: 3, github_present: false, opened_at: "2026-10-01T12:00:00Z" }),
      decision({
        key: "github:mrhinkle/other#4",
        number: 4,
        repo: "mrhinkle/other",
        repo_short: null,
        opened_at: "2026-10-23T12:00:00Z",
        labels: ["decision"],
      }),
    ];
    const part = partitionBrief(rows, NOW);
    assert.deepEqual(part.decisions.map((row) => row.number), [1, 2]);
    assert.deepEqual(part.incomplete_repos, ["mrhinkle/other"]);
    assert.equal(part.decisions[0].repo, REPO);
    assert.equal(part.decisions[0].repo_short, SHORT);
    assert.equal(part.decisions.some((row) => row.repo_short === "other"), false);
  });

  it("serves that list from GET /api/decisions?shape=brief and from the brief script", () => {
    const open = decision({ key: `github:${REPO}#1`, number: 1, opened_at: "2026-10-01T12:00:00Z" });
    const gone = decision({
      key: `github:${REPO}#2`,
      number: 2,
      status: "decided",
      decision: "Ship it",
      decided_by: "mark",
      github_present: false,
      opened_at: "2026-09-01T12:00:00Z",
    });
    const rows = [open, gone];
    assert.equal(decisionListBody("row", rows, NOW).length, 2);
    const brief = decisionListBody("brief", rows, NOW);
    assert.deepEqual(brief.map((row) => row.number), [1]);

    const parsed = parseListQuery(new URLSearchParams("shape=brief&status=open&source=agent"));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.shape, "brief");
      assert.equal(parsed.status, "open");
    }
    const badShape = parseListQuery(new URLSearchParams("shape=csv"));
    assert.equal(badShape.ok, false);
    if (!badShape.ok) assert.equal(badShape.fields.shape, "shape must be row or brief.");

    const route = fs.readFileSync("src/app/api/decisions/route.ts", "utf8");
    assert.match(route, /partitionBrief\(rows, now\)/);
    assert.match(route, /incomplete_repos: brief\.incomplete_repos/);
    const sh = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    execFileSync("bash", ["-n", "scripts/morning-brief.sh"]);
    assert.match(sh, /\/api\/decisions\?shape=brief&limit=1000/);
    assert.match(sh, /\.demo == false and \(\.decisions \| type == "array"\)/);
    const program = between(sh, "TABLE_DECISIONS_JQ='", "'\n").slice("TABLE_DECISIONS_JQ='".length);
    const repos = [
      { repo: REPO, short: SHORT, incomplete: false, decisions: [{ repo: REPO, number: 1 }] },
      { repo: "mrhinkle/other", short: "other", incomplete: true, decisions: null },
    ];
    const table = [
      { repo: REPO, repo_short: SHORT, number: 9, title: "from table", url: "https://example.test/9", kind: "issue", age_hours: 48, age_days: 2, labels: ["decision"] },
      { repo: "mrhinkle/other", repo_short: "other", number: 8, title: "incomplete repo", url: "https://example.test/8", kind: "issue", age_hours: 1, age_days: 0, labels: ["decision"] },
    ];
    const replaced = execFileSync("jq", ["-c", "--argjson", "table", JSON.stringify(table), "--argjson", "incomplete", "[]", program], {
      encoding: "utf8",
      input: JSON.stringify(repos),
    });
    const out = JSON.parse(replaced) as { short: string; incomplete: boolean; decisions: { number: number }[] | null }[];
    assert.deepEqual(out[0].decisions?.map((row) => row.number), [9]);
    assert.equal(out[1].incomplete, true);
    assert.equal(out[1].decisions, null);
  });

  it("puts one decision under the one owner/name when two repos share a short name", () => {
    const acme = decision({
      key: "github:acme/app#12",
      number: 12,
      repo: "acme/app",
      repo_short: "app",
      title: "pick a vendor",
      url: "https://github.com/acme/app/issues/12",
      opened_at: "2026-10-23T12:00:00Z",
      labels: ["decision"],
    });
    const brief = decisionListBody("brief", [acme], NOW) as BriefDecision[];
    assert.equal(brief.length, 1);
    assert.equal(brief[0].repo, "acme/app");
    assert.equal(brief[0].repo_short, "app");

    const sh = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const program = between(sh, "TABLE_DECISIONS_JQ='", "'\n").slice("TABLE_DECISIONS_JQ='".length);
    assert.match(program, /\.repo == \$section\.repo/);
    assert.equal(program.includes(".short"), false);
    const repos = [
      { repo: "acme/app", short: "app", incomplete: false, decisions: [] },
      { repo: "other/app", short: "app", incomplete: false, decisions: [] },
    ];
    const replaced = execFileSync("jq", ["-c", "--argjson", "table", JSON.stringify(brief), "--argjson", "incomplete", "[]", program], {
      encoding: "utf8",
      input: JSON.stringify(repos),
    });
    const out = JSON.parse(replaced) as { repo: string; decisions: { number: number }[] }[];
    const owners = out.filter((section) => section.decisions.some((row) => row.number === 12)).map((section) => section.repo);
    assert.deepEqual(owners, ["acme/app"]);
    assert.equal(out.find((section) => section.repo === "other/app")?.decisions.length, 0);
  });

  it("keeps the GitHub sweep when a legacy null-column row would replace it", () => {
    const briefSrc = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const labelAt = briefSrc.indexOf("def is_decision_label");
    const tsAt = briefSrc.lastIndexOf("def ts:", labelAt);
    const hoursAt = briefSrc.indexOf("def hours(a; b):", tsAt);
    const hoursEnd = briefSrc.indexOf("\n", hoursAt);
    assert.ok(tsAt >= 0 && hoursAt > tsAt && hoursEnd > hoursAt);
    const decisionExpr = between(briefSrc, "def is_decision_label", " as $decisions");
    const sweep = jq(`${briefSrc.slice(tsAt, hoursEnd)}\n${decisionExpr}\n| sort_by(-.age_hours)`, [
      "--arg", "repo", REPO,
      "--arg", "short", SHORT,
      "--arg", "now", NOW,
      "--argjson", "decision_labels", JSON.stringify(PATTERNS),
      "--argjson", "issues", JSON.stringify(issues),
      "--argjson", "prs", JSON.stringify(prs),
    ]) as BriefDecision[];
    const swept = sweep.find((row) => row.number === 20);
    assert.ok(swept);
    assert.equal(swept.kind, "pr");
    assert.deepEqual(swept.labels, ["owner-gate-schema"]);
    assert.equal(swept.age_days, 5);
    assert.equal(swept.repo_short, SHORT);
    assert.notEqual(SHORT, REPO.split("/")[1]);

    const legacy = decision({
      key: `github:${REPO}#20`,
      number: 20,
      repo: REPO,
      repo_short: null,
      kind: null,
      labels: null,
      opened_at: null,
      first_seen_at: "2026-10-25T00:00:00Z",
      title: "Schema gate",
      url: `https://github.com/${REPO}/pull/20`,
    });
    const guessed = {
      kind: "issue" as const,
      labels: [] as string[],
      age_days: ageDays(legacy.first_seen_at, NOW),
      repo_short: REPO.split("/")[1],
    };
    assert.notEqual(guessed.kind, swept.kind);
    assert.notDeepEqual(guessed.labels, swept.labels);
    assert.notEqual(guessed.age_days, swept.age_days);
    assert.notEqual(guessed.repo_short, swept.repo_short);

    for (const field of ["kind", "labels", "opened_at", "repo_short"] as const) {
      const row = decision({
        key: `github:${REPO}#20`,
        number: 20,
        kind: "pr",
        labels: ["owner-gate-schema"],
        opened_at: "2026-10-20T12:00:00Z",
        repo_short: SHORT,
        [field]: null,
      });
      const one = partitionBrief([row], NOW);
      assert.deepEqual(one.decisions, [], field);
      assert.deepEqual(one.incomplete_repos, [REPO], field);
    }

    const completeOther = decision({
      key: "github:mrhinkle/other#3",
      number: 3,
      repo: "mrhinkle/other",
      repo_short: "other",
      kind: "pr",
      labels: ["decision"],
      opened_at: "2026-10-23T12:00:00Z",
      title: "table wins here",
      url: "https://github.com/mrhinkle/other/pull/3",
    });
    const part = partitionBrief([legacy, completeOther], NOW);
    assert.equal(part.decisions.some((row) => row.number === 20), false);
    assert.deepEqual(part.incomplete_repos, [REPO]);
    assert.equal(part.decisions.some((row) => row.kind === guessed.kind && row.repo_short === guessed.repo_short), false);

    const program = between(briefSrc, "TABLE_DECISIONS_JQ='", "'\n").slice("TABLE_DECISIONS_JQ='".length);
    const sections = [
      { repo: REPO, short: SHORT, incomplete: false, decisions: sweep },
      { repo: "mrhinkle/other", short: "other", incomplete: false, decisions: [{ repo: "mrhinkle/other", number: 1, kind: "issue", labels: ["stale"], age_days: 1, repo_short: "other" }] },
    ];
    const replaced = execFileSync(
      "jq",
      ["-c", "--argjson", "table", JSON.stringify(part.decisions), "--argjson", "incomplete", JSON.stringify(part.incomplete_repos), program],
      { encoding: "utf8", input: JSON.stringify(sections) },
    );
    const out = JSON.parse(replaced) as { repo: string; decisions: BriefDecision[] }[];
    const kept = out.find((section) => section.repo === REPO)?.decisions.find((row) => row.number === 20);
    assert.ok(kept);
    assert.equal(kept.kind, swept.kind);
    assert.deepEqual(kept.labels, swept.labels);
    assert.equal(kept.age_days, swept.age_days);
    assert.equal(kept.age_hours, swept.age_hours);
    assert.equal(kept.repo_short, swept.repo_short);
    assert.deepEqual(
      out.find((section) => section.repo === REPO)?.decisions.map((row) => row.number),
      sweep.map((row) => row.number),
    );
    assert.deepEqual(out.find((section) => section.repo === "mrhinkle/other")?.decisions.map((row) => row.number), [3]);
  });
});

describe("collector decision sync", { concurrency: false }, () => {
  it("posts the same body the collector jq builds", () => {
    const sh = fs.readFileSync("scripts/collect-progress.sh", "utf8");
    const chunk = between(sh, "# BEGIN decision-select-jq", "# END decision-select-jq");
    const open = chunk.indexOf("<<'JQ'");
    const bodyStart = chunk.indexOf("\n", open) + 1;
    const bodyEnd = chunk.lastIndexOf("\nJQ");
    assert.ok(open >= 0 && bodyEnd > bodyStart);
    const program = chunk.slice(bodyStart, bodyEnd);
    const posted = jq(program, [
      "--arg", "repo", REPO,
      "--arg", "short", SHORT,
      "--argjson", "decision_labels", JSON.stringify(PATTERNS),
      "--argjson", "issues", JSON.stringify(issues),
      "--argjson", "prs", JSON.stringify(prs),
    ]) as Record<string, unknown>[];

    const expected = [...issues, ...prs]
      .filter((item) => (item.labels ?? []).some((label) => isDecisionLabel(label.name ?? "", PATTERNS)))
      .map((item) => collectorDecisionBody(item, REPO, SHORT, PATTERNS));
    assert.equal(posted.length, expected.length);
    posted.forEach((body, i) => {
      const want = expected[i];
      assert.deepEqual(body, {
        key: want.key,
        source: want.source,
        repo: want.repo,
        repo_short: want.repo_short,
        number: want.number,
        title: want.title,
        url: want.url,
        why: want.why,
        labels: want.labels,
        kind: want.kind,
        opened_at: want.opened_at,
        first_seen_at: want.first_seen_at,
        requested_by: want.requested_by,
        github_present: want.github_present,
      });
      const parsed = parseUpsert(body);
      assert.equal(parsed.ok, true);
    });
    assert.equal(expected[0].why, "needs-owner, decision");
    assert.equal(expected[0].kind, "issue");
    assert.equal(expected[2].kind, "pr");
    assert.equal(expected[0].repo_short, SHORT);
    assert.equal(expected[0].requested_by, "collector");
    assert.equal(expected[0].github_present, true);
    assert.equal(expected[0].first_seen_at, issues[0].createdAt);
  });

  it("parses an upsert, a reconcile, and a patch the way the routes do", () => {
    const missing = parseUpsert({ key: `github:${REPO}#1`, source: "github-label" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "missing_field");

    const labeled = parseUpsert({ key: `github:${REPO}#1`, source: "github-label", title: "T" });
    assert.equal(labeled.ok, true);
    if (labeled.ok) assert.equal(labeled.value.github_present, true);

    const other = parseUpsert({ key: "agent:lane:pick", source: "agent", title: "T" });
    assert.equal(other.ok, true);
    if (other.ok) assert.equal(other.value.github_present, null);

    const badKey = parseReconcile({ reconcile: { repo: REPO, seen_keys: ["agent:nope"] } });
    assert.equal(badKey.ok, false);
    const empty = parseReconcile({ reconcile: { repo: REPO, seen_keys: [] } });
    assert.equal(empty.ok, true);
    if (empty.ok) assert.equal(empty.value.source, "github-label");

    const decided = parsePatch({ status: "decided" });
    assert.equal(decided.ok, false);
    if (!decided.ok) assert.equal(decided.code, "validation_failed");
    const deferred = parsePatch({ status: "deferred" });
    assert.equal(deferred.ok, false);
    const withdrawn = parsePatch({ status: "withdrawn" });
    assert.equal(withdrawn.ok, true);
    const reopened = parsePatch({ status: "open" });
    assert.equal(reopened.ok, true);
    if (reopened.ok) {
      assert.equal(reopened.value.decision, null);
      assert.equal(reopened.value.defer_until, null);
    }
    assert.equal(parseDecisionId("nope"), null);
    assert.equal(parseDecisionId("0"), null);
    assert.equal(parseDecisionId("12"), 12);
  });

  it("syncs decisions on a tick and refuses to withdraw on a bad or truncated list", () => {
    execFileSync("bash", ["-n", "scripts/collect-progress.sh"]);
    const sh = fs.readFileSync("scripts/collect-progress.sh", "utf8");
    assert.match(sh, /\/api\/decisions/);
    assert.match(sh, /github-label/);
    assert.match(sh, /seen_keys/);
    assert.match(sh, /not withdrawing/);
    assert.match(sh, /decisionLabels/);
    assert.match(sh, /is_decision_label/);
    assert.match(sh, /repo_short/);
    assert.match(sh, /gh issue list -R "\$repo" --state open --limit 2001 --json number,title,createdAt,labels,url/);
    assert.match(sh, /gh pr list -R "\$repo" --state open --limit 501 --json number,title,createdAt,labels,url,isDraft/);
    const issueLine = sh.split("\n").find((line) => line.includes("gh issue list -R"));
    assert.ok(issueLine && !issueLine.includes("isDraft"));
    assert.equal(sh.split("IFS='|' read -r repo label blocked_label short").length - 1, 2);
    assert.equal(sh.split('[.repo, .label, (.blockedLabel // ""), (.short // "")] | join("|")').length - 1, 2);

    const backfill = between(sh, "run_backfill()", "refresh_repos_from_dashboard()");
    assert.equal(backfill.includes("sync_repo_decisions"), false);
    const tick = between(sh, "run_tick()", "run_backfill()");
    assert.match(tick, /sync_repo_decisions/);
    const poster = between(sh, "post_decision()", "sync_repo_decisions()");
    assert.match(poster, /DRY_RUN/);
    assert.match(poster, />&2/);
    const dry = poster.indexOf("DRY_RUN");
    const curl = poster.indexOf("curl ");
    assert.ok(dry >= 0 && curl > dry);
  });

  it("adds the nullable brief columns in schema.sql", () => {
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    for (const column of ["kind text", "labels jsonb", "opened_at timestamptz", "repo_short text", "github_present boolean"]) {
      assert.ok(schema.includes(`add column if not exists ${column}`), column);
    }
    const migration = fs.readFileSync("supabase/migrations/20261025_decisions_columns.sql", "utf8");
    assert.match(migration, /add column if not exists github_present boolean/);
  });
});

describe("decision routes", { concurrency: false }, () => {
  async function issue(scopes: string[]) {
    const created = await createCredential({ label: "decision lane", scopes });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    return created.token;
  }

  it("maps PATCH to decisions:write and leaves GET and POST off the agent table", () => {
    assert.equal(scopeForRoute("PATCH", "/api/decisions/4"), "decisions:write");
    assert.equal(scopeForRoute("GET", "/api/decisions"), null);
    assert.equal(scopeForRoute("POST", "/api/decisions"), null);
    const writer = { kind: "agent" as const, id: "c", scopes: ["decisions:write"] };
    assert.equal(authorizeRoute(writer, "PATCH", "/api/decisions/4").ok, true);
    assert.equal(authorizeRoute(writer, "GET", "/api/decisions").ok, false);
    assert.equal(authorizeRoute(writer, "POST", "/api/decisions").ok, false);
    assert.equal(authorizeRoute({ kind: "legacy" }, "POST", "/api/decisions").ok, true);
  });

  it("answers the demo contract and rejects a bad body before looking for a database", async () => {
    const { GET, POST } = await import("../../src/app/api/decisions/route");
    const { PATCH } = await import("../../src/app/api/decisions/[id]/route");
    const writer = await issue(["decisions:write"]);
    const reader = await issue(["fleet:read"]);

    const listed = await GET(new Request("http://localhost/api/decisions"));
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { demo: true, decisions: [] });

    const briefShape = await GET(new Request("http://localhost/api/decisions?shape=brief"));
    assert.equal(briefShape.status, 200);
    assert.deepEqual(await briefShape.json(), { demo: true, decisions: [] });

    const badShape = await GET(new Request("http://localhost/api/decisions?shape=csv"));
    assert.equal(badShape.status, 400);
    assert.equal((await badShape.json()).code, "validation_failed");

    const badStatus = await GET(new Request("http://localhost/api/decisions?status=nope"));
    assert.equal(badStatus.status, 400);
    assert.equal((await badStatus.json()).code, "validation_failed");

    const badLimit = await GET(new Request("http://localhost/api/decisions?limit=1001"));
    assert.equal(badLimit.status, 400);

    env.MC_TOKEN = "test-mc-token";
    const withToken = await GET(new Request("http://localhost/api/decisions", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(withToken.status, 200);

    const agentGet = await GET(new Request("http://localhost/api/decisions", {
      headers: { authorization: `Bearer ${writer}` },
    }));
    assert.equal(agentGet.status, 403);
    assert.equal((await agentGet.json()).code, "insufficient_scope");

    const agentPost = await POST(new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" },
      body: JSON.stringify({ key: `github:${REPO}#1`, source: "github-label", title: "T" }),
    }));
    assert.equal(agentPost.status, 403);

    const missing = await POST(new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: `github:${REPO}#1`, source: "github-label" }),
    }));
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, "missing_field");

    const junk = await POST(new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));
    assert.equal(junk.status, 400);
    assert.equal((await junk.json()).code, "invalid_json");

    const both = await POST(new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "k", reconcile: { repo: REPO, seen_keys: [] } }),
    }));
    assert.equal(both.status, 400);
    assert.equal((await both.json()).code, "validation_failed");

    const posted = await POST(new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: `github:${REPO}#1`, source: "github-label", title: "T" }),
    }));
    assert.equal(posted.status, 200);
    const postedBody = await posted.json() as { ok: boolean; demo: boolean; note: string };
    assert.equal(postedBody.ok, true);
    assert.equal(postedBody.demo, true);
    assert.match(postedBody.note, /DATABASE_URL/);

    const noScope = await PATCH(new Request("http://localhost/api/decisions/4", {
      method: "PATCH",
      headers: { authorization: `Bearer ${reader}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "withdrawn" }),
    }), { params: Promise.resolve({ id: "4" }) });
    assert.equal(noScope.status, 403);
    const noScopeBody = await noScope.json() as { code: string; fix: string };
    assert.equal(noScopeBody.code, "insufficient_scope");
    assert.match(noScopeBody.fix, /decisions:write/);

    const noDecision = await PATCH(new Request("http://localhost/api/decisions/4", {
      method: "PATCH",
      headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "decided" }),
    }), { params: Promise.resolve({ id: "4" }) });
    assert.equal(noDecision.status, 400);
    assert.equal((await noDecision.json()).code, "validation_failed");

    const noUntil = await PATCH(new Request("http://localhost/api/decisions/4", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "deferred" }),
    }), { params: Promise.resolve({ id: "4" }) });
    assert.equal(noUntil.status, 400);

    const badId = await PATCH(new Request("http://localhost/api/decisions/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "withdrawn" }),
    }), { params: Promise.resolve({ id: "nope" }) });
    assert.equal(badId.status, 400);
    assert.equal((await badId.json()).code, "validation_failed");

    const open = await PATCH(new Request("http://localhost/api/decisions/4", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "withdrawn" }),
    }), { params: Promise.resolve({ id: "4" }) });
    assert.equal(open.status, 200);
    assert.deepEqual(await open.json(), { ok: true, demo: true });

    const scoped = await PATCH(new Request("http://localhost/api/decisions/4", {
      method: "PATCH",
      headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "decided", decision: "Ship it", decided_by: "mark" }),
    }), { params: Promise.resolve({ id: "4" }) });
    assert.equal(scoped.status, 200);
    assert.deepEqual(await scoped.json(), { ok: true, demo: true });
  });
});
