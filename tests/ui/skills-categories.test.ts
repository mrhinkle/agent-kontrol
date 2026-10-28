import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categoryLabel, categoryOptions, countOf, formatVersion, shortSha, skillsQuery } from "../../src/components/SkillHelpers";

describe("skills categories and wire tolerance", () => {
  it("lists distinct categories case-insensitively, sorted, without blanks or uncategorized", () => {
    const opts = categoryOptions([
      { category: "Engineering Tools" },
      { category: "engineering tools" },
      { category: "Design & Frontend" },
      { category: null },
      { category: "  " },
      { category: "Uncategorized" },
      {},
    ]);
    assert.deepEqual(opts, ["Design & Frontend", "Engineering Tools"]);
  });

  it("labels a missing category as Uncategorized", () => {
    assert.equal(categoryLabel(null), "Uncategorized");
    assert.equal(categoryLabel(undefined), "Uncategorized");
    assert.equal(categoryLabel(" Meta "), "Meta");
  });

  it("sends category only when it narrows the list", () => {
    assert.equal(skillsQuery({ category: "all" }), "");
    assert.equal(skillsQuery({ runtime: "grok", q: "spec", category: "Engineering Tools" }), "?runtime=grok&q=spec&category=Engineering+Tools");
    assert.equal(skillsQuery({ category: "uncategorized" }), "?category=uncategorized");
  });

  it("counts sync results whether the API sends arrays or numbers", () => {
    assert.equal(countOf([{ id: "a" }, { id: "b" }]), 2);
    assert.equal(countOf(3), 3);
    assert.equal(countOf(undefined), 0);
  });

  it("tolerates a null version and sha", () => {
    assert.equal(formatVersion(null), "—");
    assert.equal(shortSha(null), "—");
  });
});
