import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listVersion } from "../../src/lib/watched-repos";
import type { RepoConfig } from "../../src/lib/progress-config";

const a: RepoConfig = { repo: "acme/a", label: "A", short: "a", color: "#111111", blockedLabel: null };
const b: RepoConfig = { repo: "acme/b", label: "B", short: "b", color: "#222222", blockedLabel: "blocked" };

describe("listVersion", () => {
  it("is stable for the same list", () => {
    assert.equal(listVersion([a, b]), listVersion([{ ...a }, { ...b }]));
    assert.match(listVersion([a]), /^[0-9a-f]{16}$/);
  });
  it("changes when anything the page edits changes, including order", () => {
    const base = listVersion([a, b]);
    assert.notEqual(base, listVersion([b, a]));
    assert.notEqual(base, listVersion([a]));
    assert.notEqual(base, listVersion([{ ...a, label: "A2" }, b]));
    assert.notEqual(base, listVersion([a, { ...b, blockedLabel: null }]));
    assert.notEqual(base, listVersion([a, { ...b, color: "#333333" }]));
  });
});
