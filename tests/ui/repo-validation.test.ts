import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRepoList, MAX_REPOS, type RepoInput } from "../../src/lib/repo-validation";

const ok = (over: Partial<RepoInput> = {}): RepoInput => ({
  repo: "acme/api",
  label: "API",
  short: "api",
  color: "#2563EB",
  blockedLabel: null,
  ...over,
});

function errorsOf(input: unknown) {
  const r = validateRepoList(input);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.errors;
}

describe("validateRepoList", () => {
  it("accepts a valid list, trims text and lowercases colors", () => {
    const r = validateRepoList([ok({ repo: "  acme/api ", label: " API ", blockedLabel: "  blocked " })]);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.repos[0], { repo: "acme/api", label: "API", short: "api", color: "#2563eb", blockedLabel: "blocked" });
  });

  it("turns an empty or missing blocked label into null", () => {
    for (const blockedLabel of ["", "   ", undefined, null] as const) {
      const r = validateRepoList([{ ...ok(), blockedLabel }]);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.repos[0].blockedLabel, null);
    }
  });

  it("rejects repos that are not owner/name", () => {
    for (const repo of ["acme app", "acme", "acme/", "/api", "a/b/c", "", "acme/ap i"]) {
      const e = errorsOf([ok({ repo })]);
      assert.ok(e.some((x) => x.index === 0 && x.field === "repo"), repo);
    }
  });

  it("flags the second occurrence of a duplicate repo or short name, ignoring case", () => {
    const e = errorsOf([ok(), ok({ repo: "ACME/API", short: "other" }), ok({ repo: "acme/web", short: "API" })]);
    assert.deepEqual(
      e.map((x) => [x.index, x.field]),
      [[1, "repo"], [2, "short"]],
    );
  });

  it("checks label, short, color and blocked label rules", () => {
    assert.ok(errorsOf([ok({ label: "" })]).some((x) => x.field === "label"));
    assert.ok(errorsOf([ok({ label: "x".repeat(41) })]).some((x) => x.field === "label"));
    assert.ok(errorsOf([ok({ short: "" })]).some((x) => x.field === "short"));
    assert.ok(errorsOf([ok({ short: "x".repeat(13) })]).some((x) => x.field === "short"));
    assert.ok(errorsOf([ok({ short: "a b" })]).some((x) => x.field === "short"));
    for (const color of ["blue", "#fff", "#12345g", "2563eb"]) {
      assert.ok(errorsOf([ok({ color })]).some((x) => x.field === "color"), color);
    }
    assert.ok(errorsOf([ok({ blockedLabel: "x".repeat(51) })]).some((x) => x.field === "blockedLabel"));
  });

  it("rejects the collector's field separator in label and blocked label", () => {
    assert.ok(errorsOf([ok({ label: "a|b" })]).some((x) => x.field === "label"));
    assert.ok(errorsOf([ok({ blockedLabel: "a|b" })]).some((x) => x.field === "blockedLabel"));
  });

  it("reports several problems at once", () => {
    const e = errorsOf([ok({ repo: "bad", color: "red" }), ok({ repo: "acme/web", short: "" })]);
    assert.deepEqual(
      e.map((x) => [x.index, x.field]),
      [[0, "repo"], [0, "color"], [1, "short"]],
    );
  });

  it("enforces list size and shape", () => {
    assert.deepEqual(errorsOf([]).map((x) => [x.index, x.field, x.message]), [[-1, "repos", "Add at least one repo."]]);
    const many = Array.from({ length: MAX_REPOS + 1 }, (_, i) => ok({ repo: `acme/r${i}`, short: `r${i}` }));
    assert.ok(errorsOf(many).some((x) => x.index === -1 && /At most/.test(x.message)));
    assert.equal(validateRepoList(many.slice(0, MAX_REPOS)).ok, true);
    assert.deepEqual(errorsOf("nope").map((x) => x.index), [-1]);
    assert.deepEqual(errorsOf(null).map((x) => x.index), [-1]);
    assert.ok(errorsOf([42]).some((x) => x.index === 0));
    assert.ok(errorsOf([[]]).some((x) => x.index === 0));
  });

  it("rejects control characters and, in the blocked label, quotes and backslashes", () => {
    assert.ok(errorsOf([ok({ label: "a\nb" })]).some((x) => x.field === "label"));
    assert.ok(errorsOf([ok({ blockedLabel: "a\nb" })]).some((x) => x.field === "blockedLabel"));
    assert.ok(errorsOf([ok({ blockedLabel: 'x" repo:other/private is:issue "' })]).some((x) => x.field === "blockedLabel"));
    assert.ok(errorsOf([ok({ blockedLabel: "a\\b" })]).some((x) => x.field === "blockedLabel"));
    const fine = validateRepoList([ok({ blockedLabel: "needs: design" })]);
    assert.equal(fine.ok, true);
  });
});
