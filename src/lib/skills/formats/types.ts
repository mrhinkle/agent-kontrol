/**
 * One stored skill, as the format adapters see it.
 * `category` is the store column (Hermes uses it as the folder).
 * `tags` is the store column (Hermes writes it to metadata.hermes.tags).
 * `frontmatter` is the parsed SKILL.md map. Adapters read known keys from it
 * and do not invent keys the file did not have.
 */

export interface FormatSkill {
  /**
   * Canonical directory name. This is the upstream directory slug.
   * `name` is the frontmatter display string and may differ.
   */
  id: string;
  name: string;
  description: string;
  /** Frontmatter version. Null when the file did not declare one. */
  version: string | null;
  /** Content SHA-256 of the synced SKILL.md bytes. */
  sha: string;
  body: string;
  category: string | null;
  tags: string[];
  references: { path: string; content: string }[];
  frontmatter: Record<string, unknown>;
}

export interface RenderedFile {
  path: string;
  content: string;
}

export type RenderTree =
  | { ok: true; files: RenderedFile[]; rejected: string[] }
  | { ok: false; reason: string };

export type SkillFormatId = "claude" | "agentskills" | "hermes";
