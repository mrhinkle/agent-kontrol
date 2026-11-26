import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHiddenCardsWriter } from "../../src/lib/usage-hidden-writer";

/**
 * A fake server that applies a request only when the test releases it, in any
 * order the test chooses. Each response is the stored list at that moment.
 */
function harness() {
  const stored = new Set<string>();
  const pending: { cards: string[]; hidden: boolean; release: (fail?: boolean) => void }[] = [];
  let display: string[] = [];
  let error: string | null = null;
  let reloadFails = false;
  const writer = createHiddenCardsWriter({
    send: (cards, hidden) => new Promise<string[]>((resolve, reject) => {
      pending.push({
        cards, hidden,
        release: (fail) => {
          if (fail) return reject(new Error("HTTP 500"));
          for (const c of cards) hidden ? stored.add(c) : stored.delete(c);
          resolve([...stored].sort());
        },
      });
    }),
    reload: async () => { if (reloadFails) throw new Error("down"); return [...stored].sort(); },
    setList: (update) => { display = update(display); },
    setError: (m) => { error = m; },
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return { writer, pending, stored, tick, get display() { return display; }, get error() { return error; }, failReload: () => { reloadFails = true; } };
}

describe("hidden-card writer", () => {
  it("shows each change at once", async () => {
    const h = harness();
    void h.writer.write(["grok:local"], true);
    assert.deepEqual(h.display, ["grok:local"]);
    assert.equal(h.writer.started(), true);
  });

  it("sends writes one at a time, so the server cannot apply a later hide first", async () => {
    const h = harness();
    const a = h.writer.write(["grok:local"], true);
    const b = h.writer.write(["claude:shadow"], true);
    await h.tick();
    // Only A is at the server. B cannot overtake it: the processing order that
    // left A visible (server handles B, answers [B], then A) cannot happen.
    assert.equal(h.pending.length, 1);
    assert.deepEqual(h.pending[0].cards, ["grok:local"]);
    assert.deepEqual([...h.display].sort(), ["claude:shadow", "grok:local"], "both shown hidden while pending");
    h.pending[0].release();
    await a; await h.tick();
    assert.equal(h.pending.length, 2);
    h.pending[1].release();
    await b;
    assert.deepEqual([...h.stored].sort(), ["claude:shadow", "grok:local"]);
    assert.deepEqual([...h.display].sort(), ["claude:shadow", "grok:local"], "the display matches the server, A included");
    assert.equal(h.error, null);
  });

  it("ignores an older response so it cannot undo a newer change", async () => {
    const h = harness();
    const hide = h.writer.write(["grok:local"], true);
    const show = h.writer.write(["grok:local"], false);
    await h.tick();
    h.pending[0].release();
    await hide;
    assert.deepEqual(h.display, [], "the hide response [grok:local] did not bring back the hidden state");
    await h.tick();
    h.pending[1].release();
    await show;
    assert.deepEqual(h.display, []);
    assert.deepEqual([...h.stored], []);
  });

  it("lets the newest write settle the list when an older one fails", async () => {
    const h = harness();
    const a = h.writer.write(["grok:local"], true);
    const b = h.writer.write(["claude:shadow"], true);
    await h.tick();
    h.pending[0].release(true);
    await a; await h.tick();
    h.pending[1].release();
    await b;
    assert.deepEqual(h.display, ["claude:shadow"], "A was not stored, so A is shown again");
    assert.equal(h.error, null);
  });

  it("re-reads the stored list when the newest write fails, and undoes only itself if that read fails", async () => {
    const h = harness();
    h.stored.add("grok:shadow");
    const a = h.writer.write(["grok:local"], true);
    await h.tick();
    h.pending[0].release(true);
    await a;
    assert.deepEqual(h.display, ["grok:shadow"]);
    assert.equal(h.error, "Could not save: the box is shown again.");

    h.failReload();
    const b = h.writer.write(["claude:shadow"], true);
    await h.tick();
    h.pending[1].release(true);
    await b;
    assert.deepEqual(h.display, ["grok:shadow"]);
  });

  it("keeps sending after a failed write", async () => {
    const h = harness();
    const a = h.writer.write(["grok:local"], true);
    await h.tick();
    h.pending[0].release(true);
    await a;
    const b = h.writer.write(["grok:local"], true);
    await h.tick();
    assert.equal(h.pending.length, 2);
    h.pending[1].release();
    await b;
    assert.deepEqual(h.display, ["grok:local"]);
  });
});
