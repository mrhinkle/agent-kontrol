/**
 * Minimal YAML frontmatter for SKILL.md. No extra dependency.
 * Unsupported constructs (tabs, anchors, flow maps) are a parse problem.
 * A parse problem never means the skill is compatible with every runtime.
 */

export interface ParsedSkillFile {
  name: string;
  description: string;
  version: string | null;
  /** Trimmed frontmatter `category`. Absent, blank, or not a single string is null. */
  category: string | null;
  /** Trimmed frontmatter `tags`. A scalar string is a one-element list. Absent, blank, or any other shape is []. */
  tags: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  /** Set when the frontmatter could not be read. The body may still be present. */
  parseProblem: string | null;
}

const NO_LABELS = { category: null, tags: [] as string[] };

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function skillSlug(name: string | null, directoryName: string): string | null {
  if (name && SLUG.test(name)) return name;
  if (SLUG.test(directoryName)) return directoryName;
  return null;
}

export function parseSkillMarkdown(raw: string, directoryName: string): ParsedSkillFile {
  const split = splitFrontmatter(raw);
  if (split.error) {
    return {
      name: directoryName,
      description: "",
      version: null,
      ...NO_LABELS,
      frontmatter: {},
      body: split.body,
      parseProblem: split.error,
    };
  }
  if (split.frontmatterText == null) {
    return {
      name: directoryName,
      description: "",
      version: null,
      ...NO_LABELS,
      frontmatter: {},
      body: split.body,
      parseProblem: null,
    };
  }
  const parsed = parseYamlMap(split.frontmatterText);
  if (!parsed.ok) {
    return {
      name: directoryName,
      description: "",
      version: null,
      ...NO_LABELS,
      frontmatter: {},
      body: split.body,
      parseProblem: parsed.error,
    };
  }
  const display = typeof parsed.data.name === "string" && parsed.data.name.trim() ? parsed.data.name.trim() : directoryName;
  const labels = labelsFromFrontmatter(parsed.data);
  return {
    name: display,
    description: typeof parsed.data.description === "string" ? parsed.data.description : "",
    version: versionFrom(parsed.data),
    category: labels.category,
    tags: labels.tags,
    frontmatter: parsed.data,
    body: split.body,
    parseProblem: null,
  };
}

/**
 * `category` is one trimmed string. `tags` is a list of trimmed strings.
 * A scalar string tag is kept as a one-element list. Absent, blank, or any
 * other shape is []. The master-skills taxonomy is not checked: any declared
 * string is stored. A value that is not that shape is ignored, and the rest
 * of the file still parses.
 */
export function labelsFromFrontmatter(data: Record<string, unknown>): { category: string | null; tags: string[] } {
  return {
    category: categoryFrom(data.category),
    tags: tagsFrom(data.tags),
  };
}

function categoryFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function tagsFrom(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const tags: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) tags.push(trimmed);
  }
  return tags;
}

function versionFrom(data: Record<string, unknown>): string | null {
  const direct = scalarString(data.version);
  if (direct) return direct;
  const meta = data.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return scalarString((meta as Record<string, unknown>).version);
  }
  return null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function splitFrontmatter(raw: string): { frontmatterText: string | null; body: string; error: string | null } {
  if (!raw.startsWith("---")) return { frontmatterText: null, body: raw, error: null };
  const nl = raw.indexOf("\n");
  if (nl < 0) return { frontmatterText: null, body: raw, error: "unclosed frontmatter" };
  const opener = raw.slice(0, nl).replace(/\r$/, "").trim();
  if (opener !== "---") return { frontmatterText: null, body: raw, error: "malformed frontmatter opener" };
  const rest = raw.slice(nl + 1);
  const match = rest.match(/^---[ \t]*\r?$/m);
  if (!match || match.index === undefined) {
    return { frontmatterText: null, body: raw, error: "unclosed frontmatter" };
  }
  const frontmatterText = rest.slice(0, match.index).replace(/\r\n/g, "\n");
  const body = rest.slice(match.index + match[0].length).replace(/^\n/, "");
  return { frontmatterText, body, error: null };
}

type Frame =
  | { indent: number; kind: "map"; container: Record<string, unknown> }
  | { indent: number; kind: "list"; container: unknown[] };

