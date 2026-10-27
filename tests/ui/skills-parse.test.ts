import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { demoProgress } from "../../src/lib/demo-progress";
import { formatDigest } from "../../src/lib/progress-digest";
import { buildAlerts } from "../../src/lib/progress-store";
import { authorizeRoute, authorizeTool } from "../../src/lib/scopes";
import { assembleSkills } from "../../src/lib/skills/assemble";
import { isCron } from "../../src/lib/skills/cron";
import { compareDrift, driftDirs, driftNameCount } from "../../src/lib/skills/drift";
import { parseDriftBody } from "../../src/lib/skills/drift-report";
import { parseSkillMarkdown } from "../../src/lib/skills/parse";
import { renderPointers } from "../../src/lib/skills/inject";
import { resolveRuntimes } from "../../src/lib/skills/runtimes";
import { parseSettingsPatch } from "../../src/lib/skills/settings";
import { githubToken, decodeUtf8 } from "../../src/lib/skills/source";
import { skillSha, shortSha } from "../../src/lib/skills/sha";
import { stallMinutes } from "../../src/lib/skills/clock";
import { ALL_RUNTIMES, CLAUDE_ONLY, NO_RUNTIMES } from "../../src/lib/skills/types";

describe("skill frontmatter and runtimes", () => {
  it("uses the directory name when name is missing and reads metadata.version", () => {
    const parsed = parseSkillMarkdown("---\ndescription: A check.\nmetadata:\n  version: 3\n---\nDo the check.\n", "verify-gibson");
    assert.equal(parsed.parseProblem, null);
    assert.equal(parsed.name, "verify-gibson");
    assert.equal(parsed.description, "A check.");
    assert.equal(parsed.version, "3");
    assert.equal(parsed.body, "Do the check.\n");
  });

  it("prefers frontmatter version over metadata.version", () => {
    const parsed = parseSkillMarkdown("---\nversion: 1.2.0\nmetadata:\n  version: 9\n---\nBody\n", "spec-writer");
    assert.equal(parsed.version, "1.2.0");
  });

  it("treats malformed frontmatter as unreadable, not as an empty success", () => {
    const parsed = parseSkillMarkdown("---\nname: bad\n\tops: 1\n---\nBody that mentions every runtime.\n", "bad");
    assert.ok(parsed.parseProblem);
    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.version, null);
    assert.equal(parsed.name, "bad");
    const decision = resolveRuntimes({
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      sibling: null,
      siblingProblem: null,
      parseProblem: parsed.parseProblem,
    });
    assert.deepEqual(decision.flags, CLAUDE_ONLY);
    assert.notDeepEqual(decision.flags, ALL_RUNTIMES);
    assert.equal(decision.flags.codex, false);
    assert.equal(decision.flags.grok, false);
    assert.ok(decision.problem);
  });

  it("defaults to claude when the body uses Claude-only machinery", () => {
    for (const needle of ["mcp__", "AskUserQuestion", "TodoWrite", "Skill tool", "Agent tool", "ExitPlanMode"]) {
      const decision = resolveRuntimes({
        frontmatter: {},
        body: `See the ${needle} before you stop.`,
        sibling: null,
        siblingProblem: null,
        parseProblem: null,
      });
      assert.deepEqual(decision.flags, CLAUDE_ONLY, needle);
      assert.equal(decision.problem, null);
    }
  });

  it("defaults to claude when allowed-tools is present", () => {
    const decision = resolveRuntimes({
      frontmatter: { "allowed-tools": "Read" },
      body: "Plain instructions.",
      sibling: null,
      siblingProblem: null,
      parseProblem: null,
    });
    assert.deepEqual(decision.flags, CLAUDE_ONLY);
  });

  it("lets an explicit runtimes list win and ignores unknown names", () => {
    const decision = resolveRuntimes({
      frontmatter: { runtimes: ["codex", "nope", "grok"] },
      body: "This mentions the Skill tool but the list wins.",
      sibling: null,
      siblingProblem: null,
      parseProblem: null,
    });
    assert.equal(decision.problem, null);
    assert.equal(decision.flags.codex, true);
    assert.equal(decision.flags.grok, true);
    assert.equal(decision.flags.claude, false);
    assert.deepEqual(decision.unknown, ["nope"]);
  });

  it("treats an empty runtimes list as compatible with nothing", () => {
    const decision = resolveRuntimes({
      frontmatter: { runtimes: [] },
      body: "Plain.",
      sibling: null,
      siblingProblem: null,
      parseProblem: null,
    });
    assert.deepEqual(decision.flags, NO_RUNTIMES);
    assert.equal(decision.problem, null);
  });

  it("rejects a runtimes value that is not a list by keeping claude only", () => {
    const decision = resolveRuntimes({
      frontmatter: { runtimes: { claude: true, codex: true, grok: true, hermes: true, mini: true } },
      body: "Plain.",
      sibling: null,
      siblingProblem: null,
      parseProblem: null,
    });
    assert.deepEqual(decision.flags, CLAUDE_ONLY);
    assert.match(decision.problem ?? "", /not a list/);
  });

  it("reads runtimes from a sibling manifest when frontmatter has none", () => {
    const decision = resolveRuntimes({
      frontmatter: {},
      body: "Plain.",
      sibling: { runtimes: "hermes, mini" },
      siblingProblem: null,
      parseProblem: null,
    });
    assert.equal(decision.flags.hermes, true);
    assert.equal(decision.flags.mini, true);
    assert.equal(decision.flags.claude, false);
  });

  it("does not treat a broken sibling as compatible with everything", () => {
    const decision = resolveRuntimes({
      frontmatter: {},
      body: "Plain instructions for every runtime.",
      sibling: null,
      siblingProblem: "skill.json is not valid JSON",
      parseProblem: null,
    });
    assert.deepEqual(decision.flags, CLAUDE_ONLY);
    assert.match(decision.problem ?? "", /not valid JSON/);
  });

  it("defaults to all five runtimes when nothing says otherwise", () => {
    const decision = resolveRuntimes({
      frontmatter: { name: "verify-gibson" },
      body: "Run the checks.",
      sibling: null,
      siblingProblem: null,
      parseProblem: null,
    });
    assert.deepEqual(decision.flags, ALL_RUNTIMES);
    assert.equal(decision.problem, null);
  });

  it("hashes the raw SKILL.md bytes and does not normalise a trailing newline", () => {
    const raw = "---\nname: verify-gibson\n---\nBody\n";
    const expected = createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
    assert.equal(skillSha(raw), expected);
    assert.notEqual(skillSha(raw), skillSha(raw.trimEnd()));
    assert.equal(shortSha(expected), expected.slice(0, 7));
    assert.equal(shortSha(expected).length, 7);
  });

  it("rejects a NUL byte as text", () => {
    assert.equal(decodeUtf8(Buffer.from("ok")), "ok");
    assert.equal(decodeUtf8(Buffer.from([0x68, 0x00, 0x69])), null);
  });
});

