import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionList } from "../../src/components/DecisionQueue";
import { decisionAwaitingWriteback, decisionQueueVisible } from "../../src/lib/decision-page";
import type { Decision } from "../../src/lib/decisions";

function row(over: Partial<Decision> & Pick<Decision, "id" | "title" | "status">): Decision {
  return {
    key: `github:acme/widgets#${over.id}`,
    source: "github-label",
    repo: "acme/widgets",
    repo_short: "widgets",
    number: over.id,
    url: null,
    why: "Needs an owner.",
    options: null,
    recommended: null,
    requested_by: "collector",
    decision: null,
    decided_by: null,
    decided_at: null,
    defer_until: null,
    kind: "issue",
    labels: ["needs-owner"],
    opened_at: "2026-10-01T00:00:00.000Z",
    github_present: true,
    first_seen_at: "2026-10-01T00:00:00.000Z",
    last_seen_at: "2026-10-01T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-27T00:00:00.000Z",
    revision: 0,
    age_days: 12,
    actor_type: null,
    actor_id: null,
    chosen_option: null,
    writeback: null,
    ...over,
  };
}

describe("decisions page", () => {
  it("keeps a not-written decision on the page after the open queue reloads", async () => {
    const src = fs.readFileSync("src/app/decisions/page.tsx", "utf8");
    assert.equal(
      src.includes('fetch("/api/decisions?status=open")'),
      false,
      "reloading only open rows drops a decided row before Retry write-back can render",
    );
    assert.match(src, /loadDecisionPage\(/);

    const mod = await import("../../src/lib/decision-page");
    const open = [row({ id: 2, title: "Still open", status: "open", first_seen_at: "2026-10-02T00:00:00.000Z" })];
    const missed = row({
      id: 1,
      title: "Ship the schema",
      status: "decided",
      decision: "ship",
      writeback: "not_written",
      first_seen_at: "2026-10-01T00:00:00.000Z",
    });
    const written = row({
      id: 3,
      title: "Already posted",
      status: "decided",
      decision: "wait",
      writeback: "written",
    });
    const crashed = row({
      id: 4,
      title: "Crashed before the stamp",
      status: "decided",
      decision: "hold",
      writeback: null,
      first_seen_at: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(decisionAwaitingWriteback(crashed), true);
    assert.equal(decisionAwaitingWriteback(written), false);
    assert.equal(decisionAwaitingWriteback(open[0]), false);
    const visible = mod.decisionsForPage(open, [missed, written, crashed]) as Decision[];
    assert.deepEqual(visible.map((item) => item.title), ["Crashed before the stamp", "Ship the schema", "Still open"]);
    const html = renderToStaticMarkup(React.createElement(DecisionList, { decisions: visible }));
    assert.match(html, /not written back/);
    assert.match(html, /Retry write-back/);
    assert.equal(html.split("Retry write-back").length - 1, 2);
    const openOnly = renderToStaticMarkup(React.createElement(DecisionList, { decisions: open }));
    assert.equal(openOnly.includes("Retry write-back"), false);
    assert.match(html, /Ship the schema/);
    assert.match(html, /Still open/);
    assert.equal(html.includes("Already posted"), false);

    const loaded = await mod.loadDecisionPage(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("status=open")) {
        return new Response(JSON.stringify({ decisions: open }), { status: 200 });
      }
      if (url.includes("writeback=not_written")) {
        return new Response(JSON.stringify({ decisions: [missed, written] }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    });
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.deepEqual(loaded.decisions.map((item) => item.id), [1, 2]);
  });

  it("shows an error when the pending write-back request fails", async () => {
    const mod = await import("../../src/lib/decision-page");
    const open = [row({ id: 2, title: "Still open", status: "open" })];
    const loaded = await mod.loadDecisionPage(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("status=open")) {
        return new Response(JSON.stringify({ decisions: open }), { status: 200 });
      }
      if (url.includes("writeback=not_written")) {
        return new Response(JSON.stringify({ error: "database unavailable" }), { status: 503 });
      }
      return new Response("no", { status: 500 });
    });
    assert.equal(loaded.ok, false);
    if (loaded.ok) return;
    assert.match(loaded.error, /database unavailable/);
  });

  it("hides No open decisions when the pending write-back load failed", () => {
    const src = fs.readFileSync("src/app/decisions/page.tsx", "utf8");
    assert.match(src, /decisionQueueVisible\(rows, loadFailed\)/);
    assert.match(src, /expected_revision: decision\.revision/);
    assert.equal(decisionQueueVisible([], true), false);
    assert.equal(decisionQueueVisible([], false), true);
    assert.equal(decisionQueueVisible(null, true), false);
    assert.equal(decisionQueueVisible([row({ id: 1, title: "Kept", status: "decided", writeback: "not_written" })], true), true);

    const failed = renderToStaticMarkup(
      decisionQueueVisible([], true)
        ? React.createElement(DecisionList, { decisions: [] })
        : React.createElement("p", null, "database unavailable"),
    );
    assert.equal(failed.includes("No open decisions"), false);
    assert.match(failed, /database unavailable/);

    const empty = renderToStaticMarkup(
      decisionQueueVisible([], false)
        ? React.createElement(DecisionList, { decisions: [] })
        : React.createElement("p", null, "database unavailable"),
    );
    assert.match(empty, /No open decisions/);
  });
});
