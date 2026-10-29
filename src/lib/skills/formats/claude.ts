import { attachReferences, skillFolder } from "./paths";
import type { FormatSkill, RenderTree } from "./types";
import { emitFrontmatter } from "./yaml";

/**
 * Claude passthrough. The MCP text stays the stored body.
 * A file export writes the stored frontmatter back, then the body.
 * It does not add Hermes keys.
 */

export function renderClaudeDocument(skill: FormatSkill): string {
  return skill.body;
}

export function renderClaudeTree(skill: FormatSkill): RenderTree {
  // Directory is the skill id. `skill.name` is the display string.
  const name = skillFolder(skill.id);
  if (!name) return { ok: false, reason: "unsafe skill name" };
  const dir = `skills/${name}`;
  const data = claudeFrontmatter(skill);
  const yaml = emitFrontmatter(data);
  if (yaml == null) return { ok: false, reason: "frontmatter could not be rendered" };
  const document = `---\n${yaml}\n---\n${skill.body}`;
  return attachReferences(dir, document, skill.references);
}

function claudeFrontmatter(skill: FormatSkill): Record<string, unknown> {
  const stored = skill.frontmatter;
  if (Object.keys(stored).length > 0) return stored;
  const data: Record<string, unknown> = {};
  if (skill.name) data.name = skill.name;
  data.description = skill.description;
  return data;
}