describe("settings patch validation", () => {
  const current = { trigger: "off" as const, scope: { mode: "all" as const, lanes: [] }, schedule: null };

  it("rejects an empty object, unknown keys, and a bad trigger", () => {
    assert.equal(parseSettingsPatch({}, current).ok, false);
    assert.equal(parseSettingsPatch({ trigger: "on_request", dry_run: true }, current).ok, false);
    assert.equal(parseSettingsPatch({ trigger: "always" }, current).ok, false);
    assert.equal(parseSettingsPatch([], current).ok, false);
  });

  it("requires a five-field cron for scheduled and clears schedule otherwise", () => {
    const missing = parseSettingsPatch({ trigger: "scheduled" }, current);
    assert.equal(missing.ok, false);
    const named = parseSettingsPatch({ trigger: "scheduled", schedule: "0 9 * * MON" }, current);
    assert.equal(named.ok, false);
    const high = parseSettingsPatch({ trigger: "scheduled", schedule: "60 * * * *" }, current);
    assert.equal(high.ok, false);
    const ok = parseSettingsPatch({ trigger: "scheduled", schedule: "*/15 0-6 * * 1-5" }, current);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.schedule, "*/15 0-6 * * 1-5");
    const cleared = parseSettingsPatch(
      { trigger: "on_request" },
      { trigger: "scheduled", scope: current.scope, schedule: "0 9 * * 1" },
    );
    assert.equal(cleared.ok, true);
    if (cleared.ok) assert.equal(cleared.value.schedule, null);
  });

  it("rejects a present cron that is not five fields even when the trigger is not scheduled", () => {
    const bad = parseSettingsPatch({ trigger: "on_request", schedule: "not a cron" }, current);
    assert.equal(bad.ok, false);
    assert.equal(isCron("0 9 * * 7"), true);
    assert.equal(isCron("0 9 * * 8"), false);
  });

  it("forces lanes empty for all and requires a lane for selected", () => {
    const all = parseSettingsPatch({ scope: { mode: "all", lanes: ["conference-os"] } }, current);
    assert.equal(all.ok, true);
    if (all.ok) assert.deepEqual(all.value.scope, { mode: "all", lanes: [] });
    const none = parseSettingsPatch({ scope: { mode: "selected", lanes: [] } }, current);
    assert.equal(none.ok, false);
    const extra = parseSettingsPatch({ scope: { mode: "selected", lanes: ["conference-os"], extra: true } }, current);
    assert.equal(extra.ok, false);
    const picked = parseSettingsPatch({ scope: { mode: "selected", lanes: [" conference-os ", "conference-os"] } }, current);
    assert.equal(picked.ok, true);
    if (picked.ok) assert.deepEqual(picked.value.scope.lanes, ["conference-os"]);
  });
});

