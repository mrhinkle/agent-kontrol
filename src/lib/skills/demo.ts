import type { SkillsDigest } from "../progress-types";
import type { TimeWindow } from "../progress-config";
import { skillContentSha, shortSha } from "./sha";
import {
  emptyRuntimes,
  matchesCategory,
  runtimeList,
  type Runtime,
  type RuntimeMap,
  type SkillDetail,
  type SkillListItem,
  type Trigger,
  type UpstreamInfo,
} from "./types";

/**
 * Synthetic skills for demo mode. Names match the /skills wireframe.
 * Nothing here is a real repository, host, or person.
 */

interface DemoSkill {
  id: string;
  description: string;
  version: string;
  raw: string;
  body: string;
  runtimes: RuntimeMap;
  trigger: Trigger;
  scope: SkillListItem["scope"];
  category: string | null;
  tags: string[];
  schedule: string | null;
  references: { path: string; content: string }[];
}

const VERIFY_RAW = `---
name: verify-gibson
description: Prove a change works before PR.
version: 1.2.0
---
Prove the change against the lane's checks, then stop.
`;

const SPEC_RAW = `---
name: spec-writer
description: Turn an issue into a build spec.
version: 1.0.0
---
Write a spec another agent can build without asking a question.
`;

const VOICE_RAW = `---
name: operator-voice
description: Match the house voice for a draft.
version: 2.1.0
allowed-tools: Read
---
Revise the draft into the house voice. This skill uses the Skill tool.
`;

function allOn(): RuntimeMap {
  return emptyRuntimes(true);
}

function only(names: Runtime[]): RuntimeMap {
  const map = emptyRuntimes(false);
  for (const name of names) map[name] = true;
  return map;
}

const DEMO_SKILLS: DemoSkill[] = [
  {
    id: "verify-gibson",
    description: "Prove a change works before PR.",
    version: "1.2.0",
    raw: VERIFY_RAW,
    body: "Prove the change against the lane's checks, then stop.\n",
    runtimes: allOn(),
    trigger: "on_request",
    scope: { mode: "all", lanes: [] },
    category: null,
    tags: [],
    schedule: null,
    references: [
      { path: "playbook.md", content: "Run the checks. Record what failed.\n" },
      { path: "checks.sh", content: "echo ok\n" },
    ],
  },
  {
    id: "spec-writer",
    description: "Turn an issue into a build spec.",
    version: "1.0.0",
    raw: SPEC_RAW,
    body: "Write a spec another agent can build without asking a question.\n",
    runtimes: only(["claude", "codex"]),
    trigger: "auto_inject",
    scope: { mode: "selected", lanes: ["conference-os", "chatterbuilt"] },
    category: "Engineering",
    tags: ["spec", "fleet"],
    schedule: null,
    references: [],
  },
  {
    id: "operator-voice",
    description: "Match the house voice for a draft.",
    version: "2.1.0",
    raw: VOICE_RAW,
    body: "Revise the draft into the house voice. This skill uses the Skill tool.\n",
    runtimes: only(["claude"]),
    trigger: "on_request",
    scope: { mode: "all", lanes: [] },
    category: "Writing",
    tags: ["voice"],
    schedule: null,
    references: [],
  },
];

const DEMO_COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const DEMO_SYNCED_AT = "2026-10-27T07:00:00.000Z";

export function demoUpstream(): UpstreamInfo {
  return { source: "master-skills", sha: DEMO_COMMIT, syncedAt: DEMO_SYNCED_AT, driftCount: 2 };
}

export function demoSkillRows(): DemoSkill[] {
  return DEMO_SKILLS;
}

export function demoList(filter: { runtime?: string | null; q?: string | null; category?: string | null }): SkillListItem[] {
  const q = filter.q?.trim().toLowerCase() ?? "";
  return DEMO_SKILLS.filter((skill) => !filter.runtime || skill.runtimes[filter.runtime as Runtime] === true)
    .filter((skill) => matchesCategory(skill.category, filter.category))
    .filter((skill) => !q || skill.id.includes(q) || skill.description.toLowerCase().includes(q))
    .map((skill) => ({
      id: skill.id,
      name: skill.id,
      description: skill.description,
      version: skill.version,
      sha: skillContentSha(skill.raw),
      runtimes: runtimeList(skill.runtimes),
      category: skill.category,
      tags: skill.tags,
      trigger: skill.trigger,
      scope: skill.scope,
      triggerCount7d: skill.id === "verify-gibson" ? 2 : 0,
      lastRun: skill.id === "verify-gibson" ? { at: "2026-10-27T09:14:00.000Z", agent: "grok-lane-3" } : null,
    }));
}

export function demoDetail(id: string): SkillDetail | null {
  const skill = DEMO_SKILLS.find((item) => item.id === id);
  if (!skill) return null;
  const [item] = demoList({}).filter((row) => row.id === id);
  return {
    ...item,
    demo: true,
    body: skill.body,
    references: skill.references.map((ref) => ({ path: ref.path })),
    runtimes: skill.runtimes,
    schedule: skill.schedule,
    triggers: skill.id === "verify-gibson"
      ? [
          {
            at: "2026-10-27T09:14:00.000Z",
            agent: "grok-lane-3",
            lane: "conference-os",
            started: true,
            ended: true,
            status: "done",
            outcome: "done",
          },
          {
            at: "2026-10-27T08:02:00.000Z",
            agent: "codex-lane-1",
            lane: "chatterbuilt",
            started: true,
            ended: false,
            status: "stalled",
            outcome: null,
          },
        ]
      : [],
  };
}

export function demoReference(id: string, path: string): { sha: string; content: string } | null {
  const skill = DEMO_SKILLS.find((item) => item.id === id);
  const ref = skill?.references.find((item) => item.path === path);
  if (!skill || !ref) return null;
  return { sha: skillContentSha(skill.raw), content: ref.content };
}

export function demoSkillsDigest(window: TimeWindow): SkillsDigest {
  return {
    window,
    triggers_by_skill: [{ id: "verify-gibson", count: 2 }],
    triggers_by_runtime: { claude: 1, codex: 1, grok: 0, hermes: 0, mini: 0, nemoclaw: 0 },
    stalled: [
      {
        run_id: "00000000-0000-4000-8000-000000000001",
        skill_id: "verify-gibson",
        agent: "codex-lane-1",
        at: "2026-10-27T08:02:00.000Z",
      },
    ],
    enabled_never_used: ["operator-voice", "spec-writer"],
    note: "Only triggers routed through Agent Kontrol are counted.",
  };
}

export function demoShortSha(id: string): string {
  const skill = DEMO_SKILLS.find((item) => item.id === id);
  return skill ? shortSha(skillContentSha(skill.raw)) : "";
}