function parseYamlMap(text: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, kind: "map", container: root }];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine.trim() === "" || /^\s*#/.test(rawLine)) {
      i += 1;
      continue;
    }
    if (rawLine.includes("\t")) return { ok: false, error: "tabs are not allowed in frontmatter" };
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const trimmed = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];

    if (trimmed.startsWith("- ")) {
      if (parent.kind !== "list") return { ok: false, error: "list item is not inside a list" };
      const item = trimmed.slice(2).trim();
      if (/^[A-Za-z0-9_-]+:\s*\S/.test(item)) return { ok: false, error: "list of maps is not supported" };
      const scalar = parseScalar(item);
      if (!scalar.ok) return scalar;
      parent.container.push(scalar.value);
      i += 1;
      continue;
    }

    const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) return { ok: false, error: `cannot parse frontmatter line: ${trimmed.slice(0, 80)}` };
    if (parent.kind !== "map") return { ok: false, error: "a key is nested inside a list" };
    const key = keyMatch[1];
    const rest = keyMatch[2];
    const map = parent.container;

    if (rest === "|" || rest === ">" || rest.startsWith("|") || rest.startsWith(">")) {
      const folded = rest.startsWith(">");
      const block: string[] = [];
      i += 1;
      let blockIndent = -1;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === "") {
          block.push("");
          i += 1;
          continue;
        }
        if (next.includes("\t")) return { ok: false, error: "tabs are not allowed in frontmatter" };
        const nextIndent = next.match(/^ */)?.[0].length ?? 0;
        if (blockIndent < 0) blockIndent = nextIndent;
        if (nextIndent < blockIndent) break;
        block.push(next.slice(blockIndent));
        i += 1;
      }
      const joined = block.join("\n").replace(/\n$/, "");
      map[key] = folded ? joined.replace(/\n+/g, " ").trim() : joined;
      continue;
    }

    if (rest === "") {
      const nextIdx = nextContent(lines, i + 1);
      if (nextIdx == null) {
        map[key] = null;
        i += 1;
        continue;
      }
      const nextLine = lines[nextIdx];
      const nextIndent = nextLine.match(/^ */)?.[0].length ?? 0;
      const nextTrim = nextLine.trim();
      if (nextIndent <= indent) {
        map[key] = null;
        i += 1;
        continue;
      }
      if (nextTrim.startsWith("- ")) {
        const list: unknown[] = [];
        map[key] = list;
        stack.push({ indent, kind: "list", container: list });
        i += 1;
        continue;
      }
      const child: Record<string, unknown> = {};
      map[key] = child;
      stack.push({ indent, kind: "map", container: child });
      i += 1;
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      const list = parseInlineList(rest);
      if (!list.ok) return list;
      map[key] = list.value;
      i += 1;
      continue;
    }
    if (rest.startsWith("{") || rest.startsWith("&") || rest.startsWith("*") || rest.startsWith("!")) {
      return { ok: false, error: "unsupported frontmatter syntax" };
    }
    const scalar = parseScalar(rest);
    if (!scalar.ok) return scalar;
    map[key] = scalar.value;
    i += 1;
  }
  return { ok: true, data: root };
}

function nextContent(lines: string[], start: number): number | null {
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].trim() === "" || /^\s*#/.test(lines[i])) continue;
    return i;
  }
  return null;
}

function parseInlineList(text: string): { ok: true; value: unknown[] } | { ok: false; error: string } {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return { ok: true, value: [] };
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) return { ok: false, error: "unclosed quote in frontmatter list" };
  parts.push(current.trim());
  const value: unknown[] = [];
  for (const part of parts) {
    if (!part) return { ok: false, error: "empty entry in frontmatter list" };
    const scalar = parseScalar(part);
    if (!scalar.ok) return scalar;
    value.push(scalar.value);
  }
  return { ok: true, value };
}

function parseScalar(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    if (trimmed.length < 2) return { ok: false, error: "unclosed quote in frontmatter" };
    return { ok: true, value: trimmed.slice(1, -1) };
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return { ok: false, error: "unclosed quote in frontmatter" };
  const unquoted = trimmed.replace(/[ \t]+#[ \t].*$/, "");
  if (unquoted === "null" || unquoted === "~") return { ok: true, value: null };
  if (unquoted === "true") return { ok: true, value: true };
  if (unquoted === "false") return { ok: true, value: false };
  if (/^-?[0-9]+$/.test(unquoted)) return { ok: true, value: Number(unquoted) };
  return { ok: true, value: unquoted };
}