describe("drift compare and pointer text", () => {
  const mirror = [
    { name: "alpha", sha: "a".repeat(64) },
    { name: "beta", sha: "b".repeat(64) },
  ];

  it("classifies missing, extra, and differs", () => {
    const diff = compareDrift(mirror, [
      { name: "beta", sha: "c".repeat(64) },
      { name: "gamma", sha: "d".repeat(64) },
    ]);
    assert.deepEqual(diff.missing.map((item) => item.name), ["alpha"]);
    assert.deepEqual(diff.extra.map((item) => item.name), ["gamma"]);
    assert.deepEqual(diff.differs, [{ name: "beta", mirrorSha: "b".repeat(64), localSha: "c".repeat(64) }]);
  });

  it("counts a skill once on the list even when two hosts both lack it", () => {
    const report = [{ name: "alpha", sha: "a".repeat(64) }];
    assert.equal(driftNameCount(mirror, [report, report]), 1);
  });

  it("rejects a directory outside the configured list and a duplicate name", () => {
    assert.deepEqual(driftDirs({} as NodeJS.ProcessEnv), ["~/.codex/skills", "~/.agents/skills"]);
    const badDir = parseDriftBody({ host: "lane-host", dir: "/tmp/skills", skills: [] });
    assert.equal(badDir.ok, false);
    const dup = parseDriftBody({
      host: "lane-host",
      dir: "~/.codex/skills",
      skills: [
        { name: "alpha", sha: "a".repeat(64) },
        { name: "alpha", sha: "b".repeat(64) },
      ],
    });
    assert.equal(dup.ok, false);
    const upper = parseDriftBody({
      host: "lane-host",
      dir: "~/.agents/skills",
      skills: [{ name: "alpha", sha: "A".repeat(64) }],
    });
    assert.equal(upper.ok, true);
    if (upper.ok) assert.equal(upper.skills[0].sha, "a".repeat(64));
  });

  it("renders pointers in id order inside markers and returns nothing when empty", () => {
    assert.equal(renderPointers([], { runtime: "grok", lane: "conference-os" }), "");
    const text = renderPointers(
      [
        { id: "zeta", version: null, sha: "abc1234ffff", description: "Last" },
        { id: "alpha", version: "1.0.0", sha: "1234567ffff", description: "First" },
      ],
      { runtime: "grok", lane: "conference-os" },
    );
    assert.match(text, /^<!-- ak-skills:begin -->/);
    assert.match(text, /<!-- ak-skills:end -->$/);
    const alpha = text.indexOf("- alpha");
    const zeta = text.indexOf("- zeta");
    assert.ok(alpha >= 0 && zeta > alpha);
    assert.match(text, /- alpha \(1\.0\.0, 1234567\) — First\. Fetch: get_skill \{"id":"alpha"\}; run: run_skill \{"id":"alpha","runtime":"grok","lane":"conference-os"\}/);
    assert.match(text, /- zeta \(unversioned, abc1234\)/);
  });
});

