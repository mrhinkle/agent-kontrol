import type { RejectedPath, RenderTree } from "./types";

/**
 * Archive paths are relative, one segment at a time.
 * `..`, absolute paths, and control characters are rejected, not rewritten
 * into a path that still escapes the tree.
 */

const CONTROL = /[\u0000-\u001f\u007f]/;
const ENCODED_TRAVERSAL = /%(?:2e|2f|5c)/i;
const DRIVE = /^[A-Za-z]:/;
const SEGMENT_MAX = 80;

/** ustar header: name is 100 bytes, prefix is 155. */
export const USTAR_NAME_MAX = 100;
export const USTAR_PREFIX_MAX = 155;

export function isSafeArchivePath(value: string): boolean {
  if (!value || CONTROL.test(value) || ENCODED_TRAVERSAL.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || DRIVE.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (value.includes("..")) return false;
  return true;
}

/**
 * Split a safe archive path into the ustar name and prefix fields.
 * Returns null when the path is unsafe or longer than those fields.
 * A caller that already knows the path is safe treats null as "cannot represent".
 */
export function ustarSplit(path: string): { name: string; prefix: string } | null {
  if (!isSafeArchivePath(path)) return null;
  if (Buffer.byteLength(path) <= USTAR_NAME_MAX) return { name: path, prefix: "" };
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return null;
  const name = path.slice(slash + 1);
  const prefix = path.slice(0, slash);
  if (Buffer.byteLength(name) > USTAR_NAME_MAX || Buffer.byteLength(prefix) > USTAR_PREFIX_MAX) return null;
  if (!isSafeArchivePath(name) || !isSafeArchivePath(prefix)) return null;
  return { name, prefix };
}

/**
 * One reference-file segment. This rewrites case and punctuation so a
 * reference can keep a readable path. Do not use it for a category or a
 * skill directory: those must already match `exactFolderSegment`.
 * Returns null when the segment is empty, too long, or a traversal.
 */
export function safeSegment(raw: string, allowDot: boolean): string | null {
  if (typeof raw !== "string") return null;
  if (CONTROL.test(raw) || ENCODED_TRAVERSAL.test(raw)) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("..")) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || DRIVE.test(trimmed)) return null;
  const mapped = allowDot ? trimmed : trimmed.replace(/\./g, "-");
  const slug = mapped
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!slug || slug.includes("..") || slug.startsWith(".") || slug.length > SEGMENT_MAX) return null;
  const pattern = allowDot ? /^[a-z0-9][a-z0-9._-]*$/ : /^[a-z0-9][a-z0-9_-]*$/;
  if (!pattern.test(slug)) return null;
  return slug;
}

/**
 * A category or skill directory that is already safe.
 * The pattern is the whole string: no lowercasing, no punctuation rewrite.
 * A value outside the set is omitted from the archive.
 */
const EXACT_FOLDER = /^[a-z0-9][a-z0-9-_]*$/;

export function exactFolderSegment(raw: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > SEGMENT_MAX) return null;
  if (!EXACT_FOLDER.test(raw)) return null;
  return raw;
}

/**
 * Category folder. Null or blank is "uncategorized".
 * Any other value is kept only when it already matches the safe set.
 */
export function categoryFolder(category: string | null | undefined): { ok: true; folder: string } | { ok: false; reason: string } {
  if (category == null) return { ok: true, folder: "uncategorized" };
  if (category.trim() === "") return { ok: true, folder: "uncategorized" };
  const folder = exactFolderSegment(category);
  if (!folder) return { ok: false, reason: "unsafe category" };
  return { ok: true, folder };
}

/**
 * Skill directory segment.
 * The store id is that name: assemble.ts copies it from the upstream
 * directory slug, and the frontmatter `name` is only the display string.
 * Those fields may differ. The archive uses `id`, unchanged.
 */
export function skillFolder(id: string): string | null {
  return exactFolderSegment(id);
}

/**
 * A reference path inside the skill directory.
 * Null rejects the file. The caller must not write it.
 */
export function safeReferencePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  if (!raw.trim() || CONTROL.test(raw) || ENCODED_TRAVERSAL.test(raw)) return null;
  if (raw.startsWith("/") || raw.startsWith("\\") || raw.startsWith("//") || DRIVE.test(raw)) return null;
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  const safe: string[] = [];
  for (const part of parts) {
    if (part.includes("..")) return null;
    const segment = safeSegment(part, true);
    if (!segment) return null;
    safe.push(segment);
  }
  if (safe.length === 0) return null;
  const joined = safe.join("/");
  if (joined === "skill.md" || joined.endsWith("/skill.md")) return null;
  if (!isSafeArchivePath(joined)) return null;
  return joined;
}

export function joinArchive(dir: string, name: string): string | null {
  if (!isSafeArchivePath(dir)) return null;
  const full = `${dir}/${name}`;
  return isSafeArchivePath(full) ? full : null;
}

function placeSkillDocument(dir: string): { ok: true; path: string } | { ok: false; reason: string } {
  const full = joinArchive(dir, "SKILL.md");
  if (!full) return { ok: false, reason: "unsafe skill path" };
  if (!ustarSplit(full)) return { ok: false, reason: "path exceeds archive limit" };
  return { ok: true, path: full };
}

function placeReference(
  dir: string,
  raw: string,
  used: Set<string>,
): { ok: true; path: string } | { ok: false; path: string; reason: string } {
  const relative = safeReferencePath(raw);
  if (!relative) return { ok: false, path: raw, reason: "unsafe reference" };
  if (used.has(relative)) return { ok: false, path: raw, reason: "duplicate reference path" };
  const full = joinArchive(dir, relative);
  if (!full) return { ok: false, path: raw, reason: "unsafe reference" };
  if (!ustarSplit(full)) return { ok: false, path: raw, reason: "path exceeds archive limit" };
  used.add(relative);
  return { ok: true, path: full };
}

/**
 * Write SKILL.md and the references that fit under it.
 * A reference that is unsafe, collides (the stored path is lowercased), or
 * exceeds the ustar name/prefix limit is listed in `rejected`. The skill
 * document is still returned. A SKILL.md that cannot be written fails the tree.
 */
export function attachReferences(
  dir: string,
  document: string,
  references: { path: string; content: string }[],
): RenderTree {
  const placed = placeSkillDocument(dir);
  if (!placed.ok) return { ok: false, reason: placed.reason };
  const files = [{ path: placed.path, content: document }];
  const rejected: RejectedPath[] = [];
  const used = new Set<string>();
  for (const ref of references) {
    const next = placeReference(dir, ref.path, used);
    if (!next.ok) {
      rejected.push({ path: next.path, reason: next.reason });
      continue;
    }
    files.push({ path: next.path, content: ref.content });
  }
  return { ok: true, files, rejected };
}
