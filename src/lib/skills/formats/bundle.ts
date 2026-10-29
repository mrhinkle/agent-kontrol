import { isConfigured } from "../../db";
import { demoSkillRows } from "../demo";
import { skillContentSha } from "../sha";
import { scopeAdmits } from "../settings";
import { listSettings, listSkillRows } from "../store";
import {
  DEFAULT_SCOPE,
  DEFAULT_TRIGGER,
  isRuntime,
  matchesCategory,
  type Runtime,
  type RuntimeFlags,
  type SkillRecord,
  type SkillScope,
  type Trigger,
} from "../types";
import { renderSkillTree } from "./index";
import { isSafeArchivePath } from "./paths";
import { tarGzip } from "./tar";
import type { FormatSkill, RenderedFile } from "./types";

export interface ExportFilter {
  runtime: Runtime;
  lane: string | null;
  category: string | null;
  query: string | null;
}

export interface BundleSkill {
  skill: FormatSkill;
  trigger: Trigger;
  scope: SkillScope;
  runtimes: RuntimeFlags;
}

export interface SkippedSkill {
  id: string;
  reason: string;
}

export interface BuiltBundle {
  files: RenderedFile[];
  /** Skills left out of the archive, in input order, with the reason. */
  skipped: SkippedSkill[];
  /** Reference paths left out of an otherwise exported skill. */
  rejectedReferences: string[];
}

/**
 * Same visibility as list_skills: trigger off is hidden, a selected scope
 * with no lane is hidden, and the lane has to be in scope. The runtime has
 * to be one the skill lists.
 */
export function visibleForExport(skills: BundleSkill[], filter: ExportFilter): BundleSkill[] {
  const q = filter.query?.trim().toLowerCase() ?? "";
  return skills.filter((row) => {
    if (row.trigger === "off") return false;
    if (!row.runtimes[filter.runtime]) return false;
    if (row.scope.mode === "selected" && !filter.lane) return false;
    if (!scopeAdmits(row.scope, filter.lane)) return false;
    if (!matchesCategory(row.skill.category, filter.category)) return false;
    if (!q) return true;
    return row.skill.id.toLowerCase().includes(q) || row.skill.description.toLowerCase().includes(q);
  });
}

interface RenderedSkill {
  id: string;
  files: RenderedFile[];
  rejected: string[];
}

export function buildBundle(skills: BundleSkill[], filter: ExportFilter): BuiltBundle {
  const skipped: SkippedSkill[] = [];
  const renderedSkills: RenderedSkill[] = [];
  for (const row of visibleForExport(skills, filter)) {
    const rendered = renderSkillTree(filter.runtime, row.skill);
    if (!rendered.ok) {
      skipped.push({ id: row.skill.id, reason: rendered.reason });
      continue;
    }
    const safeFiles: RenderedFile[] = [];
    let unsafe = false;
    for (const file of rendered.files) {
      if (!isSafeArchivePath(file.path)) {
        unsafe = true;
        break;
      }
      safeFiles.push(file);
    }
    // A single unsafe path drops the whole skill. Leaving SKILL.md in while
    // rejecting a sibling would still ship a tree the path check refused.
    if (unsafe) {
      skipped.push({ id: row.skill.id, reason: "unsafe skill path" });
      continue;
    }
    renderedSkills.push({ id: row.skill.id, files: safeFiles, rejected: rendered.rejected });
  }
  const colliding = duplicateSkillIndexes(renderedSkills);
  const files: RenderedFile[] = [];
  const rejectedReferences: string[] = [];
  renderedSkills.forEach((row, index) => {
    if (colliding.has(index)) {
      skipped.push({ id: row.id, reason: "duplicate archive path" });
      return;
    }
    files.push(...row.files);
    rejectedReferences.push(...row.rejected);
  });
  return { files: uniqueArchiveFiles(files), skipped, rejectedReferences };
}

/** Skills that share any archive path. Every one of them is omitted. */
function duplicateSkillIndexes(rows: RenderedSkill[]): Set<number> {
  const owners = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const seen = new Set<string>();
    for (const file of row.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      const list = owners.get(file.path) ?? [];
      list.push(index);
      owners.set(file.path, list);
    }
  });
  const colliding = new Set<number>();
  for (const list of owners.values()) {
    if (list.length < 2) continue;
    for (const index of list) colliding.add(index);
  }
  return colliding;
}

/** Drop every file whose path appears more than once. The archive keeps one path once. */
function uniqueArchiveFiles(files: RenderedFile[]): RenderedFile[] {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
  return files.filter((file) => counts.get(file.path) === 1);
}

const MANIFEST_PATH = "manifest.json";

/** Tar entries. A non-empty skip list is also written to manifest.json. */
export function archiveFiles(built: BuiltBundle): RenderedFile[] {
  if (built.skipped.length === 0) return built.files;
  if (built.files.some((file) => file.path === MANIFEST_PATH)) return built.files;
  return [
    ...built.files,
    { path: MANIFEST_PATH, content: `${JSON.stringify({ skipped: built.skipped })}\n` },
  ];
}

export function bundleGzip(skills: BundleSkill[], filter: ExportFilter): Buffer {
  return tarGzip(archiveFiles(buildBundle(skills, filter)));
}

export function parseExportQuery(url: string): { ok: true; filter: ExportFilter } | { ok: false; message: string; field: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "invalid url", field: "runtime" };
  }
  for (const key of ["runtime", "lane", "category", "q"]) {
    if (parsed.searchParams.getAll(key).length > 1) {
      return { ok: false, message: `${key} must be sent once`, field: key };
    }
  }
  const runtime = parsed.searchParams.get("runtime");
  if (runtime == null || !runtime.trim()) {
    return { ok: false, message: "runtime is required", field: "runtime" };
  }
  if (!isRuntime(runtime)) {
    return { ok: false, message: "runtime must be claude, codex, grok, hermes, or mini.", field: "runtime" };
  }
  const lane = blankToNull(parsed.searchParams.get("lane"));
  const category = parsed.searchParams.get("category");
  const query = parsed.searchParams.get("q");
  return { ok: true, filter: { runtime, lane, category, query } };
}

export async function loadExportSkills(): Promise<{ demo: boolean; skills: BundleSkill[] }> {
  if (!isConfigured()) return { demo: true, skills: demoBundleSkills() };
  const [rows, settings] = await Promise.all([listSkillRows(), listSettings()]);
  const byId = new Map(settings.map((row) => [row.skill_id, row]));
  const skills = rows
    .filter((row) => row.removed_at == null)
    .map((row) => {
      const setting = byId.get(row.id);
      return {
        skill: formatFromRecord(row),
        trigger: setting?.trigger ?? DEFAULT_TRIGGER,
        scope: setting?.scope ?? DEFAULT_SCOPE,
        runtimes: row.runtimes,
      };
    });
  return { demo: false, skills };
}

export function formatFromRecord(row: SkillRecord): FormatSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    sha: row.sha,
    body: row.body,
    category: row.category,
    tags: row.tags,
    references: row.references,
    frontmatter: row.frontmatter,
  };
}

function demoBundleSkills(): BundleSkill[] {
  return demoSkillRows().map((row) => ({
    skill: {
      id: row.id,
      name: row.id,
      description: row.description,
      version: row.version,
      sha: skillContentSha(row.raw),
      body: row.body,
      category: row.category,
      tags: row.tags,
      references: row.references,
      frontmatter: {},
    },
    trigger: row.trigger,
    scope: row.scope,
    runtimes: row.runtimes,
  }));
}

function blankToNull(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
