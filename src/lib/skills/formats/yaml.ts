/**
 * YAML for the frontmatter subset the skill parser can read back.
 * Strings that would change type (true, null, numbers) are quoted.
 */

const KEY = /^[A-Za-z0-9_-]+$/;

export function emitFrontmatter(data: Record<string, unknown>): string | null {
  const body = emitMap(data, 0);
  if (body == null) return null;
  return body;
}

function emitMap(data: Record<string, unknown>, indent: number): string | null {
  const lines: string[] = [];
  const pad = " ".repeat(indent);
  for (const [key, value] of Object.entries(data)) {
    if (!KEY.test(key)) return null;
    if (value === undefined) continue;
    const rendered = emitValue(value, indent);
    if (rendered == null) return null;
    if (rendered.kind === "block") {
      lines.push(`${pad}${key}: ${rendered.header}`);
      for (const line of rendered.lines) lines.push(line);
    } else if (rendered.kind === "nested") {
      lines.push(`${pad}${key}:`);
      lines.push(rendered.text);
    } else {
      lines.push(`${pad}${key}: ${rendered.text}`);
    }
  }
  return lines.join("\n");
}

type Emitted =
  | { kind: "inline"; text: string }
  | { kind: "nested"; text: string }
  | { kind: "block"; header: string; lines: string[] };

function emitValue(value: unknown, indent: number): Emitted | null {
  if (typeof value === "string" && value.includes("\n")) {
    const lines = value.replace(/\n$/, "").split("\n").map((line) => `${" ".repeat(indent + 2)}${line}`);
    return { kind: "block", header: "|", lines };
  }
  const scalar = emitScalar(value);
  if (scalar != null) return { kind: "inline", text: scalar };
  if (Array.isArray(value)) {
    const list = emitList(value, indent);
    if (list == null) return null;
    return list;
  }
  if (value && typeof value === "object") {
    const nested = emitMap(value as Record<string, unknown>, indent + 2);
    if (nested == null) return null;
    if (!nested) return { kind: "inline", text: '""' };
    return { kind: "nested", text: nested };
  }
  return null;
}

function emitList(value: unknown[], indent: number): Emitted | null {
  const items: string[] = [];
  for (const item of value) {
    const scalar = emitScalar(item);
    if (scalar == null) return null;
    items.push(scalar);
  }
  if (items.every((item) => item.length < 40) && items.join(", ").length < 120) {
    return { kind: "inline", text: `[${items.join(", ")}]` };
  }
  const lines = items.map((item) => `${" ".repeat(indent + 2)}- ${item}`);
  return { kind: "block", header: "", lines };
}

function emitScalar(value: unknown): string | null {
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === null) return "null";
  return null;
}

function quoteString(value: string): string {
  if (value === "") return '""';
  if (/^(true|false|null|~)$/.test(value) || /^-?[0-9]+(\.[0-9]+)?$/.test(value)) {
    return JSON.stringify(value);
  }
  if (/[:#&*!|>%@`,\[\]{}'"\\]/.test(value) || /^\s|\s$/.test(value) || value.includes("\n")) {
    return JSON.stringify(value);
  }
  return value;
}

export function stringList(value: unknown): string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

export function asMap(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
