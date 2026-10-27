import { mcpToolError, type McpToolResult } from "../api-error";
import { isConfigured } from "../db";
import { demoDetail, demoList, demoReference, demoSkillRows } from "./demo";
import { scopeAdmits } from "./settings";
import { skillContentSha, shortSha } from "./sha";
import { finishSkillRun, gateSkill, renderReferenceText, renderSkillText, startSkillRun } from "./runs";
import { isRuntime, type Runtime } from "./types";

/**
 * MCP handlers for the skills mirror.
 *
 * run_skill is one tool with two phases. A separate report_skill_done would be
 * a second name for the same row and the same actor check. One tool keeps the
 * start and the end on the same scope and the same run id.
 *
 * Demo mode serves the fixture for reads. A start is not stored.
 */

const DEMO_RUN_NOTE = "DATABASE_URL not set; skill run not stored.";

function text(value: string): McpToolResult {
  return { content: [{ type: "text", text: value }] };
}

function fromFail(fail: { code: "not_found" | "forbidden" | "validation_failed"; message: string }): McpToolResult {
  return mcpToolError(fail.code, { message: fail.message });
}

export async function listSkillsTool(args: {
  runtime?: string;
  lane?: string;
  query?: string;
}): Promise<McpToolResult> {
  if (args.runtime && !isRuntime(args.runtime)) {
    return mcpToolError("validation_failed", { message: "runtime must be claude, codex, grok, hermes, or mini." });
  }
  const runtimeLine = args.runtime
    ? `runtime filter: ${args.runtime}`
    : "runtime filter: none (caller did not pass runtime).";
  const laneLine = args.lane ? `Lane filter: ${args.lane}` : "Lane filter: none (selected-lane skills are hidden)";
  const skills = isConfigured() ? await liveList(args) : demoVisible(args);
  const q = args.query?.trim().toLowerCase() ?? "";
  const filtered = skills.filter(
    (skill) => !q || skill.id.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q),
  );
  const lines = filtered.map(
    (skill) => `- ${skill.id} (${skill.version ?? "unversioned"}, ${shortSha(skill.sha)}) [${skill.trigger}] ${skill.description}`,
  );
  const body = lines.length ? lines.join("\n") : "No skills are visible for this runtime and lane.";
  return text([runtimeLine, laneLine, "", body].join("\n"));
}

export async function getSkillTool(args: {
  id: string;
  path?: string;
  runtime?: string;
  lane?: string;
}): Promise<McpToolResult> {
  if (!isConfigured()) return demoGet(args);
  const gated = await gateSkill({ id: args.id, runtime: args.runtime, lane: args.lane });
  if (!gated.ok) return fromFail(gated);
  if (args.path) {
    const rendered = renderReferenceText(gated.skill, args.path);
    if (!rendered.ok) return fromFail(rendered);
    return text(rendered.text);
  }
  const runtime = args.runtime && isRuntime(args.runtime) ? args.runtime : null;
  return text(renderSkillText(gated.skill, runtime));
}

export async function runSkillTool(args: {
  id: string;
  agent_id?: string;
  runtime?: string;
  lane?: string;
  run_id?: string;
  complete?: boolean;
  status?: "done" | "failed";
  note?: string;
}): Promise<McpToolResult> {
  if (args.run_id && args.complete !== true) {
    return mcpToolError("validation_failed", { message: "Pass complete:true to finish a run." });
  }
  if (args.complete === true && !args.run_id) {
    return mcpToolError("validation_failed", { message: "complete:true requires run_id." });
  }
  if (args.complete === true && args.run_id) {
    if (!isConfigured()) {
      const gated = await demoGate(args.id, args.runtime, args.lane);
      if (!gated.ok) return fromFail(gated);
      return text(DEMO_RUN_NOTE);
    }
    const finished = await finishSkillRun({ runId: args.run_id, status: args.status, note: args.note });
    if (!finished.ok) return fromFail(finished);
    return text(finished.text);
  }
  if (!args.agent_id || !args.runtime) {
    return mcpToolError("validation_failed", { message: "A start requires id, agent_id, and runtime." });
  }
  if (!isConfigured()) {
    const gated = await demoGate(args.id, args.runtime, args.lane);
    if (!gated.ok) return fromFail(gated);
    return text(DEMO_RUN_NOTE);
  }
  const started = await startSkillRun({
    id: args.id,
    agentId: args.agent_id,
    runtime: args.runtime,
    lane: args.lane,
  });
  if (!started.ok) return fromFail(started);
  return text(started.text);
}

async function liveList(args: { runtime?: string; lane?: string }): Promise<{
  id: string;
  version: string | null;
  sha: string;
  trigger: string;
  description: string;
}[]> {
  const { listSkillViews } = await import("./query");
  const listed = await listSkillViews({ runtime: args.runtime ?? null, q: null });
  return listed.skills.filter((skill) => {
    if (skill.trigger === "off") return false;
    if (skill.scope.mode === "selected" && !args.lane) return false;
    if (!scopeAdmits(skill.scope, args.lane)) return false;
    return true;
  });
}

function demoVisible(args: { runtime?: string; lane?: string }) {
  return demoList({ runtime: args.runtime ?? null, q: null }).filter((skill) => {
    if (skill.trigger === "off") return false;
    if (skill.scope.mode === "selected" && !args.lane) return false;
    return scopeAdmits(skill.scope, args.lane);
  });
}

function demoGet(args: { id: string; path?: string; runtime?: string; lane?: string }): McpToolResult {
  const gated = demoGate(args.id, args.runtime, args.lane);
  if (!gated.ok) return fromFail(gated);
  const skill = demoSkillRows().find((item) => item.id === args.id);
  if (!skill) return mcpToolError("not_found", { message: "Skill is not available." });
  const sha = skillContentSha(skill.raw);
  if (args.path) {
    const ref = demoReference(args.id, args.path);
    if (!ref) return mcpToolError("not_found", { message: "Reference not found." });
    return text([`# ${skill.id}`, `Pinned SHA: ${sha}`, `Reference: ${args.path}`, "", ref.content].join("\n"));
  }
  const detail = demoDetail(args.id);
  const runtime = args.runtime && isRuntime(args.runtime) ? args.runtime : null;
  const lines = [
    `# ${skill.id}`,
    `Pinned SHA: ${sha}`,
    runtime ? `Runtime: ${runtime}` : "Runtime: not filtered",
    "",
    detail?.body ?? skill.body,
  ];
  return text(lines.join("\n"));
}

function demoGate(
  id: string,
  runtime?: string | null,
  lane?: string | null,
): { ok: true } | { ok: false; code: "not_found" | "forbidden" | "validation_failed"; message: string } {
  const skill = demoList({}).find((item) => item.id === id);
  if (!skill || skill.trigger === "off") return { ok: false, code: "not_found", message: "Skill is not available." };
  if (runtime) {
    if (!isRuntime(runtime) || !skill.runtimes.includes(runtime)) {
      return { ok: false, code: "forbidden", message: "Skill is not compatible with this runtime." };
    }
  }
  if (skill.scope.mode === "selected" && !lane) {
    return { ok: false, code: "forbidden", message: "Skill is limited to selected lanes; pass lane." };
  }
  if (!scopeAdmits(skill.scope, lane)) {
    return { ok: false, code: "forbidden", message: "Skill is not in scope for this lane." };
  }
  return { ok: true };
}
