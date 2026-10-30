import { attachReferences, skillFolder } from "./paths";
import type { FormatSkill, RenderTree } from "./types";
import { asMap, emitFrontmatter, scalarString, stringList } from "./yaml";

/**
 * Shared SKILL.md for Codex and Grok (.agents/skills/<name>/SKILL.md).
 * Writes name and description, plus license, compatibility, metadata, and
 * allowed-tools only when the stored frontmatter already has them.
 */

export function renderAgentSkillsDocument(skill: FormatSkill): string | null {
  const data: Record<string, unknown> = {};
  if (skill.name) data.name = skill.name;
  data.description = skill.description;
  const frontmatter = skill.frontmatter;
  const license = scalarString(frontmatter.license);
  if (license) data.license = license;
  const compatibility = scalarString(frontmatter.compatibility);
  if (compatibility) data.compatibility = compatibility;
  const metadata = stringMetadata(frontmatter.metadata);
  if (metadata) data.metadata = metadata;
  if (Object.prototype.hasOwnProperty.call(frontmatter, "allowed-tools")) {
    const tools = frontmatter["allowed-tools"];
    if (typeof tools === "string") data["allowed-tools"] = tools;
    else {
      const list = stringList(tools);
      if (list) data["allowed-tools"] = list;
    }
  }
  const yaml = emitFrontmatter(data);
  if (yaml == null) return null;
  return `---\n${yaml}\n---\n${skill.body}`;
}

export function renderAgentSkillsTree(skill: FormatSkill): RenderTree {
  // Directory is the skill id. `skill.name` is the display string.
  const name = skillFolder(skill.id);
  if (!name) return { ok: false, reason: "unsafe skill name" };
  const dir = `.agents/skills/${name}`;
  const document = renderAgentSkillsDocument(skill);
  if (document == null) return { ok: false, reason: "frontmatter could not be rendered" };
  return attachReferences(dir, document, skill.references);
}

function stringMetadata(value: unknown): Record<string, string> | null {
  const map = asMap(value);
  if (!map) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(map)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : null;
}
