import { parseSkillMarkdown, skillSlug } from "./parse";
import { resolveRuntimes } from "./runtimes";
import { skillSha } from "./sha";
import { parentDir } from "./source";
import type { RuntimeFlags, SkillReference } from "./types";

export const REFERENCE_TOTAL_MAX_BYTES = 1024 * 1024;
export const REFERENCE_FILE_MAX_BYTES = 256 * 1024;

export interface AssembledSkill {
  id: string;
  source_id: string;
  position: number;
  path: string;
  name: string;
  description: string;
  version: string | null;
  sha: string;
  body: string;
  references: SkillReference[];
  runtimes: RuntimeFlags;
  category: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  problems: string[];
}

export interface PreservedSkill {
  id: string;
  source_id: string;
  position: number;
  path: string;
}

export interface AssembleResult {
  skills: AssembledSkill[];
  preserved: PreservedSkill[];
  /** Could not evaluate a file. The sync is failed. */
  errors: { path: string; message: string }[];
  /** Recorded and not a failure: an ignored runtime name, a skipped reference. */
  notices: { path: string; message: string }[];
}

interface InputFile {
  path: string;
  content: string;
}

/**
 * Turn a snapshot's files into skill rows.
 * A SKILL.md that is present but unreadable is preserved, not removed.
 * A SKILL.md whose frontmatter cannot be parsed is not a row: an existing
 * skill stays, and a new one is not stored. The error is on `errors`.
 * Binary files and files over the reference cap are skipped.
 */
export function assembleSkills(input: {
  source_id: string;
  position: number;
  globs: string[];
  files: InputFile[];
  preservedDirs?: string[];
}): AssembleResult {
  const errors: { path: string; message: string }[] = [];
  const notices: { path: string; message: string }[] = [];
  const byDir = new Map<string, InputFile[]>();
  for (const file of input.files) {
    const dir = file.path.endsWith("/SKILL.md") ? parentDir(file.path) : directoryOf(file.path, input.globs);
    if (!dir) continue;
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }

  const skills: AssembledSkill[] = [];
  const preserved: PreservedSkill[] = [];
  for (const dir of input.preservedDirs ?? []) {
    const id = skillSlug(null, dir.slice(dir.lastIndexOf("/") + 1));
    if (!id) {
      errors.push({ path: dir, message: "skill directory name is not a slug; existing row kept if one matches this path" });
      continue;
    }
    preserved.push({ id, source_id: input.source_id, position: input.position, path: dir });
    errors.push({ path: `${dir}/SKILL.md`, message: "SKILL.md could not be read; existing row kept" });
  }

  for (const [dir, files] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const skillFile = files.find((file) => file.path === `${dir}/SKILL.md`);
    if (!skillFile) continue;
    const directoryName = dir.slice(dir.lastIndexOf("/") + 1);
    const parsed = parseSkillMarkdown(skillFile.content, directoryName);
    // The id is the directory slug. The frontmatter name is the display name.
    const id = skillSlug(null, directoryName);
    if (!id) {
      preserved.push({ id: directoryName, source_id: input.source_id, position: input.position, path: dir });
      errors.push({ path: skillFile.path, message: "skill id is not a slug; existing row kept" });
      continue;
    }
    if (parsed.parseProblem) {
      preserved.push({ id, source_id: input.source_id, position: input.position, path: dir });
      errors.push({ path: skillFile.path, message: parsed.parseProblem });
      continue;
    }
    const sibling = readSibling(files, dir);
    const decision = resolveRuntimes({
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      sibling: sibling.value,
      siblingProblem: sibling.problem,
      parseProblem: parsed.parseProblem,
    });
    const problems = decision.problem ? [decision.problem] : [];
    const skipped: string[] = [];
    const references = collectReferences(files, dir, skipped);
    for (const message of skipped) notices.push({ path: skillFile.path, message });
    skills.push({
      id,
      source_id: input.source_id,
      position: input.position,
      path: `${dir}/SKILL.md`,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      sha: skillSha(skillFile.content),
      body: parsed.body,
      references,
      runtimes: decision.flags,
      category: parsed.category,
      tags: parsed.tags,
      frontmatter: parsed.frontmatter,
      problems,
    });
    if (decision.unknown.length > 0) {
      notices.push({
        path: skillFile.path,
        message: `ignored unknown runtimes: ${decision.unknown.join(", ")}`,
      });
    }
  }
  return { skills, preserved, errors, notices };
}

function directoryOf(path: string, globs: string[]): string | null {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join("/");
    if (globs.some((glob) => matches(dir, glob)) && path.startsWith(`${dir}/`)) return dir;
  }
  return null;
}

function matches(path: string, glob: string): boolean {
  const parts = glob.split("/").map((part) => (part === "*" ? "[^/]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")));
  return new RegExp(`^${parts.join("/")}$`).test(path);
}

function readSibling(files: InputFile[], dir: string): { value: Record<string, unknown> | null; problem: string | null } {
  const file = files.find((item) => item.path === `${dir}/skill.json` || item.path === `${dir}/manifest.json`);
  if (!file) return { value: null, problem: null };
  try {
    const parsed = JSON.parse(file.content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, problem: `${file.path} is not a JSON object` };
    }
    return { value: parsed as Record<string, unknown>, problem: null };
  } catch {
    return { value: null, problem: `${file.path} is not valid JSON` };
  }
}

function collectReferences(files: InputFile[], dir: string, skipped: string[]): SkillReference[] {
  const refs: SkillReference[] = [];
  let total = 0;
  const sorted = files
    .filter((file) => file.path !== `${dir}/SKILL.md` && file.path.startsWith(`${dir}/`))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    const rel = file.path.slice(dir.length + 1);
    if (rel.includes("..") || rel.startsWith("/")) continue;
    const bytes = Buffer.byteLength(file.content);
    if (bytes > REFERENCE_FILE_MAX_BYTES) {
      skipped.push(`skipped reference ${rel}: over 256 KB`);
      continue;
    }
    if (total + bytes > REFERENCE_TOTAL_MAX_BYTES) {
      skipped.push(`skipped reference ${rel}: over 1 MB total`);
      continue;
    }
    total += bytes;
    refs.push({ path: rel, content: file.content });
  }
  return refs;
}
