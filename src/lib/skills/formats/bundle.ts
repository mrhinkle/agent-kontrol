import { isConfigured } from "../../db";
import { demoSkillRows } from "../demo";
import { skillContentSha } from "../sha";
import { isListSkillVisible } from "../settings";
import { listSettings, listSkillRows } from "../store";
import {
  DEFAULT_SCOPE,
  DEFAULT_TRIGGER,
  isRuntime,
  isTrigger,
  runtimeMustBeMessage,
  matchesCategory,
  type Runtime,
  type RuntimeFlags,
  type SkillRecord,
  type SkillScope,
} from "../types";
import { renderSkillTree } from "./index";
import { isSafeArchivePath, ustarSplit } from "./paths";
import { tarGzip } from "./tar";
import type { FormatSkill, RejectedPath, RenderedFile, RenderTree } from "./types";

export interface ExportFilter {
  runtime: Runtime;
  lane: string | null;
  category: string | null;
  query: string | null;
}

export interface BundleSkill {
  skill: FormatSkill;
  /** Stored trigger text. A value outside the supported set is invalid. */
  trigger: string;
  /** Set when the database value was not a supported trigger. `trigger` is then off. */
  triggerInvalid?: boolean;
  scope: SkillScope;
  runtimes: RuntimeFlags;
}

/** One omission. `path` is set for a reference and omitted for a whole skill. */
export interface SkippedEntry {
  skill: string;
  path?: string;
  reason: string;
}

export interface BuiltBundle {
  files: RenderedFile[];
  /** Omissions, in walk order. One list for skills and references. */
  skipped: SkippedEntry[];
}

const SKIPPED_HEADER_MAX_ENTRIES = 20;
const SKIPPED_HEADER_MAX_BYTES = 4096;

function matchesQuery(row: BundleSkill, filter: ExportFilter): boolean {
  const q = filter.query?.trim().toLowerCase() ?? "";
  if (!q) return true;
  return row.skill.id.toLowerCase().includes(q) || row.skill.description.toLowerCase().includes(q);
}

/**
 * Same visibility as list_skills. Trigger and lane use `isListSkillVisible`.
 * The runtime has to be one the skill lists. Category and query match the
 * list_skills filters.
 */
export function visibleForExport(skills: BundleSkill[], filter: ExportFilter): BundleSkill[] {
  return skills.filter((row) => {
    if (!isListSkillVisible({ trigger: row.trigger, scope: row.scope }, filter.lane)) return false;
    if (!row.runtimes[filter.runtime]) return false;
    if (!matchesCategory(row.skill.category, filter.category)) return false;
    return matchesQuery(row, filter);
  });
}

/** A bad trigger that list_skills would have shown if the trigger were on. */
function reportableInvalidTrigger(row: BundleSkill, filter: ExportFilter): boolean {
  if (row.triggerInvalid !== true && isTrigger(row.trigger)) return false;
  if (!row.runtimes[filter.runtime]) return false;
  if (!matchesCategory(row.skill.category, filter.category)) return false;
  if (!matchesQuery(row, filter)) return false;
  return isListSkillVisible({ trigger: "on_request", scope: row.scope }, filter.lane);
}

interface RenderedSkill {
  id: string;
  files: RenderedFile[];
  rejected: RejectedPath[];
}

function partitionSkill(row: BundleSkill, rendered: RenderTree): { skip: SkippedEntry } | { export: RenderedSkill } {
  if (!rendered.ok) return { skip: { skill: row.skill.id, reason: rendered.reason } };
  const doc = rendered.files.find((file) => file.path.endsWith("/SKILL.md"));
  if (!doc || !isSafeArchivePath(doc.path)) return { skip: { skill: row.skill.id, reason: "unsafe skill path" } };
  if (!ustarSplit(doc.path)) return { skip: { skill: row.skill.id, reason: "path exceeds archive limit" } };
  const files = [doc];
  const rejected = [...rendered.rejected];
  for (const file of rendered.files) {
    if (file === doc) continue;
    if (file.path === doc.path || files.some((kept) => kept.path === file.path)) {
      rejected.push({ path: file.path, reason: "duplicate reference path" });
      continue;
    }
    if (!isSafeArchivePath(file.path)) {
      rejected.push({ path: file.path, reason: "unsafe reference" });
      continue;
    }
    if (!ustarSplit(file.path)) {
      rejected.push({ path: file.path, reason: "path exceeds archive limit" });
      continue;
    }
    files.push(file);
  }
  return { export: { id: row.skill.id, files, rejected } };
}

export function buildBundle(skills: BundleSkill[], filter: ExportFilter): BuiltBundle {
  const skipped: SkippedEntry[] = [];
  const eligible: BundleSkill[] = [];
  for (const row of skills) {
    if (row.triggerInvalid === true || !isTrigger(row.trigger)) {
      if (reportableInvalidTrigger(row, filter)) {
        skipped.push({ skill: row.skill.id, reason: "invalid trigger" });
      }
      continue;
    }
    eligible.push(row);
  }
  const renderedSkills: RenderedSkill[] = [];
  for (const row of visibleForExport(eligible, filter)) {
    const part = partitionSkill(row, renderSkillTree(filter.runtime, row.skill));
    if ("skip" in part) {
      skipped.push(part.skip);
      continue;
    }
    renderedSkills.push(part.export);
  }
  const colliding = duplicateSkillIndexes(renderedSkills);
  const files: RenderedFile[] = [];
  renderedSkills.forEach((row, index) => {
    if (colliding.has(index)) {
      skipped.push({ skill: row.id, reason: "duplicate archive path" });
      return;
    }
    files.push(...row.files);
    for (const rejected of row.rejected) {
      skipped.push({ skill: row.id, path: rejected.path, reason: rejected.reason });
    }
  });
  return { files: uniqueArchiveFiles(files), skipped };
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

/** The collision pass already removed shared paths. A repeat here is a bug, so it throws instead of dropping a file. */
function uniqueArchiveFiles(files: RenderedFile[]): RenderedFile[] {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`archive path repeated after skip reporting: ${file.path}`);
    seen.add(file.path);
  }
  return files;
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

/**
 * Response header for the skip list. Empty is `[]`.
 * Otherwise `count`, the first 20 entries, and `see manifest.json`,
 * shortened from the end until the UTF-8 value is at most 4 KB.
 * The full list stays in manifest.json.
 */
export function skippedHeader(skipped: SkippedEntry[]): string {
  if (skipped.length === 0) return "[]";
  const count = skipped.length;
  const note = "see manifest.json";
  let take = Math.min(SKIPPED_HEADER_MAX_ENTRIES, skipped.length);
  while (take > 0) {
    const body = JSON.stringify({ count, skipped: skipped.slice(0, take), note });
    if (Buffer.byteLength(body, "utf8") <= SKIPPED_HEADER_MAX_BYTES) return body;
    take -= 1;
  }
  return JSON.stringify({ count, skipped: [], note });
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
    return { ok: false, message: runtimeMustBeMessage(), field: "runtime" };
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
        triggerInvalid: setting?.triggerInvalid === true,
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
