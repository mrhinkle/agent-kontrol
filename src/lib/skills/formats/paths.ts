/**
 * Archive paths are relative, one segment at a time.
 * `..`, absolute paths, and control characters are rejected, not rewritten
 * into a path that still escapes the tree.
 */

const CONTROL = /[\u0000-\u001f\u007f]/;
const ENCODED_TRAVERSAL = /%(?:2e|2f|5c)/i;
const DRIVE = /^[A-Za-z]:/;
const SEGMENT_MAX = 80;

export function isSafeArchivePath(value: string): boolean {
  if (!value || CONTROL.test(value) || ENCODED_TRAVERSAL.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || DRIVE.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (value.includes("..")) return false;
  return true;
}

/**
 * One path segment restricted to [a-z0-9-_], or [a-z0-9._-] when `allowDot`
 * is set so a reference can keep its extension. `..` is still rejected.
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

/** Category or skill folder. A blank value is "no category", not a traversal. */
export function categoryFolder(category: string | null | undefined): { ok: true; folder: string } | { ok: false; reason: string } {
  if (category == null) return { ok: true, folder: "uncategorized" };
  const trimmed = category.trim();
  if (!trimmed) return { ok: true, folder: "uncategorized" };
  const folder = safeSegment(trimmed, false);
  if (!folder) return { ok: false, reason: "unsafe category" };
  return { ok: true, folder };
}

export function skillFolder(id: string): string | null {
  return safeSegment(id, false);
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
