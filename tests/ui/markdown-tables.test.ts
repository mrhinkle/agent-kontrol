import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, splitRow } from "../../src/lib/markdown";

describe("markdown tables", () => {
  const src = "| Name | Value |\n| --- | --- |\n| a | `x\\|y` |\n| b | two |\n\nafter";

  it("parses a header, rows and following paragraph", () => {
    const blocks = parseMarkdown(src);
    assert.equal(blocks[0].t, "table");
    if (blocks[0].t !== "table") return;
    assert.equal(blocks[0].head.length, 2);
    assert.equal(blocks[0].rows.length, 2);
    assert.equal(blocks[1].t, "p");
  });

  it("splits on unescaped pipes outside code only", () => {
    assert.deepEqual(splitRow("| a | `b|c` | d\\|e |"), ["a", "`b|c`", "d|e"]);
  });

  it("pads short rows and ignores extra cells", () => {
    const b = parseMarkdown("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")[0];
    assert.equal(b.t, "table");
    if (b.t !== "table") return;
    assert.ok(b.rows.every((r) => r.length === 2));
  });

  it("does not treat a lone pipe line or a thematic break as a table", () => {
    assert.equal(parseMarkdown("a | b\nnot a delimiter")[0].t, "p");
    assert.equal(parseMarkdown("---")[0].t, "hr");
  });

  it("keeps raw HTML in a cell as text", () => {
    const b = parseMarkdown("| h |\n| --- |\n| <script>x</script> |")[0];
    assert.equal(b.t, "table");
    if (b.t !== "table") return;
    assert.equal(JSON.stringify(b.rows[0][0]).includes("<script>x</script>"), true);
  });
});
