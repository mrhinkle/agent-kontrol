import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownWeight, parseInline, parseMarkdown, safeHref, type Block, type Inline } from "../../src/lib/markdown";

// Walk every inline node in a block tree.
function inlines(blocks: Block[]): Inline[] {
  const out: Inline[] = [];
  const walk = (ns: Inline[]) => ns.forEach((n) => (out.push(n), "c" in n && walk(n.c)));
  for (const b of blocks) {
    if (b.t === "p" || b.t === "heading") walk(b.c);
    if (b.t === "list") b.items.forEach((it) => walk(it.c));
    if (b.t === "quote") out.push(...inlines(b.c));
  }
  return out;
}
const links = (src: string) => inlines(parseMarkdown(src)).filter((n): n is Extract<Inline, { t: "link" }> => n.t === "link");
const text = (src: string) => inlines(parseMarkdown(src)).filter((n) => n.t === "text").map((n) => (n as { v: string }).v).join("");

describe("safeHref", () => {
  it("allows http(s), mailto and same-site paths", () => {
    for (const u of ["https://example.com/a?b=1", "http://example.com", "mailto:someone@example.com", "/tasks", "#acceptance"]) assert.equal(safeHref(u), u);
  });
  it("blocks script and data schemes, protocol-relative and obfuscated urls", () => {
    for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.example/x", "file:///etc/passwd", ""]) {
      assert.equal(safeHref(u), null, u);
    }
  });
});

describe("raw HTML is never markup", () => {
  it("keeps <script> and event-handler HTML as literal text", () => {
    const src = "<script>alert('xss')</script>\n\n<img src=x onerror=alert(1)>";
    const blocks = parseMarkdown(src);
    assert.ok(blocks.every((b) => b.t === "p"));
    assert.match(text(src), /<script>alert\('xss'\)<\/script>/);
    assert.match(text(src), /<img src=x onerror=alert\(1\)>/);
  });
  it("drops unsafe link targets but keeps the words", () => {
    assert.equal(links("[click me](javascript:alert(1))").length, 0);
    assert.match(text("[click me](javascript:alert(1))"), /click me/);
    assert.equal(links("[x](data:text/html;base64,PHNjcmlwdD4=)").length, 0);
  });
  it("does not nest links inside link text", () => {
    const l = links("[see https://a.example](https://b.example)");
    assert.equal(l.length, 1);
    assert.equal(l[0].href, "https://b.example");
  });
});

describe("blocks", () => {
  it("parses headings, task lists, code fences and paragraphs (the fixture task body)", () => {
    const src = "## Goal\nShip Phase 1 of **issue #12**.\n\n### Acceptance\n- [ ] Ingest `state.db`\n- [x] Credits panel\n\n```bash\ntimeout 45m ./run.sh\n```\nSee the [spec](https://example.com/spec).";
    const b = parseMarkdown(src);
    assert.deepEqual(b.map((x) => x.t), ["heading", "p", "heading", "list", "code", "p"]);
    const list = b[3] as Extract<Block, { t: "list" }>;
    assert.deepEqual(list.items.map((i) => i.checked), [false, true]);
    assert.deepEqual(b[4], { t: "code", lang: "bash", v: "timeout 45m ./run.sh" });
    assert.equal(links(src)[0].href, "https://example.com/spec");
  });
  it("keeps markdown inside code fences literal", () => {
    const b = parseMarkdown("```\n**not bold** <b>x</b>\n```");
    assert.deepEqual(b, [{ t: "code", lang: null, v: "**not bold** <b>x</b>" }]);
  });
  it("handles an unterminated fence without swallowing errors", () => {
    assert.deepEqual(parseMarkdown("```\nline"), [{ t: "code", lang: null, v: "line" }]);
  });
  it("parses ordered lists with a start number, quotes and rules", () => {
    const b = parseMarkdown("3. three\n4. four\n\n> quoted **bit**\n\n---");
    assert.deepEqual(b.map((x) => x.t), ["list", "quote", "hr"]);
    assert.equal((b[0] as Extract<Block, { t: "list" }>).start, 3);
  });
  it("nests indented child items (bullet, task and numbered) under their parent", () => {
    const b = parseMarkdown("- [ ] Deploy\n  - [ ] Verify rollout\n  - [x] Notify\n- [ ] Close\n\n1. One\n   1. One-a\n2. Two") as Extract<Block, { t: "list" }>[];
    assert.equal(b.length, 2);
    assert.equal(b[0].items.length, 2);
    const kids = b[0].items[0].children as Extract<Block, { t: "list" }>[];
    assert.equal(kids[0].t, "list");
    assert.deepEqual(kids[0].items.map((i) => i.checked), [false, true]);
    assert.equal(b[1].items.length, 2);
    assert.equal((b[1].items[0].children[0] as Extract<Block, { t: "list" }>).ordered, true);
  });

  it("folds indented continuation lines into the list item", () => {
    const b = parseMarkdown("- first\n  more of first\n- second") as Extract<Block, { t: "list" }>[];
    assert.equal(b[0].items.length, 2);
    assert.deepEqual(b[0].items[0].c, [{ t: "text", v: "first more of first" }]);
  });
});

