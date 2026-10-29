import type { Runtime } from "../types";
import { renderAgentSkillsDocument, renderAgentSkillsTree } from "./agentskills";
import { renderClaudeDocument, renderClaudeTree } from "./claude";
import { renderHermesDocument, renderHermesTree } from "./hermes";
import { renderNemoClawDocument, renderNemoClawTree } from "./nemoclaw";
import type { FormatSkill, RenderTree, SkillFormatId } from "./types";

/**
 * Runtime to format. mini uses the Claude passthrough.
 * nemoclaw uses the Agent Skills directory and the NemoClaw frontmatter subset.
 */

export function formatForRuntime(runtime: Runtime | null): SkillFormatId {
  if (runtime === "hermes") return "hermes";
  if (runtime === "nemoclaw") return "nemoclaw";
  if (runtime === "codex" || runtime === "grok") return "agentskills";
  return "claude";
}

/** Instruction document placed under the MCP preamble. Claude stays the body. */
export function renderSkillDocument(runtime: Runtime | null, skill: FormatSkill): string {
  const format = formatForRuntime(runtime);
  if (format === "hermes") return renderHermesDocument(skill) ?? skill.body;
  if (format === "nemoclaw") return renderNemoClawDocument(skill) ?? skill.body;
  if (format === "agentskills") return renderAgentSkillsDocument(skill) ?? skill.body;
  return renderClaudeDocument(skill);
}

export function renderSkillTree(runtime: Runtime, skill: FormatSkill): RenderTree {
  const format = formatForRuntime(runtime);
  if (format === "hermes") return renderHermesTree(skill);
  if (format === "nemoclaw") return renderNemoClawTree(skill);
  if (format === "agentskills") return renderAgentSkillsTree(skill);
  return renderClaudeTree(skill);
}

export type { FormatSkill, RenderTree, SkillFormatId } from "./types";
