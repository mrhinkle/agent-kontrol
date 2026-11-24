import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkQueueObservation } from "../../src/lib/sweep-evidence";

/**
 * The pr_review ready queue (#176): the sweep.queue validator's ready_items
 * rules. Every pr_review observation carries the ready PRs' heads; a reader
 * never derives a head from a PR number.
 */

const H = (c: string) => c.repeat(40);

function prReview(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "collector",
    queue: "reviews:acme/widgets",
    classification: "pr_review",
    repo: "acme/widgets",
    seq: 1,
    observed_at: "2026-11-23T12:00:00Z",
    complete: true,
    ready: { count: 2, refs: ["#7", "#12"] },
    raw: { count: 3, refs: ["#7", "#9", "#12"] },
    ready_items: [{ number: 7, head_sha: H("a") }, { number: 12, head_sha: H("b") }],
    stale_after_minutes: 30,
    ...over,
  };
}

describe("sweep.queue ready_items (#176)", () => {
  it("accepts a complete pr_review observation and keeps the heads", () => {
    const checked = checkQueueObservation(prReview());
    assert.equal(checked.ok, true, JSON.stringify(checked));
    if (!checked.ok) return;
    assert.deepEqual(checked.value.ready_items, [{ number: 7, head_sha: H("a") }, { number: 12, head_sha: H("b") }]);
    assert.deepEqual(checked.value.ready_refs, ["#7", "#12"]);
  });

  it("accepts a 64-hex head and an empty ready set", () => {
    assert.equal(checkQueueObservation(prReview({ ready: { count: 1, refs: ["#7"] }, ready_items: [{ number: 7, head_sha: "c".repeat(64) }] })).ok, true);
    const empty = checkQueueObservation(prReview({ ready: { count: 0, refs: [] }, ready_items: [] }));
    assert.equal(empty.ok, true);
    if (empty.ok) assert.deepEqual(empty.value.ready_items, []);
  });

  it("requires ready_items on every new pr_review observation, [] when incomplete", () => {
    const missing = checkQueueObservation(prReview({ ready_items: undefined }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.fields["observation.ready_items"] ?? "", /required/);
    assert.equal(checkQueueObservation(prReview({ ready_items: null })).ok, false);

    const incomplete = { complete: false, error: "GitHub rate limited", ready: undefined, raw: undefined };
    const noItems = checkQueueObservation(prReview({ ...incomplete, ready_items: undefined }));
    assert.equal(noItems.ok, false, "an incomplete pr_review observation still states ready_items");
    const withEmpty = checkQueueObservation(prReview({ ...incomplete, ready_items: [] }));
    assert.equal(withEmpty.ok, true);
    if (withEmpty.ok) {
      assert.equal(withEmpty.value.ready_count, null, "incomplete is unknown, never zero");
      assert.deepEqual(withEmpty.value.ready_items, []);
    }
    const withHeads = checkQueueObservation(prReview({ ...incomplete }));
    assert.equal(withHeads.ok, false, "an incomplete observation cannot carry ready heads");
  });

  it("rejects ready_items on issue_dispatch, and issue_dispatch stays valid without it", () => {
    const issue = { classification: "issue_dispatch", queue: "issues:acme/widgets", ready: { count: 1, refs: ["#1"] }, raw: { count: 0, refs: [] } };
    const legacy = checkQueueObservation(prReview({ ...issue, ready_items: undefined }));
    assert.equal(legacy.ok, true);
    if (legacy.ok) assert.equal(legacy.value.ready_items, null);
    for (const items of [[], [{ number: 1, head_sha: H("a") }], null]) {
      const bad = checkQueueObservation(prReview({ ...issue, ready_items: items }));
      assert.equal(bad.ok, false, JSON.stringify(items));
      if (!bad.ok) assert.match(bad.fields["observation.ready_items"] ?? "", /only valid on a pr_review/);
    }
  });

  it("rejects items that do not match ready.refs exactly", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["fewer items than refs", { ready_items: [{ number: 7, head_sha: H("a") }] }],
      ["more items than refs", { ready_items: [{ number: 7, head_sha: H("a") }, { number: 12, head_sha: H("b") }, { number: 13, head_sha: H("c") }] }],
      ["wrong order", { ready_items: [{ number: 12, head_sha: H("b") }, { number: 7, head_sha: H("a") }] }],
      ["different number", { ready_items: [{ number: 7, head_sha: H("a") }, { number: 11, head_sha: H("b") }] }],
      ["refs not numeric order", { ready: { count: 2, refs: ["#12", "#7"] }, ready_items: [{ number: 12, head_sha: H("b") }, { number: 7, head_sha: H("a") }] }],
      ["duplicate ref", { ready: { count: 2, refs: ["#7", "#7"] }, ready_items: [{ number: 7, head_sha: H("a") }, { number: 7, head_sha: H("a") }] }],
      ["ref not #<n>", { ready: { count: 1, refs: ["owner/name#7"] }, ready_items: [{ number: 7, head_sha: H("a") }] }],
      ["leading zero ref", { ready: { count: 1, refs: ["#07"] }, ready_items: [{ number: 7, head_sha: H("a") }] }],
      ["uppercase head", { ready_items: [{ number: 7, head_sha: "A".repeat(40) }, { number: 12, head_sha: H("b") }] }],
      ["short head", { ready_items: [{ number: 7, head_sha: "a".repeat(39) }, { number: 12, head_sha: H("b") }] }],
      ["missing head", { ready_items: [{ number: 7 }, { number: 12, head_sha: H("b") }] }],
      ["unknown item field", { ready_items: [{ number: 7, head_sha: H("a"), green_since: null }, { number: 12, head_sha: H("b") }] }],
      ["string number", { ready_items: [{ number: "7", head_sha: H("a") }, { number: 12, head_sha: H("b") }] }],
      ["zero number", { ready: { count: 1, refs: ["#0"] }, ready_items: [{ number: 0, head_sha: H("a") }] }],
      ["not an array", { ready_items: { number: 7, head_sha: H("a") } }],
      ["item not an object", { ready_items: ["#7", "#12"] }],
      ["over 50", { ready: { count: 51, refs: Array.from({ length: 50 }, (_, i) => `#${i + 1}`) }, ready_items: Array.from({ length: 51 }, (_, i) => ({ number: i + 1, head_sha: H("a") })) }],
    ];
    for (const [label, over] of cases) {
      const checked = checkQueueObservation(prReview(over));
      assert.equal(checked.ok, false, label);
    }
  });
});
