import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HELP_DOCS, loadDoc, rewriteLinks, stripTitle, REPO_BLOB } from "../../src/lib/help-docs";
import { parseMarkdown } from "../../src/lib/markdown";

describe("help docs", () => {
  it("every listed doc exists, loads, and has content", () => {
    for (const d of HELP_DOCS) {
      const loaded = loadDoc(d.slug);
      assert.ok(loaded, `missing ${d.file}`);
      assert.ok(loaded.source.length > 100, `${d.file} is nearly empty`);
    }
  });

  it("slugs are unique", () => {
    assert.equal(new Set(HELP_DOCS.map((d) => d.slug)).size, HELP_DOCS.length);
  });

  it("links between docs become /help routes and repo files become GitHub links", () => {
    const out = rewriteLinks("[a](DATABASE.md) [b](../PLAYBOOK.md) [c](../src/lib/db.ts) [d](https://x.dev) [e](#top)", "docs/DEPLOY.md");
    assert.ok(out.includes("[a](/help/database)"));
    assert.ok(out.includes("[b](/help/playbook)"));
    assert.ok(out.includes(`[c](${REPO_BLOB}src/lib/db.ts)`));
    assert.ok(out.includes("[d](https://x.dev)"));
    assert.ok(out.includes("[e](#top)"));
  });

  it("no rendered doc contains a raw relative link", () => {
    for (const d of HELP_DOCS) {
      const { source } = loadDoc(d.slug)!;
      for (const m of source.matchAll(/\]\(([^)\s]+)\)/g)) {
        assert.match(m[1], /^(https?:|\/help\/|\/|#|mailto:)/, `${d.file}: ${m[1]}`);
      }
    }
  });

  it("strips only the leading title", () => {
    assert.equal(stripTitle("# Title\n\nbody\n## Keep"), "body\n## Keep");
  });

  it("every doc table parses as a table", () => {
    let tables = 0;
    for (const d of HELP_DOCS) tables += parseMarkdown(loadDoc(d.slug)!.source).filter((b) => b.t === "table").length;
    assert.ok(tables >= 5, `expected tables in the docs, found ${tables}`);
  });
});
