import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSqlForTests, sql, type Row } from "../../src/lib/db";
import { setDecisionStoreForTests, setDecisionWriteback } from "../../src/lib/decisions";
import { recordToolReceipt } from "../../src/lib/store";
import { insertToolReceipt, ToolReceiptError } from "../../src/lib/tool-receipt";
import { setRepoOverride } from "../../src/lib/watched-repos";

afterEach(() => {
  setSqlForTests(null);
  setDecisionStoreForTests(null);
});

function textOf(strings: TemplateStringsArray): string {
  return strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

describe("tool receipt contract", () => {
  it("returns the one row the insert actually produced", async () => {
    setSqlForTests(async () => [{ id: "17", kind: "progress.ingest", created_at: "2026-11-15T00:00:00.000Z" }]);
    const receipt = await insertToolReceipt(sql(), {
      kind: "progress.ingest",
      title: "Progress snapshot stored",
    });
    assert.deepEqual(receipt, { id: "17", kind: "progress.ingest", at: "2026-11-15T00:00:00.000Z" });
  });

  it("throws when the insert returns nothing, two rows, or an unusable row", async () => {
    const cases: Row[][] = [
      [],
      [
        { id: "1", kind: "progress.ingest", created_at: "2026-11-15T00:00:00.000Z" },
        { id: "2", kind: "progress.ingest", created_at: "2026-11-15T00:00:00.000Z" },
      ],
      [{ id: "0", kind: "progress.ingest", created_at: "2026-11-15T00:00:00.000Z" }],
      [{ id: "1", kind: "other", created_at: "2026-11-15T00:00:00.000Z" }],
      [{ id: "1", kind: "progress.ingest", created_at: "not-a-time" }],
    ];
    for (const rows of cases) {
      setSqlForTests(async () => rows);
      await assert.rejects(
        () => insertToolReceipt(sql(), { kind: "progress.ingest", title: "stored" }),
        (err: unknown) => err instanceof ToolReceiptError && err.message === "tool receipt was not stored",
      );
    }
  });

  it("keeps a post-commit receipt best-effort when the insert is suppressed", async () => {
    setSqlForTests(async () => []);
    assert.equal(await recordToolReceipt({ kind: "request_decision", title: "filed" }), null);
  });

  it("still throws from the post-commit wrapper when the database errors", async () => {
    setSqlForTests(async () => {
      throw new Error("relation events does not exist");
    });
    await assert.rejects(
      () => recordToolReceipt({ kind: "request_decision", title: "filed" }),
      /recordToolReceipt: relation events does not exist/,
    );
  });

  it("rolls a decision write-back stamp back when its receipt returns no row", async () => {
    const calls: string[] = [];
    setDecisionStoreForTests(null);
    setSqlForTests(async (strings, ...values) => {
      const text = textOf(strings);
      calls.push(text);
      if (text === "begin" || text === "commit" || text === "rollback") return [];
      if (text.includes("insert into events")) return [];
      if (text.includes("update decisions")) {
        return [{
          id: 4,
          key: "github:acme/widgets#9",
          status: "decided",
          decision: "ship",
          writeback: values[0],
          revision: 3,
        }];
      }
      return [];
    });
    await assert.rejects(
      () => setDecisionWriteback(4, "written", 2, null, true),
      ToolReceiptError,
    );
    assert.equal(calls.filter((call) => call === "commit").length, 0);
    assert.equal(calls.filter((call) => call === "rollback").length, 1);
    assert.equal(calls.filter((call) => call.includes("update decisions")).length, 1);
  });

  it("leaves a missing decision stamp alone, including its receipt", async () => {
    const calls: string[] = [];
    setDecisionStoreForTests(null);
    setSqlForTests(async (strings) => {
      const text = textOf(strings);
      calls.push(text);
      if (text === "begin" || text === "commit" || text === "rollback") return [];
      if (text.includes("update decisions")) return [];
      if (text.includes("insert into events")) {
        throw new Error("a zero-row stamp must not insert a receipt");
      }
      return [];
    });
    assert.equal(await setDecisionWriteback(4, "written", 2, null, true), null);
    assert.equal(calls.filter((call) => call === "commit").length, 1);
    assert.equal(calls.some((call) => call.includes("insert into events")), false);
  });

  it("rolls a repo pin back when its receipt returns no row", async () => {
    const calls: string[] = [];
    setSqlForTests(async (strings) => {
      const text = textOf(strings);
      calls.push(text);
      if (text === "begin" || text === "commit" || text === "rollback") return [];
      if (text.includes("pg_advisory_xact_lock")) return [];
      if (text.includes("update watched_repos")) return [{ repo: "acme/app" }];
      if (text.includes("insert into events")) return [];
      return [];
    });
    await assert.rejects(
      () => setRepoOverride("acme/app", { pinned: true }, { kind: "set_repo_override", title: "Repo pin or hide updated" }),
      ToolReceiptError,
    );
    assert.equal(calls.filter((call) => call === "commit").length, 0);
    assert.equal(calls.filter((call) => call === "rollback").length, 1);
  });

  it("writes no repo receipt when the pin matches nothing", async () => {
    const calls: string[] = [];
    setSqlForTests(async (strings) => {
      const text = textOf(strings);
      calls.push(text);
      if (text === "begin" || text === "commit" || text === "rollback") return [];
      if (text.includes("pg_advisory_xact_lock")) return [];
      if (text.includes("update watched_repos")) return [];
      if (text.includes("insert into events")) throw new Error("a missing repo must not insert a receipt");
      return [];
    });
    assert.equal(await setRepoOverride("acme/missing", { hidden: true }, {
      kind: "set_repo_override",
      title: "Repo pin or hide updated",
    }), false);
    assert.equal(calls.filter((call) => call === "commit").length, 1);
    assert.equal(calls.some((call) => call.includes("insert into events")), false);
  });
});