describe("stall minutes and github token", () => {
  it("falls back to 60 for a blank, a word, a zero, and a value past 7 days", () => {
    const minutes = (value: Record<string, string | undefined>) => stallMinutes(value as NodeJS.ProcessEnv);
    assert.equal(minutes({}), 60);
    assert.equal(minutes({ AK_SKILL_STALL_MINUTES: "" }), 60);
    assert.equal(minutes({ AK_SKILL_STALL_MINUTES: "soon" }), 60);
    assert.equal(minutes({ AK_SKILL_STALL_MINUTES: "0" }), 60);
    assert.equal(minutes({ AK_SKILL_STALL_MINUTES: "10081" }), 60);
    assert.equal(minutes({ AK_SKILL_STALL_MINUTES: "15" }), 15);
  });

  it("prefers GH_TOKEN over GITHUB_TOKEN and returns null when both are blank", () => {
    const token = (value: Record<string, string | undefined>) => githubToken(value as NodeJS.ProcessEnv);
    assert.equal(token({ GH_TOKEN: "gh", GITHUB_TOKEN: "hub" }), "gh");
    assert.equal(token({ GITHUB_TOKEN: "hub" }), "hub");
    assert.equal(token({ GH_TOKEN: "  ", GITHUB_TOKEN: "" }), null);
  });
});

describe("assemble keeps an unreadable skill instead of dropping it", () => {
  it("records a preserved directory as an error and does not emit a skill row", () => {
    const assembled = assembleSkills({
      source_id: "master-skills",
      position: 0,
      globs: ["skills/*"],
      files: [],
      preservedDirs: ["skills/keep"],
    });
    assert.equal(assembled.skills.length, 0);
    assert.equal(assembled.preserved[0]?.id, "keep");
    assert.match(assembled.errors[0]?.message ?? "", /could not be read/);
  });
});

describe("skill scopes, alerts, and the digest", () => {
  it("denies agent credentials on operator routes and maps the three tools", () => {
    const reader = { kind: "agent" as const, id: "cred-1", scopes: ["skills:read"] };
    const writer = { kind: "agent" as const, id: "cred-2", scopes: ["skills:write"] };
    assert.equal(authorizeTool(reader, "list_skills").ok, true);
    assert.equal(authorizeTool(reader, "run_skill").ok, false);
    assert.equal(authorizeTool(writer, "run_skill").ok, true);
    assert.equal(authorizeRoute(writer, "POST", "/api/skills/sync").ok, false);
    assert.equal(authorizeRoute(writer, "POST", "/api/skills/drift").ok, false);
    assert.equal(authorizeRoute(writer, "PATCH", "/api/skills/verify-gibson").ok, false);
    assert.equal(authorizeRoute(reader, "GET", "/api/skills/verify-gibson").ok, true);
    assert.equal(authorizeRoute({ kind: "legacy" }, "POST", "/api/skills/sync").ok, true);
  });

  it("rolls stalled skill runs into one alert past three and prints the digest limit", () => {
    const one = buildAlerts([], [], [{ run_id: "run-1", skill_id: "alpha", agent: "lane", at: "2026-10-27T10:00:00.000Z" }]);
    assert.equal(one.find((alert) => alert.rule === "skillStalled")?.id, "skill-stalled:run-1");
    const rolled = buildAlerts(
      [],
      [],
      Array.from({ length: 4 }, (_, i) => ({ run_id: `run-${i}`, skill_id: "alpha", agent: "lane", at: "2026-10-27T10:00:00.000Z" })),
    ).filter((alert) => alert.rule === "skillStalled");
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0]?.level, "warn");
    assert.equal(rolled[0]?.id, "skill-stalled:4");
    const text = formatDigest(demoProgress("7d"));
    assert.match(text, /Only triggers routed through Agent Kontrol are counted/);
    const openapi = fs.readFileSync("src/lib/openapi.ts", "utf8");
    for (const path of ["/api/skills\"", "/api/skills/sync", "/api/skills/drift", "/api/skills/{id}"]) {
      assert.ok(openapi.includes(path), path);
    }
  });
});
