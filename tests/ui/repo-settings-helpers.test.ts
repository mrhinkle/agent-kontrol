import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PALETTE, fromRepos, groupErrors, isDirty, moveRow, newRow, preserveDirtyRows, splitWatchedRepos, toPayload } from "../../src/lib/repo-settings-helpers";
import type { RepoInput } from "../../src/lib/repo-validation";

const repo = (n: number): RepoInput => ({ repo: `acme/r${n}`, label: `R${n}`, short: `r${n}`, color: "#2563eb", blockedLabel: null });

describe("repo settings helpers", () => {
  it("newRow cycles the palette and gives unique ids", () => {
    const rows = Array.from({ length: PALETTE.length + 2 }, (_, i) => newRow(i));
    assert.equal(rows[0].color, PALETTE[0]);
    assert.equal(rows[PALETTE.length].color, PALETTE[0]);
    assert.equal(rows[PALETTE.length + 1].color, PALETTE[1]);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    assert.deepEqual([rows[0].repo, rows[0].label, rows[0].short, rows[0].blockedLabel], ["", "", "", null]);
  });

  it("fromRepos and toPayload round-trip without ids", () => {
    const repos = [repo(1), { ...repo(2), blockedLabel: "blocked" }];
    const rows = fromRepos(repos);
    assert.ok(rows.every((r) => typeof r.id === "string"));
    assert.deepEqual(toPayload(rows), repos);
    assert.ok(!("id" in toPayload(rows)[0]));
  });

  it("moveRow moves up and down, ignores bad indexes, and never mutates", () => {
    const rows = fromRepos([repo(1), repo(2), repo(3)]);
    const before = rows.map((r) => r.repo);
    assert.deepEqual(moveRow(rows, 2, 0).map((r) => r.repo), ["acme/r3", "acme/r1", "acme/r2"]);
    assert.deepEqual(moveRow(rows, 0, 1).map((r) => r.repo), ["acme/r2", "acme/r1", "acme/r3"]);
    assert.deepEqual(moveRow(rows, 0, 5).map((r) => r.repo), before);
    assert.deepEqual(moveRow(rows, -1, 1).map((r) => r.repo), before);
    assert.deepEqual(moveRow(rows, 1, 1).map((r) => r.repo), before);
    assert.deepEqual(rows.map((r) => r.repo), before);
    assert.notEqual(moveRow(rows, 1, 1), rows);
  });

  it("keeps an overridden auto row editable so the operator can clear it", () => {
    const discovered = { repo: "acme/app", label: "app", short: "app", color: "#2563eb", blockedLabel: null, origin: "auto" as const, fieldsOverridden: null };
    const overridden = { ...discovered, repo: "acme/custom", label: "Custom", short: "custom", fieldsOverridden: true as const };
    const manual = { repo: "acme/hand", label: "Hand", short: "hand", color: "#112233", blockedLabel: null, origin: "manual" as const, fieldsOverridden: null };
    const split = splitWatchedRepos([discovered, overridden, manual]);
    assert.deepEqual(split.editable.map((row) => row.repo), ["acme/custom", "acme/hand"]);
    assert.equal(split.editable[0]?.fieldsOverridden, true);
    assert.deepEqual(split.discovered.map((row) => row.repo), ["acme/app"]);
    assert.deepEqual(splitWatchedRepos([discovered]).discovered.map((row) => row.repo), ["acme/app"]);
  });

  it("isDirty notices edits, reorders, additions and removals only", () => {
    const initial = [repo(1), repo(2)];
    assert.equal(isDirty(initial, fromRepos(initial)), false);
    const edited = fromRepos(initial);
    edited[1] = { ...edited[1], label: "Changed" };
    assert.equal(isDirty(initial, edited), true);
    assert.equal(isDirty(initial, moveRow(fromRepos(initial), 0, 1)), true);
    assert.equal(isDirty(initial, [...fromRepos(initial), newRow(2)]), true);
    assert.equal(isDirty(initial, fromRepos(initial).slice(1)), true);
    const blocked = fromRepos(initial);
    blocked[0] = { ...blocked[0], blockedLabel: "blocked" };
    assert.equal(isDirty(initial, blocked), true);
  });

  it("groupErrors splits list-level and row errors and keeps the first message per field", () => {
    const g = groupErrors([
      { index: -1, field: "repos", message: "Add at least one repo." },
      { index: 0, field: "repo", message: "first" },
      { index: 0, field: "repo", message: "second" },
      { index: 0, field: "color", message: "bad color" },
      { index: 2, field: "short", message: "dup" },
    ]);
    assert.deepEqual(g.list, ["Add at least one repo."]);
    assert.deepEqual(g.rows[0], { repo: "first", color: "bad color" });
    assert.deepEqual(g.rows[2], { short: "dup" });
    assert.equal(g.rows[1], undefined);
  });

  it("keeps a dirty hand-added draft when the server refresh changes pin", () => {
    const saved = fromRepos([
      { ...repo(1), label: "Saved", pinned: false, hidden: false, origin: "manual" },
      { repo: "acme/new", label: "New", short: "new", color: "#112233", blockedLabel: null },
    ]);
    const draft = saved.map((row, index) => index === 0 ? { ...row, label: "Edited", short: "edited" } : row);
    const server = [
      { ...repo(1), repo: "Acme/R1", label: "Saved", short: "r1", color: "#2563eb", blockedLabel: null, pinned: true, hidden: false, origin: "manual" as const },
    ];
    const kept = preserveDirtyRows(draft, server);
    assert.equal(kept.length, 2);
    assert.equal(kept[0]?.id, draft[0]?.id);
    assert.equal(kept[0]?.label, "Edited");
    assert.equal(kept[0]?.short, "edited");
    assert.equal(kept[0]?.repo, "acme/r1");
    assert.equal(kept[0]?.pinned, true);
    assert.equal(kept[1]?.repo, "acme/new");
    assert.equal(kept[1]?.label, "New");
  });

  it("the settings page preserves the draft inside setOverride instead of reloading the form", () => {
    const source = fs.readFileSync("src/components/RepoSettings.tsx", "utf8");
    const start = source.indexOf("async function setOverride");
    const end = source.indexOf("if (loadError)");
    assert.ok(start > 0 && end > start);
    const fn = source.slice(start, end);
    assert.match(fn, /preserveDirtyRows/);
    assert.doesNotMatch(fn, /\bapply\(/);
  });
});