describe("inline", () => {
  it("parses code, bold, italic, strike and bare urls", () => {
    assert.deepEqual(parseInline("a `x*y` b"), [{ t: "text", v: "a " }, { t: "code", v: "x*y" }, { t: "text", v: " b" }]);
    assert.deepEqual(parseInline("**b** and *i* and ~~s~~").map((n) => n.t), ["strong", "text", "em", "text", "del"]);
    const l = parseInline("see https://example.com/x.");
    assert.deepEqual(l[1], { t: "link", href: "https://example.com/x", c: [{ t: "text", v: "https://example.com/x" }] });
    assert.deepEqual(l[2], { t: "text", v: "." });
  });
  it("does not treat snake_case or 2*3*4 as emphasis", () => {
    assert.deepEqual(parseInline("use snake_case_name here"), [{ t: "text", v: "use snake_case_name here" }]);
    assert.deepEqual(parseInline("an _underscored_ word").map((n) => n.t), ["text", "em", "text"]);
  });
  it("supports hard line breaks", () => {
    assert.deepEqual(parseInline("one  \ntwo").map((n) => n.t), ["text", "br", "text"]);
  });
});

describe("collapse weight", () => {
  it("counts lines and chars", () => {
    assert.deepEqual(markdownWeight("a\nb\n"), { lines: 2, chars: 3 });
    assert.deepEqual(markdownWeight("   "), { lines: 0, chars: 0 });
  });
  it("bounds parsing work but never drops text past the cap", () => {
    const b = parseMarkdown("x".repeat(20_000) + "TAIL" + "y".repeat(5_000));
    assert.equal((b[0] as { c: { v: string }[] }).c[0].v.length, 20_000);
    assert.deepEqual(b[1], { t: "text", v: "TAIL" + "y".repeat(5_000) });
  });
});

describe("no pathological slowdowns", () => {
  // Compare growth rather than wall-clock limits, so a loaded CI machine slows both sizes alike.
  const patterns: ((n: number) => string)[] = [
    (n) => "[".repeat(n) + "](",
    (n) => "[a](" + "(".repeat(n),
    (n) => "**" + "a*".repeat(n / 2),
    (n) => "`a".repeat(n / 2),
    (n) => "~~a".repeat(n / 3),
    (n) => "https://" + "a.".repeat(n / 2),
    (n) => "> ".repeat(n / 2),
    (n) => "- a\n  ".repeat(n / 6),
  ];
  const time = (src: string) => {
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t = performance.now();
      parseMarkdown(src);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  it("scales roughly linearly on adversarial inputs (10x input, far less than 100x time)", () => {
    for (const p of patterns) {
      const small = time(p(2_000));
      const big = time(p(20_000));
      assert.ok(big < small * 35 + 60, `${p(12).slice(0, 12)}…: ${small.toFixed(1)}ms → ${big.toFixed(1)}ms`);
    }
  });
});
