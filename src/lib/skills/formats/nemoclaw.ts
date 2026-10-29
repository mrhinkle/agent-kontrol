import { parseSkillMarkdown } from "../parse";
import { skillSha } from "../sha";
import { attachReferences, skillFolder } from "./paths";
import type { FormatSkill, RenderTree } from "./types";
import { asMap, emitFrontmatter, scalarString, stringList } from "./yaml";

/**
 * NemoClaw skills live at .agents/skills/<name>/SKILL.md, the Agent Skills
 * directory from agentskills.ts, with references beside SKILL.md.
 * Frontmatter confirmed from NVIDIA/NemoClaw at 7ced2348dbef, plus the
 * metadata block NVIDIA/NemoClaw#4455 added for the NVSkills validator:
 * name, description, and, only when the file already has them, license,
 * user_invocable, metadata.author, and metadata.tags.
 * Store tags are not copied into metadata.tags. A missing key is omitted.
 */

export interface NemoClawKnown {
  name: string;
  description: string;
  license: string | null;
  /** Null when the file has no user_invocable key. False is kept. */
  userInvocable: boolean | null;
  author: string | null;
  /** Null when metadata.tags is absent. An empty list is a present key. */
  tags: string[] | null;
  body: string;
}

export function storedFromNemoClawMarkdown(input: {
  raw: string;
  id: string;
  references?: { path: string; content: string }[];
}): { ok: true; skill: FormatSkill } | { ok: false; reason: string } {
  const parsed = parseSkillMarkdown(input.raw, input.id);
  if (parsed.parseProblem) return { ok: false, reason: parsed.parseProblem };
  return {
    ok: true,
    skill: {
      id: input.id,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      sha: skillSha(input.raw),
      body: parsed.body,
      category: parsed.category,
      tags: parsed.tags,
      references: input.references ?? [],
      frontmatter: parsed.frontmatter,
    },
  };
}

export function nemoclawKnown(skill: FormatSkill): NemoClawKnown {
  const frontmatter = skill.frontmatter;
  const metadata = metadataFields(frontmatter);
  return {
    name: skill.name,
    description: skill.description,
    license: scalarString(frontmatter.license),
    userInvocable: booleanValue(frontmatter, "user_invocable"),
    author: metadata.author,
    tags: metadata.tags,
    body: skill.body,
  };
}

export function renderNemoClawDocument(skill: FormatSkill): string | null {
  const known = nemoclawKnown(skill);
  const data: Record<string, unknown> = {};
  if (known.name) data.name = known.name;
  data.description = known.description;
  if (known.license) data.license = known.license;
  if (known.userInvocable !== null) data.user_invocable = known.userInvocable;
  const metadata: Record<string, unknown> = {};
  if (known.author) metadata.author = known.author;
  if (known.tags) metadata.tags = known.tags;
  if (Object.keys(metadata).length > 0) data.metadata = metadata;
  const yaml = emitFrontmatter(data);
  if (yaml == null) return null;
  return `---\n${yaml}\n---\n${known.body}`;
}

export function renderNemoClawTree(skill: FormatSkill): RenderTree {
  // Same directory rule as Codex and Grok. Category is not a path segment.
  const name = skillFolder(skill.id);
  if (!name) return { ok: false, reason: "unsafe skill name" };
  const dir = `.agents/skills/${name}`;
  const document = renderNemoClawDocument(skill);
  if (document == null) return { ok: false, reason: "frontmatter could not be rendered" };
  return attachReferences(dir, document, skill.references);
}

function booleanValue(frontmatter: Record<string, unknown>, key: string): boolean | null {
  if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) return null;
  const value = frontmatter[key];
  return typeof value === "boolean" ? value : null;
}

function metadataFields(frontmatter: Record<string, unknown>): { author: string | null; tags: string[] | null } {
  const metadata = asMap(frontmatter.metadata);
  if (!metadata) return { author: null, tags: null };
  const author = Object.prototype.hasOwnProperty.call(metadata, "author") ? scalarString(metadata.author) : null;
  if (!Object.prototype.hasOwnProperty.call(metadata, "tags")) return { author, tags: null };
  const tags = stringList(metadata.tags);
  return { author, tags: tags ?? [] };
}
