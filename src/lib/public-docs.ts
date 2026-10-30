import fs from "node:fs";
import path from "node:path";

/**
 * Public Markdown docs. The key is the URL filename; the value is a repo-relative
 * path. The request name is only ever used as a key into this map, never joined
 * onto a filesystem path, so traversal and encoding cannot escape the three files.
 */
export const PUBLIC_DOC_FILES = {
  "mcp.md": "docs/MCP.md",
  "api.md": "docs/API.md",
  "agents.md": "docs/AGENTS.md",
} as const;

export type PublicDocName = keyof typeof PUBLIC_DOC_FILES;

const PUBLIC_DOC_NAMES = new Set<string>(Object.keys(PUBLIC_DOC_FILES));

/**
 * The 24 tools registered in src/app/api/[transport]/route.ts, in that order.
 * `reply_to_mark` is a deprecated alias and is not one of these 24.
 */
export const MCP_TOOL_NAMES = [
  "report_status",
  "get_fleet_status",
  "get_progress_digest",
  "get_morning_brief",
  "remember",
  "recall",
  "check_inbox",
  "reply_to_operator",
  "create_task",
  "get_task_queue",
  "claim_task",
  "update_task",
  "list_skills",
  "get_skill",
  "run_skill",
  "request_decision",
  "list_decisions",
  "resolve_decision",
  "send_message",
  "requeue_task",
  "delete_note",
  "list_activity",
  "get_settings",
  "set_watched_repos",
] as const;

export type PublicDocResult =
  | { ok: true; body: string; file: string }
  | { ok: false; status: 404 | 500 };

/** Exact filename only. Does not decode, normalize, or case-fold. */
export function resolvePublicDoc(name: string): PublicDocName | null {
  if (typeof name !== "string" || !PUBLIC_DOC_NAMES.has(name)) return null;
  return name as PublicDocName;
}

/**
 * Read one allowlisted doc. A name that is not allowlisted is 404. An allowlisted
 * file that cannot be read is 500: a missing doc is a broken server, not an
 * empty success.
 */
export function readPublicDoc(name: string, root: string = process.cwd()): PublicDocResult {
  const resolved = resolvePublicDoc(name);
  if (!resolved) return { ok: false, status: 404 };
  const rel = PUBLIC_DOC_FILES[resolved];
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, rel);
  const expected = path.join(rootResolved, rel);
  if (full !== expected || !full.startsWith(rootResolved + path.sep)) {
    return { ok: false, status: 500 };
  }
  let body: string;
  try {
    body = fs.readFileSync(full, "utf8");
  } catch {
    return { ok: false, status: 500 };
  }
  if (body.length === 0) return { ok: false, status: 500 };
  return { ok: true, body, file: rel };
}

/**
 * First prose line under each `### <tool>` heading in docs/MCP.md.
 * Skips the `reply_to_mark` alias note and table rows. Throws if a tool
 * section or its summary line is missing, so the index cannot ship short.
 */
export function toolLinesFromMcpDoc(markdown: string): { name: string; line: string }[] {
  const sections = new Map<string, string>();
  for (const part of markdown.split(/^### /m).slice(1)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    const heading = part.slice(0, nl).trim();
    const body = part.slice(nl + 1);
    const h2 = body.search(/\n## /);
    sections.set(heading, h2 === -1 ? body : body.slice(0, h2));
  }
  return MCP_TOOL_NAMES.map((name) => {
    const section = sections.get(name);
    if (section === undefined) throw new Error(`MCP doc is missing the ${name} section`);
    const line = summaryLine(section);
    if (!line) throw new Error(`MCP doc has no summary for ${name}`);
    return { name, line };
  });
}

function summaryLine(section: string): string | null {
  for (const paragraph of section.split(/\n\n+/)) {
    const line = paragraph.trim().split("\n")[0]?.trim() ?? "";
    if (!line || line.startsWith("|") || line.startsWith("`reply_to_mark`")) continue;
    return line;
  }
  return null;
}

/** http(s) origin with no path, query, or credentials. Anything else throws. */
export function requireHttpOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("bad origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad origin");
  if (!url.host || url.username || url.password) throw new Error("bad origin");
  return url.origin;
}

/** Markdown index. Tool lines come from docs/MCP.md; links use the request origin. */
export function buildLlmsTxt(origin: string, mcpMarkdown: string): string {
  const base = requireHttpOrigin(origin);
  const tools = toolLinesFromMcpDoc(mcpMarkdown);
  if (tools.length !== MCP_TOOL_NAMES.length) throw new Error("tool index incomplete");
  const toolList = tools.map((tool) => `- \`${tool.name}\`: ${tool.line}`).join("\n");
  return [
    "# Agent Kontrol",
    "",
    "Agent Kontrol is a dashboard and coordination server for AI coding agents. Agents report what they are doing, share notes, take tasks from a queue, and read progress. This file is the public index for an agent that only has the deployment URL.",
    "",
    "## MCP",
    "",
    `- Endpoint: ${base}/api/mcp`,
    "- Transport: Streamable HTTP",
    `- Auth: a bearer token (\`Authorization: Bearer <token>\`) or OAuth. A call without valid auth receives 401 and a WWW-Authenticate header. Discovery: ${base}/.well-known/oauth-protected-resource`,
    "",
    "## Tools",
    "",
    "Twenty-four tools. Names are stable within 1.x.",
    "",
    toolList,
    "",
    "## Docs",
    "",
    `- [MCP server and tools](${base}/docs/mcp.md)`,
    `- [REST API](${base}/docs/api.md)`,
    `- [Agent adapters](${base}/docs/agents.md)`,
    "",
    "Those three documents are the repository files, served as Markdown with no dashboard session. No other name under /docs is public.",
    "",
  ].join("\n");
}

const PLAIN = "text/plain; charset=utf-8";

export function llmsTxtResponse(
  origin: string,
  mcp: PublicDocResult
): { status: number; contentType: string; body: string } {
  if (!mcp.ok) return { status: 500, contentType: PLAIN, body: "document unavailable" };
  try {
    return { status: 200, contentType: PLAIN, body: buildLlmsTxt(origin, mcp.body) };
  } catch {
    return { status: 500, contentType: PLAIN, body: "document unavailable" };
  }
}
