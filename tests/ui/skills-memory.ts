import { randomUUID } from "node:crypto";
import { setSqlForTests, type Row, type SqlTag } from "../../src/lib/db";

/**
 * In-memory answer for the skills SQL markers. Unknown SQL throws, so a new
 * query cannot pass a test by returning nothing.
 */

export interface MemSkill {
  id: string;
  source_id: string;
  path: string;
  name: string;
  description: string;
  version: string | null;
  sha: string;
  commit_sha: string | null;
  body: string;
  references: { path: string; content: string }[];
  runtimes: Record<string, boolean>;
  category: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  removed_at: string | null;
  synced_at: string;
}

export interface MemRun {
  run_id: string;
  skill_id: string;
  skill_sha: string;
  agent_id: string;
  lane: string | null;
  runtime: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  note: string | null;
  actor_type: string | null;
  actor_id: string | null;
}

export interface MemSync {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  status: string;
  summary: unknown;
  error: string | null;
}

export interface MemDrift {
  host: string;
  dir: string;
  reported_at: string;
  entries: { name: string; sha: string }[];
}

export interface MemSpan {
  trace_id: string;
  span_id: string;
  name: string;
  kind: string;
  status: string;
  agent_id: string;
  started_at: string;
  ended_at: string | null;
  attributes: Record<string, unknown>;
}

export interface SkillsMemory {
  sources: {
    id: string;
    repo: string;
    ref: string | null;
    path_globs: string[];
    label: string;
    enabled: boolean;
    position: number;
  }[];
  skills: MemSkill[];
  settings: {
    skill_id: string;
    trigger: string;
    scope: unknown;
    schedule: string | null;
    updated_by: string | null;
    updated_at: string;
  }[];
  runs: MemRun[];
  syncRuns: MemSync[];
  drift: MemDrift[];
  spans: MemSpan[];
  calls: string[];
  throwOnSpan: boolean;
}

export const skillsMemory: SkillsMemory = emptyMemory();

function emptyMemory(): SkillsMemory {
  return {
    sources: defaultSources(),
    skills: [],
    settings: [],
    runs: [],
    syncRuns: [],
    drift: [],
    spans: [],
    calls: [],
    throwOnSpan: false,
  };
}

export function defaultSources(): SkillsMemory["sources"] {
  return [
    {
      id: "master-skills",
      repo: "mrhinkle/master-skills",
      ref: null,
      path_globs: ["skills/*"],
      label: "master-skills",
      enabled: true,
      position: 0,
    },
    {
      id: "the-gibson",
      repo: "The-AIE/the-gibson",
      ref: null,
      path_globs: ["skills/*", ".agents/skills/*"],
      label: "the-gibson",
      enabled: true,
      position: 1,
    },
  ];
}

export function resetSkillsMemory(): void {
  const next = emptyMemory();
  skillsMemory.sources = next.sources;
  skillsMemory.skills = next.skills;
  skillsMemory.settings = next.settings;
  skillsMemory.runs = next.runs;
  skillsMemory.syncRuns = next.syncRuns;
  skillsMemory.drift = next.drift;
  skillsMemory.spans = next.spans;
  skillsMemory.calls = next.calls;
  skillsMemory.throwOnSpan = false;
}

export function installSkillsSql(): void {
  resetSkillsMemory();
  setSqlForTests(skillsSql);
}

export function callsOf(marker: string): number {
  return skillsMemory.calls.filter((name) => name === marker).length;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value ?? fallback) as T;
}

function markerOf(text: string): string | null {
  return text.match(/sk:[a-z0-9-]+/)?.[0] ?? null;
}

