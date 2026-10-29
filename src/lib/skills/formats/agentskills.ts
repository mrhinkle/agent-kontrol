import { joinArchive, safeReferencePath, skillFolder } from "./paths";
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
  const name = skillFolder(skill.id);
  if (!name) return { ok: false, reason: "unsafe skill name" };
  const dir = `.agents/skills/${name}`;
  const document = renderAgentSkillsDocument(skill);
  if (document == null) return { ok: false, reason: "frontmatter could not be rendered" };
  return finishTree(dir, document, skill);
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

function finishTree(dir: string, document: string, skill: FormatSkill): RenderTree {
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
