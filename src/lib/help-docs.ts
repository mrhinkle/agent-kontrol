import fs from "node:fs";
import path from "node:path";

/**
 * The in-app Help menu. These are the repo's own Markdown docs, read at build
 * time, so the Help pages and the files on GitHub are always the same text.
 */
export interface HelpDoc {
  slug: string;
  title: string;
  /** Path relative to the repo root. */
  file: string;
  blurb: string;
}

export const HELP_DOCS: HelpDoc[] = [
  { slug: "deploy", title: "Deploy and operate", file: "docs/DEPLOY.md", blurb: "One-line install, deployment targets, environment variables, upgrades." },
  { slug: "agents", title: "Connect agents", file: "docs/AGENTS.md", blurb: "Every adapter and what each one can do." },
  { slug: "mcp", title: "MCP tools", file: "docs/MCP.md", blurb: "The 11 tools and how to connect an MCP host." },
  { slug: "api", title: "REST API", file: "docs/API.md", blurb: "Routes, authentication, request shapes." },
  { slug: "database", title: "Database", file: "docs/DATABASE.md", blurb: "Neon or any Postgres, and how the driver is chosen." },
  { slug: "architecture", title: "Architecture", file: "docs/ARCHITECTURE.md", blurb: "Data flow, tables, and a map of the code." },
  { slug: "progress-board", title: "Progress board", file: "docs/PROGRESS-BOARD.md", blurb: "How net backlog is measured and configured." },
  { slug: "usage", title: "Usage and Costs", file: "docs/USAGE.md", blurb: "The experimental cost ledger." },
  { slug: "security", title: "Security", file: "SECURITY.md", blurb: "Threat model, risks, and how to report a problem." },
  { slug: "playbook", title: "Fleet playbook", file: "PLAYBOOK.md", blurb: "How to run a multi-vendor agent fleet." },
  { slug: "changelog", title: "Changelog", file: "CHANGELOG.md", blurb: "What changed in each release." },
];

export const REPO_BLOB = "https://github.com/mrhinkle/agent-kontrol/blob/main/";

export function findDoc(slug: string): HelpDoc | undefined {
  return HELP_DOCS.find((d) => d.slug === slug);
}

/** Repo root. `next build` and `next start` both run from it. */
function repoPath(rel: string): string {
  return path.join(process.cwd(), rel);
}

/**
 * Points links between docs at /help/<slug>, other repo-relative links at
 * GitHub, and leaves absolute and in-page links alone.
 */
export function rewriteLinks(source: string, docFile: string): string {
  const dir = path.posix.dirname(docFile);
  return source.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return whole;
    const [rawPath, hash] = target.split("#");
    const resolved = path.posix.normalize(path.posix.join(dir, rawPath));
    const doc = HELP_DOCS.find((d) => d.file === resolved);
    if (doc) return `](/help/${doc.slug})`;
    return `](${REPO_BLOB}${resolved}${hash ? `#${hash}` : ""})`;
  });
}

/** Drops the leading "# Title" line; the page header shows the title instead. */
export function stripTitle(source: string): string {
  return source.replace(/^\s*# .*\n+/, "");
}

export function loadDoc(slug: string): { doc: HelpDoc; source: string } | null {
  const doc = findDoc(slug);
  if (!doc) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(repoPath(doc.file), "utf8");
  } catch {
    return null;
  }
  return { doc, source: rewriteLinks(stripTitle(raw), doc.file) };
}