const skillsSql: SqlTag = async (strings, ...values) => {
  const text = strings.join(" ");
  if (text.includes("insert into spans")) return spans(values);
  const marker = markerOf(text);
  if (!marker) throw new Error(`unhandled skills sql: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
  skillsMemory.calls.push(marker);
  return dispatch(marker, values);
};

function spans(values: unknown[]): Row[] {
  if (skillsMemory.throwOnSpan) throw new Error("span write failed");
  const at = (index: number): unknown[] => (Array.isArray(values[index]) ? (values[index] as unknown[]) : []);
  const traceIds = at(0);
  for (let i = 0; i < traceIds.length; i += 1) {
    const attributes = json<Record<string, unknown>>(at(11)[i], {});
    const span: MemSpan = {
      trace_id: String(traceIds[i]),
      span_id: String(at(1)[i] ?? ""),
      name: String(at(5)[i] ?? ""),
      kind: String(at(6)[i] ?? ""),
      status: String(at(7)[i] ?? ""),
      agent_id: String(at(3)[i] ?? ""),
      started_at: String(at(9)[i] ?? ""),
      ended_at: at(10)[i] == null ? null : String(at(10)[i]),
      attributes,
    };
    const prior = skillsMemory.spans.findIndex((row) => row.trace_id === span.trace_id && row.span_id === span.span_id);
    if (prior >= 0) skillsMemory.spans[prior] = span;
    else skillsMemory.spans.push(span);
  }
  skillsMemory.calls.push("insert into spans");
  return [];
}

function dispatch(marker: string, values: unknown[]): Row[] {
  switch (marker) {
    case "sk:list-sources":
      return skillsMemory.sources
        .filter((row) => row.enabled)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map((row) => ({ ...row }));
    case "sk:list-skills":
      return skillsMemory.skills.map((row) => ({ ...row, references: row.references }));
    case "sk:upsert-skill":
      return upsertSkill(values);
    case "sk:remove-skill":
      return removeSkill(values);
    case "sk:expire-sync":
      return expireSync(values);
    case "sk:begin-sync":
      return beginSync(values);
    case "sk:finish-sync":
      return finishSync(values);
    case "sk:insert-sync-run":
      return insertSync(values);
    case "sk:latest-sync":
      return skillsMemory.syncRuns
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.status === "ok" && row.finished_at)
        .sort((a, b) => {
          const time = String(b.row.finished_at).localeCompare(String(a.row.finished_at));
          return time !== 0 ? time : b.index - a.index;
        })
        .slice(0, 5)
        .map(({ row }) => row)
        .map((row) => ({ summary: row.summary, finished_at: row.finished_at, status: row.status, trigger: row.trigger }));
    case "sk:list-settings":
      return skillsMemory.settings.map((row) => ({ ...row }));
    case "sk:upsert-settings":
      return upsertSettings(values);
    case "sk:run-stats":
      return runStats(String(values[0]));
    case "sk:recent-runs":
      return recentRuns(String(values[0]), Number(values[1]));
    case "sk:insert-run":
      return insertRun(values);
    case "sk:get-run":
      return skillsMemory.runs.filter((row) => row.run_id === String(values[0])).map((row) => ({ ...row }));
    case "sk:complete-run":
      return completeRun(values);
    case "sk:delete-run":
      skillsMemory.runs = skillsMemory.runs.filter((row) => row.run_id !== String(values[0]));
      return [];
    case "sk:list-drift":
      return skillsMemory.drift.map((row) => ({ ...row, entries: row.entries }));
    case "sk:upsert-drift":
      return upsertDrift(values);
    case "sk:digest-runs":
      return digestRuns(String(values[0]));
    default:
      throw new Error(`unhandled skills marker ${marker}`);
  }
}

function upsertSkill(values: unknown[]): Row[] {
  const row: MemSkill = {
    id: String(values[0]),
    source_id: String(values[1]),
    path: String(values[2]),
    name: String(values[3]),
    description: String(values[4]),
    version: values[5] == null ? null : String(values[5]),
    sha: String(values[6]),
    commit_sha: values[7] == null ? null : String(values[7]),
    body: String(values[8]),
    references: json(values[9], []),
    runtimes: json(values[10], {}),
    frontmatter: json(values[11], {}),
    category: values[12] == null || String(values[12]).trim() === "" ? null : String(values[12]),
    tags: json<string[]>(values[13], []),
    removed_at: null,
    synced_at: String(values[14]),
  };
  const index = skillsMemory.skills.findIndex((skill) => skill.id === row.id);
  if (index >= 0) skillsMemory.skills[index] = row;
  else skillsMemory.skills.push(row);
  return [];
}

function removeSkill(values: unknown[]): Row[] {
  const at = String(values[0]);
  const id = String(values[1]);
  const row = skillsMemory.skills.find((skill) => skill.id === id && skill.removed_at == null);
  if (row) row.removed_at = at;
  return [];
}

function expireSync(values: unknown[]): Row[] {
  const startedAt = String(values[0]);
  const staleBefore = String(values[1]);
  for (const row of skillsMemory.syncRuns) {
    if (row.status === "running" && row.started_at < staleBefore) {
      row.status = "failed";
      row.finished_at = startedAt;
      row.error = "sync lease expired";
    }
  }
  return [];
}

function beginSync(values: unknown[]): Row[] {
  if (skillsMemory.syncRuns.some((row) => row.status === "running")) {
    const err = new Error("duplicate key value violates unique constraint skill_sync_one_running_idx");
    (err as Error & { code: string }).code = "23505";
    throw err;
  }
  skillsMemory.syncRuns.push({
    id: String(values[0]),
    started_at: String(values[1]),
    finished_at: null,
    trigger: String(values[2]),
    status: "running",
    summary: null,
    error: null,
  });
  return [];
}

function finishSync(values: unknown[]): Row[] {
  const row = skillsMemory.syncRuns.find((item) => item.id === String(values[4]) && item.status === "running");
  if (!row) return [];
  row.finished_at = String(values[0]);
  row.status = String(values[1]);
  row.summary = json(values[2], null);
  row.error = values[3] == null ? null : String(values[3]);
  return [];
}

function insertSync(values: unknown[]): Row[] {
  skillsMemory.syncRuns.push({
    id: randomUUID(),
    started_at: String(values[0]),
    finished_at: String(values[1]),
    trigger: String(values[2]),
    status: String(values[3]),
    summary: json(values[4], null),
    error: values[5] == null ? null : String(values[5]),
  });
  return [];
}

function upsertSettings(values: unknown[]): Row[] {
  const row = {
    skill_id: String(values[0]),
    trigger: String(values[1]),
    scope: json(values[2], {}),
    schedule: values[3] == null ? null : String(values[3]),
    updated_by: values[4] == null ? null : String(values[4]),
    updated_at: String(values[5]),
  };
  const index = skillsMemory.settings.findIndex((item) => item.skill_id === row.skill_id);
  if (index >= 0) skillsMemory.settings[index] = row;
  else skillsMemory.settings.push(row);
  return [];
}

function runStats(since: string): Row[] {
  const byId = new Map<string, MemRun[]>();
  for (const run of skillsMemory.runs) {
    const list = byId.get(run.skill_id) ?? [];
    list.push(run);
    byId.set(run.skill_id, list);
  }
  const rows: Row[] = [];
  for (const [skill_id, runs] of byId) {
    const ordered = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at));
    rows.push({
      skill_id,
      triggers_7d: runs.filter((run) => run.started_at >= since).length,
      last_agent: ordered[0]?.agent_id ?? null,
      last_at: ordered[0]?.started_at ?? null,
    });
  }
  return rows;
}

function recentRuns(skillId: string, limit: number): Row[] {
  return skillsMemory.runs
    .filter((run) => run.skill_id === skillId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, limit)
    .map((run) => ({ ...run }));
}

function insertRun(values: unknown[]): Row[] {
  skillsMemory.runs.push({
    run_id: String(values[0]),
    skill_id: String(values[1]),
    skill_sha: String(values[2]),
    agent_id: String(values[3]),
    lane: values[4] == null ? null : String(values[4]),
    runtime: String(values[5]),
    started_at: String(values[6]),
    ended_at: null,
    status: "running",
    note: null,
    actor_type: values[7] == null ? null : String(values[7]),
    actor_id: values[8] == null ? null : String(values[8]),
  });
  return [];
}

function completeRun(values: unknown[]): Row[] {
  const endedAt = String(values[0]);
  const status = String(values[1]);
  const note = values[2] == null ? null : String(values[2]);
  const runId = String(values[3]);
  const actorType = String(values[4]);
  const actorId = String(values[5]);
  const row = skillsMemory.runs.find(
    (run) => run.run_id === runId && run.ended_at == null && run.actor_type === actorType && run.actor_id === actorId,
  );
  if (!row) return [];
  row.ended_at = endedAt;
  row.status = status;
  row.note = note;
  return [{ ...row }];
}

function upsertDrift(values: unknown[]): Row[] {
  const row: MemDrift = {
    host: String(values[0]),
    dir: String(values[1]),
    reported_at: String(values[2]),
    entries: json(values[3], []),
  };
  const index = skillsMemory.drift.findIndex((item) => item.host === row.host && item.dir === row.dir);
  if (index >= 0) skillsMemory.drift[index] = row;
  else skillsMemory.drift.push(row);
  return [];
}

function digestRuns(since: string): Row[] {
  return skillsMemory.runs
    .filter((run) => run.started_at >= since || run.ended_at == null)
    .map((run) => ({ ...run }));
}
