/**
 * A deliberately small Markdown parser for task bodies and results.
 *
 * Safety model: this produces a plain data tree that the renderer turns into
 * React elements. Nothing is ever injected as HTML, so raw HTML in the source
 * (`<script>`, `<img onerror>`) renders as literal text. Link targets go
 * through `safeHref`, which only allows http(s), mailto, and same-site paths.
 *
 * Supported: ATX headings, paragraphs, hard line breaks, bullet / numbered /
 * task lists (one level), fenced and indented code, blockquotes, horizontal
 * rules, pipe tables, inline code, bold, italic, strikethrough, links, and bare URLs.
 * Anything else renders as text.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "code"; lang: string | null; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  /** Source past the parse cap, shown as plain text so nothing is lost. */
  | { t: "text"; v: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

export interface ListItem {
  checked: boolean | null;
  c: Inline[];
  /** Nested lists (and anything else indented under the item). */
  children: Block[];
}

const MAX_SOURCE = 20_000;
const MAX_DEPTH = 3;

/** Returns a link target that is safe to put in href, or null. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  // Control characters and whitespace can hide a scheme ("java\tscript:").
  if (!url || /[\u0000-\u0020\u007f]/.test(url)) return null;
  if (/^https?:\/\//i.test(url) || /^mailto:[^/]/i.test(url)) return url;
  // Same-site paths and fragments, but not protocol-relative "//evil.example".
  if ((url.startsWith("/") && !url.startsWith("//")) || url.startsWith("#")) return url;
  return null;
}

// ---------- inline ----------

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]{1,300})\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)|<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"\]])|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([^*\n]*?[^\s*])\*|_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9])/g;

export function parseInline(src: string, allowLinks = true): Inline[] {
  const out: Inline[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    // Two trailing spaces or a backslash before a newline is a hard break; other newlines are spaces.
    const parts = s.split(/(?: {2,}|\\)\n/);
    parts.forEach((p, i) => {
      if (i > 0) out.push({ t: "br" });
      const v = p.replace(/\n/g, " ");
      const last = out[out.length - 1];
      if (v && last?.t === "text") last.v += v;
      else if (v) out.push({ t: "text", v });
    });
  };
  let last = 0;
  // matchAll iterates a private copy of the regex, so recursive calls can't disturb lastIndex.
  for (const m of src.matchAll(INLINE)) {
    const index = m.index ?? 0;
    const [all, , code, linkText, linkUrl, angleUrl, bareUrl, strong1, strong2, del, em1, em2] = m;
    const isLink = linkText !== undefined || angleUrl !== undefined || bareUrl !== undefined;
    if (isLink && !allowLinks) continue; // no links inside link text
    if (index < last) continue;
    // Intraword underscores (snake_case) are not emphasis. Checked here rather than with a
    // regex lookbehind, which older Safari versions can't parse.
    if (em2 !== undefined && index > 0 && /[A-Za-z0-9]/.test(src[index - 1])) continue;
    pushText(src.slice(last, index));
    last = index + all.length;
    if (code !== undefined) out.push({ t: "code", v: code.replace(/^ (.*) $/, "$1") });
    else if (linkText !== undefined) {
      const href = safeHref(linkUrl);
      const c = parseInline(linkText, false);
      if (href) out.push({ t: "link", href, c });
      else out.push(...c); // unsafe target: keep the words, drop the link
    } else if (angleUrl !== undefined || bareUrl !== undefined) {
      const url = (angleUrl ?? bareUrl) as string;
      const href = safeHref(url);
      if (href) out.push({ t: "link", href, c: [{ t: "text", v: url }] });
      else pushText(all);
    } else if (strong1 !== undefined || strong2 !== undefined) out.push({ t: "strong", c: parseInline((strong1 ?? strong2) as string, allowLinks) });
    else if (del !== undefined) out.push({ t: "del", c: parseInline(del, allowLinks) });
    else out.push({ t: "em", c: parseInline((em1 ?? em2) as string, allowLinks) });
  }
  pushText(src.slice(last));
  return out;
}

// ---------- blocks ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

export function parseMarkdown(source: string): Block[] {
  // The cap bounds parsing work, not what the reader can see: anything past it
  // is appended verbatim as plain text.
  const head = source.slice(0, MAX_SOURCE);
  const lines = head.replace(/\r\n?/g, "\n").split("\n");
  const blocks = parseBlocks(lines, 0);
  if (source.length > MAX_SOURCE) blocks.push({ t: "text", v: source.slice(MAX_SOURCE) });
  return blocks;
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n").trim()) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      blocks.push({ t: "code", lang: fence[2] || null, v: body.join("\n") });
      continue;
    }
    if (/^( {4}|\t)/.test(line) && para.length === 0) {
      const body: string[] = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || !lines[i].trim())) body.push(lines[i++].replace(/^( {4}|\t)/, ""));
      blocks.push({ t: "code", lang: null, v: body.join("\n").replace(/\n+$/, "") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ t: "heading", level: Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4, c: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      flush();
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line) && depth < 3) {
      flush();
      const body: string[] = [];
      for (let m = QUOTE.exec(lines[i]); i < lines.length && m; m = QUOTE.exec(lines[++i] ?? "")) body.push(m[1]);
      blocks.push({ t: "quote", c: parseBlocks(body, depth + 1) });
      continue;
    }
    if (para.length === 0 && line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      const head = splitRow(line);
      const cols = head.length;
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        rows.push(Array.from({ length: cols }, (_, c) => parseInline(cells[c] ?? "")));
        i++;
      }
      blocks.push({ t: "table", head: head.map((h) => parseInline(h)), rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = !bullet;
      const base = indentOf(line);
      const raw: { text: string; sub: string[] }[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const ind = indentOf(l);
        const m = isOrdered ? ORDERED.exec(l) : BULLET.exec(l);
        if (m && ind <= base + 1) {
          raw.push({ text: isOrdered ? m[2] : m[1], sub: [] });
        } else if (raw.length && l.trim() && ind >= base + 2) {
          // Indented under the current item: nested list, or a continuation line.
          const item = raw[raw.length - 1];
          if (item.sub.length === 0 && !isMarker(l)) item.text += "\n" + l.trim();
          else item.sub.push(l);
        } else if (raw.length && !l.trim() && i + 1 < lines.length && indentOf(lines[i + 1]) >= base + 2 && lines[i + 1].trim()) {
          raw[raw.length - 1].sub.push(""); // blank line inside a nested block
        } else break;
        i++;
      }
      blocks.push({
        t: "list",
        ordered: isOrdered,
        start: ordered ? Number(ordered[1]) : 1,
        items: raw.map(({ text, sub }) => {
          const task = TASK.exec(text);
          const children = sub.length ? (depth < MAX_DEPTH ? parseBlocks(dedent(sub), depth + 1) : [{ t: "p" as const, c: parseInline(dedent(sub).join("\n").trim()) }]) : [];
          return task ? { checked: task[1] !== " ", c: parseInline(task[2]), children } : { checked: null, c: parseInline(text), children };
        }),
      });
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

/** A pipe-table delimiter row: | --- | :---: | ---: | */
const TABLE_DELIM = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Splits one table row on unescaped pipes that are not inside inline code. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line) as RegExpExecArray;
  return m[0].replace(/\t/g, "    ").length;
}

function isMarker(line: string): boolean {
  const t = line.trimStart();
  return BULLET.test(t) || ORDERED.test(t);
}

function dedent(lines: string[]): string[] {
  const ind = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return lines.map((l) => l.replace(/^\t/, "    ").slice(Math.min(ind, indentOf(l))));
}

/** Rough rendered length, for deciding whether a body needs a "Show more". */
export function markdownWeight(source: string): { lines: number; chars: number } {
  const text = source.trim();
  return { lines: text ? text.split(/\r?\n/).length : 0, chars: text.length };
}
