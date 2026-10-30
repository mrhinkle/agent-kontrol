import { parseSkillMarkdown } from "../parse";
import { skillSha } from "../sha";
import { attachReferences, categoryFolder, skillFolder } from "./paths";
import type { FormatSkill, RenderTree } from "./types";
import { asMap, emitFrontmatter, scalarString, stringList } from "./yaml";

/**
 * Hermes skills live at ~/.hermes/skills/<category>/<name>/SKILL.md.
 * Known frontmatter, taken from skills on the Mini (2026-10-28): name,
 * description, version, author, license, platforms, metadata.hermes.tags,
 * metadata.hermes.related_skills, prerequisites.
 * Anything else is omitted. Missing keys are not invented.
 */

export interface HermesKnown {
  name: string;
  description: string;
  version: string | null;
  author: string | null;
  license: string | null;
  platforms: string[] | null;
  tags: string[];
  relatedSkills: string[] | null;
  prerequisites: Record<string, unknown> | null;
  body: string;
}

export function storedFromHermesMarkdown(input: {
  raw: string;
  /** Folder the file was read from. Hermes does not store category in frontmatter. */
  category: string | null;
  id: string;
  references?: { path: string; content: string }[];
}): { ok: true; skill: FormatSkill } | { ok: false; reason: string } {
  const parsed = parseSkillMarkdown(input.raw, input.id);
  if (parsed.parseProblem) return { ok: false, reason: parsed.parseProblem };
  const folder = input.category?.trim() ? input.category.trim() : null;
  return {
    ok: true,
    skill: {
      id: input.id,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      sha: skillSha(input.raw),
      body: parsed.body,
      category: folder,
      tags: tagsFromParsed(parsed.frontmatter, parsed.tags),
      references: input.references ?? [],
      frontmatter: parsed.frontmatter,
    },
  };
}

/** metadata.hermes.tags wins. A top-level tags list is the fallback. */
export function tagsFromParsed(frontmatter: Record<string, unknown>, topLevel: string[]): string[] {
  const hermes = hermesBlock(frontmatter);
  if (hermes && Object.prototype.hasOwnProperty.call(hermes, "tags")) {
    return stringList(hermes.tags) ?? [];
  }
  return topLevel;
}

export function hermesKnown(skill: FormatSkill): HermesKnown {
  const frontmatter = skill.frontmatter;
  return {
    name: skill.name,
    description: skill.description,
    version: hermesVersion(skill),
    author: scalarString(frontmatter.author),
    license: scalarString(frontmatter.license),
    platforms: Object.prototype.hasOwnProperty.call(frontmatter, "platforms") ? stringList(frontmatter.platforms) : null,
    tags: skill.tags.map((tag) => tag.trim()).filter(Boolean),
    relatedSkills: relatedSkills(frontmatter),
    prerequisites: prerequisites(frontmatter),
    body: skill.body,
  };
}

export function hermesVersion(skill: FormatSkill): string | null {
  const version = skill.version?.trim();
  if (version) return version;
  const sha = skill.sha.trim();
  return sha || null;
}

export function renderHermesDocument(skill: FormatSkill): string | null {
  const known = hermesKnown(skill);
  const data: Record<string, unknown> = {};
  if (known.name) data.name = known.name;
  data.description = known.description;
  if (known.version) data.version = known.version;
  if (known.author) data.author = known.author;
  if (known.license) data.license = known.license;
  if (known.platforms) data.platforms = known.platforms;
  const hermes: Record<string, unknown> = {};
  if (known.tags.length > 0) hermes.tags = known.tags;
  if (known.relatedSkills) hermes.related_skills = known.relatedSkills;
  if (Object.keys(hermes).length > 0) data.metadata = { hermes };
  if (known.prerequisites) data.prerequisites = known.prerequisites;
  const yaml = emitFrontmatter(data);
  if (yaml == null) return null;
  return `---\n${yaml}\n---\n${known.body}`;
}

export function renderHermesTree(skill: FormatSkill): RenderTree {
  const folder = categoryFolder(skill.category);
  if (!folder.ok) return { ok: false, reason: folder.reason };
  // Directory is the skill id (the upstream slug). `skill.name` is display text.
  const name = skillFolder(skill.id);
  if (!name) return { ok: false, reason: "unsafe skill name" };
  const dir = `${folder.folder}/${name}`;
  const document = renderHermesDocument(skill);
  if (document == null) return { ok: false, reason: "frontmatter could not be rendered" };
  return attachReferences(dir, document, skill.references);
}

function hermesBlock(frontmatter: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = asMap(frontmatter.metadata);
  if (!metadata) return null;
  return asMap(metadata.hermes);
}

function relatedSkills(frontmatter: Record<string, unknown>): string[] | null {
  const hermes = hermesBlock(frontmatter);
  if (!hermes || !Object.prototype.hasOwnProperty.call(hermes, "related_skills")) return null;
  return stringList(hermes.related_skills) ?? [];
}

function prerequisites(frontmatter: Record<string, unknown>): Record<string, unknown> | null {
  if (!Object.prototype.hasOwnProperty.call(frontmatter, "prerequisites")) return null;
  const value = frontmatter.prerequisites;
  const map = asMap(value);
  if (!map) return null;
  if (Object.keys(map).length === 0) return null;
  return map;
}
