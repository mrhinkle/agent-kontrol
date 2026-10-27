/**
 * Insert, replace, or remove the ak-skills pointer block in an AGENTS.md string.
 * Pure: no I/O. Everything outside the markers is preserved byte for byte.
 */

export const POINTERS_BEGIN = "<!-- ak-skills:begin -->";
export const POINTERS_END = "<!-- ak-skills:end -->";

export class MalformedBlockError extends Error {
  constructor(detail: string) {
    super(`malformed ak-skills block: ${detail}`);
    this.name = "MalformedBlockError";
  }
}

export interface ApplyResult {
  /** The new file content. null means no file should exist (missing file, nothing to write). */
  content: string | null;
  changed: boolean;
}

/**
 * block is the output of renderPointers: "" or begin ... end with no trailing newline.
 * content is the current file, or null/undefined when the file does not exist.
 * Throws on an unpaired or nested marker: guessing would delete the owner's text.
 */
export function applyPointerBlock(content: string | null | undefined, block: string): ApplyResult {
  const existing = content ?? null;
  if (existing === null) {
    if (block === "") return { content: null, changed: false };
    return { content: `${normalise(block, "\n")}\n`, changed: true };
  }
  const eol = detectEol(existing);
  const spans = findSpans(existing);
  if (block === "") return finish(existing, removeSpans(existing, spans, eol));
  const rendered = normalise(block, eol);
  if (spans.length === 0) return finish(existing, appendBlock(existing, rendered, eol));
  // Keep the first block in place, drop any duplicates after it.
  const rest = spans.slice(1);
  const withoutExtras = rest.length ? removeSpans(existing, rest, eol) : existing;
  const first = spans[0];
  const replaced = withoutExtras.slice(0, first.start) + rendered + withoutExtras.slice(first.end);
  return finish(existing, replaced);
}

function finish(before: string, after: string): ApplyResult {
  return { content: after, changed: after !== before };
}

function detectEol(text: string): "\n" | "\r\n" {
  const first = text.indexOf("\n");
  return first > 0 && text[first - 1] === "\r" ? "\r\n" : "\n";
}

function normalise(block: string, eol: string): string {
  return block.replace(/\r\n/g, "\n").replace(/\n/g, eol);
}

interface Span {
  start: number;
  /** Exclusive end of the end marker, not including its line break. */
  end: number;
}

/** A marker counts only when it is alone on its line. Prose that quotes a marker is left alone. */
function markerLines(text: string): { kind: "begin" | "end"; start: number; end: number }[] {
  const found: { kind: "begin" | "end"; start: number; end: number }[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (bare === POINTERS_BEGIN) found.push({ kind: "begin", start: offset, end: offset + bare.length });
    else if (bare === POINTERS_END) found.push({ kind: "end", start: offset, end: offset + bare.length });
    offset += line.length + 1;
  }
  return found;
}

function findSpans(text: string): Span[] {
  const spans: Span[] = [];
  let open: number | null = null;
  for (const marker of markerLines(text)) {
    if (marker.kind === "begin") {
      if (open !== null) throw new MalformedBlockError("nested begin marker");
      open = marker.start;
    } else {
      if (open === null) throw new MalformedBlockError("end marker without begin");
      spans.push({ start: open, end: marker.end });
      open = null;
    }
  }
  if (open !== null) throw new MalformedBlockError("begin marker without end");
  return spans;
}

function appendBlock(text: string, rendered: string, eol: string): string {
  if (text === "") return `${rendered}${eol}`;
  const tail = text.endsWith(eol) ? "" : eol;
  return `${text}${tail}${eol}${rendered}${eol}`;
}

/** Cut each span with its line break, then close the blank line the block left behind. */
function removeSpans(text: string, spans: Span[], eol: string): string {
  let out = text;
  for (const span of [...spans].reverse()) {
    let end = span.end;
    if (out.startsWith(eol, end)) end += eol.length;
    let before = out.slice(0, span.start);
    let after = out.slice(end);
    if (before === "") {
      if (after.startsWith(eol)) after = after.slice(eol.length);
    } else if (before.endsWith(eol + eol) && (after === "" || after.startsWith(eol))) {
      before = before.slice(0, -eol.length);
    }
    out = before + after;
  }
  return out;
}
