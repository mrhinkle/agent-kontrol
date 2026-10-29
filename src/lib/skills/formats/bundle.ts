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

export interface BuiltBundle {
  files: RenderedFile[];
  /** Skill ids left out because the folder or the name was not a safe path. */
  rejectedSkills: string[];
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

export function buildBundle(skills: BundleSkill[], filter: ExportFilter): BuiltBundle {
  const files: RenderedFile[] = [];
  const rejectedSkills: string[] = [];
  const rejectedReferences: string[] = [];
  for (const row of visibleForExport(skills, filter)) {
    const rendered = renderSkillTree(filter.runtime, row.skill);
    if (!rendered.ok) {
      rejectedSkills.push(row.skill.id);
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
      rejectedSkills.push(row.skill.id);
      continue;
    }
    files.push(...safeFiles);
    rejectedReferences.push(...rendered.rejected);
  }
  return { files, rejectedSkills, rejectedReferences };
}

export function bundleGzip(skills: BundleSkill[], filter: ExportFilter): Buffer {
  return tarGzip(buildBundle(skills, filter).files);
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
