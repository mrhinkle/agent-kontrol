import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillSyncFeedback, skillSyncView } from "../../src/components/SkillSyncFeedback";
import type { SkillSyncView } from "../../src/components/skills-types";

const SKIP = "skills/ui-ux-pro-max/data/google-fonts.csv skipped (over 256 KB)";
const FATAL = "skills/accesslint-audit/SKILL.md: unsupported frontmatter syntax";

function html(view: SkillSyncView): string {
  return renderToStaticMarkup(createElement(SkillSyncFeedback, { view }));
}

describe("skill sync feedback", () => {
  it("shows a successful sync with its mutation counts", () => {
    const view = skillSyncView(true, 200, {
      status: "ok",
      added: [{ id: "alpha" }, { id: "beta" }],
      changed: [{ id: "gamma" }],
      removed: [],
      errors: [],
    });
    const text = html(view);
    assert.match(text, /\+2 ~1 −0/);
    assert.equal(text.includes("Sync failed"), false);
    assert.equal(text.includes("already running"), false);
  });

  it("keeps a warning-only sync successful and shows the notice", () => {
    const view = skillSyncView(true, 200, {
      status: "ok",
      added: [],
      changed: [],
      removed: [],
      errors: [{ source: "master-skills", message: SKIP, severity: "notice" }],
    });
    const text = html(view);
    assert.match(text, /\+0 ~0 −0/);
    assert.match(text, new RegExp(`master-skills: ${SKIP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(text.includes("Sync failed"), false);
  });

  it("shows the fatal parse cause and source ahead of a leading skip", () => {
    const view = skillSyncView(true, 200, {
      status: "failed",
      added: [{ id: "beta" }],
      changed: [{ id: "kept" }],
      removed: ["gone"],
      errors: [
        { source: "master-skills", message: SKIP, severity: "notice" },
        { source: "master-skills", message: FATAL, severity: "fatal" },
      ],
    });
    assert.equal(view.kind, "result");
    if (view.kind !== "result") return;
    assert.equal(view.result.diagnostics[0]?.severity, "fatal");
    assert.equal(view.result.diagnostics[0]?.message, FATAL);
    assert.equal(view.result.diagnostics[1]?.severity, "notice");
    const text = html(view);
    assert.match(text, /Sync failed: master-skills: skills\/accesslint-audit\/SKILL.md: unsupported frontmatter syntax/);
    assert.equal(text.includes("Sync failed: master-skills: skills/ui-ux-pro-max"), false);
    assert.match(text, /google-fonts\.csv skipped \(over 256 KB\)/);
    assert.match(text, /\+1 ~1 −1/);
    const fatalAt = text.indexOf("accesslint-audit");
    const skipAt = text.indexOf("google-fonts.csv");
    assert.equal(fatalAt >= 0 && skipAt > fatalAt, true);
    assert.match(text, /data-severity="fatal"/);
    assert.match(text, /data-severity="notice"/);
  });

  it("shows busy without treating it as a failed sync", () => {
    const view = skillSyncView(true, 200, {
      status: "busy",
      added: [],
      changed: [],
      removed: [],
      errors: [{ source: "sync", message: "sync lease lost", severity: "fatal" }],
    });
    const text = html(view);
    assert.match(text, /A sync is already running/);
    assert.equal(text.includes("Sync failed"), false);
    assert.equal(text.includes("+0"), false);
  });

  it("shows a request-level error and does not invent mutation counts", () => {
    const denied = skillSyncView(false, 401, { error: "Sign in required" });
    const deniedText = html(denied);
    assert.equal(deniedText, '<span class="text-xs text-red-400">Sign in required</span>');
    const fallback = skillSyncView(false, 503, null);
    assert.equal(html(fallback), '<span class="text-xs text-red-400">Sync failed (503)</span>');
  });
});
