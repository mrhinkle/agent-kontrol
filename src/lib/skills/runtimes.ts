import {
  ALL_RUNTIMES,
  CLAUDE_ONLY,
  NO_RUNTIMES,
  RUNTIMES,
  type Runtime,
  type RuntimeFlags,
} from "./types";

/**
 * Which runtimes may see a skill.
 * An explicit `runtimes` list wins. A list we cannot read is claude-only.
 * With no list, Claude-only machinery is claude-only. Anything else is every runtime in RUNTIMES.
 * Unknown names are ignored. Ignoring them does not add the other runtimes.
 */

const CLAUDE_MARKERS = ["mcp__", "AskUserQuestion", "TodoWrite", "Skill tool", "Agent tool", "ExitPlanMode"];

export interface RuntimeDecision {
  flags: RuntimeFlags;
  /** Set when the runtime list could not be evaluated. Never means "all runtimes". */
  problem: string | null;
  unknown: string[];
}

export function resolveRuntimes(input: {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Parsed skill.json or manifest.json object, when one was present and valid JSON. */
  sibling: Record<string, unknown> | null;
  /** Set when that sibling file existed but was not JSON. */
  siblingProblem: string | null;
  parseProblem: string | null;
}): RuntimeDecision {
  if (input.parseProblem) {
    return { flags: { ...CLAUDE_ONLY }, problem: input.parseProblem, unknown: [] };
  }
  if (Object.prototype.hasOwnProperty.call(input.frontmatter, "runtimes")) {
    const listed = flagsFromList(input.frontmatter.runtimes);
    if (!listed.ok) return { flags: { ...CLAUDE_ONLY }, problem: listed.error, unknown: [] };
    return { flags: listed.flags, problem: null, unknown: listed.unknown };
  }
  if (input.siblingProblem) {
    return { flags: { ...CLAUDE_ONLY }, problem: input.siblingProblem, unknown: [] };
  }
  if (input.sibling && Object.prototype.hasOwnProperty.call(input.sibling, "runtimes")) {
    const listed = flagsFromList(input.sibling.runtimes);
    if (!listed.ok) return { flags: { ...CLAUDE_ONLY }, problem: listed.error, unknown: [] };
    return { flags: listed.flags, problem: null, unknown: listed.unknown };
  }
  if (hasClaudeOnlyMachinery(input.frontmatter, input.body)) {
    return { flags: { ...CLAUDE_ONLY }, problem: null, unknown: [] };
  }
  return { flags: { ...ALL_RUNTIMES }, problem: null, unknown: [] };
}

export function hasClaudeOnlyMachinery(frontmatter: Record<string, unknown>, body: string): boolean {
  if (Object.prototype.hasOwnProperty.call(frontmatter, "allowed-tools")) return true;
  return CLAUDE_MARKERS.some((marker) => body.includes(marker));
}

function flagsFromList(value: unknown): { ok: true; flags: RuntimeFlags; unknown: string[] } | { ok: false; error: string } {
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === "string") items = value.split(/[,\s]+/).filter(Boolean);
  else return { ok: false, error: "runtimes is not a list" };
  const flags: RuntimeFlags = { ...NO_RUNTIMES };
  const unknown: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" && typeof item !== "number") return { ok: false, error: "runtimes entry is not a name" };
    const name = String(item).trim().toLowerCase();
    if (!name) continue;
    if ((RUNTIMES as readonly string[]).includes(name)) flags[name as Runtime] = true;
    else unknown.push(name);
  }
  return { ok: true, flags, unknown };
}
