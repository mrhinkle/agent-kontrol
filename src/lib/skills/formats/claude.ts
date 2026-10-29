import { joinArchive, safeReferencePath, skillFolder } from "./paths";
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
  const name = skillFolder(skill.id);
  if (!name) return { ok: false, reason: "unsafe skill name" };
  const dir = `skills/${name}`;
  const data = claudeFrontmatter(skill);
  const yaml = emitFrontmatter(data);
  if (yaml == null) return { ok: false, reason: "frontmatter could not be rendered" };
  const document = `---\n${yaml}\n---\n${skill.body}`;
  const skillPath = joinArchive(dir, "SKILL.md");
  if (!skillPath) return { ok: false, reason: "unsafe skill path" };
  const files = [{ path: skillPath, content: document }];
  const rejected: string[] = [];
  const used = new Set<string>(["SKILL.md"]);
  for (const ref of skill.references) {
    const relative = safeReferencePath(ref.path);
    if (!relative || used.has(relative)) {
      rejected.push(ref.path);
      continue;
    }
    const full = joinArchive(dir, relative);
    if (!full) {
      rejected.push(ref.path);
      continue;
    }
    used.add(relative);
    files.push({ path: full, content: ref.content });
  }
  return { ok: true, files, rejected };
}

function claudeFrontmatter(skill: FormatSkill): Record<string, unknown> {
  const stored = skill.frontmatter;
  if (Object.keys(stored).length > 0) return stored;
  const data: Record<string, unknown> = {};
  if (skill.name) data.name = skill.name;
  data.description = skill.description;
  return data;
}
