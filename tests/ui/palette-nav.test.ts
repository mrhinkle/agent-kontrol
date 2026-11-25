import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { STATUS_STYLES, TASK_STATUS_STYLES } from "../../src/components/ui";
import { AGENT_STATUS_COLORS } from "../../src/lib/gibson-types";
import { NAV_LINKS, isActive } from "../../src/lib/nav";

// WCAG 2.x relative luminance and contrast ratio.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Classes name Ion tokens (bg-success, text-muted); globals.css holds their values:
// light in the @theme block, dark under [data-theme="dark"].
const CSS = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
const THEMES = {
  light: CSS.slice(CSS.indexOf("@theme {"), CSS.indexOf("@theme inline")),
  dark: CSS.slice(CSS.indexOf('[data-theme="dark"] {')),
};
const hexOf = (cls: string, theme: keyof typeof THEMES = "dark") => {
  const token = /^(?:bg|text|ring)-([a-z-]+?)(?:\/\d+)?$/.exec(cls)?.[1];
  const m = token ? new RegExp(`--color-${token}:\\s*(#[0-9a-f]{6})`, "i").exec(THEMES[theme]) : null;
  assert.ok(m, `no Ion ${theme} token for ${cls}`);
  return m[1];
};
// Chips are an Ion panel with an fg/5 fill: 0.95*panel + 0.05*fg.
// Dark: #12151a + 5% #e8eaed. Light: #ffffff + 5% #0d1117.
const CHIP_BG = { dark: "#1e2125", light: "#f3f4f4" };

describe("task status chips use the Fleet/Gibson palette", () => {
  it("green running, amber review, red failed, dim done", () => {
    assert.equal(hexOf(TASK_STATUS_STYLES.running.dot), AGENT_STATUS_COLORS.active);
    assert.equal(hexOf(TASK_STATUS_STYLES.review.dot), AGENT_STATUS_COLORS.waiting);
    assert.equal(hexOf(TASK_STATUS_STYLES.failed.dot), AGENT_STATUS_COLORS.failed);
    assert.equal(hexOf(TASK_STATUS_STYLES.done.dot), AGENT_STATUS_COLORS.done);
    for (const st of ["running", "review", "failed", "done"]) assert.equal(TASK_STATUS_STYLES[st].text, STATUS_STYLES[{ running: "active", review: "waiting", failed: "failed", done: "done" }[st]!].text);
  });

  it("covers every task status", () => {
    for (const st of ["queued", "claimed", "running", "review", "done", "failed", "cancelled"]) assert.ok(TASK_STATUS_STYLES[st], st);
  });

  it("chip text meets WCAG AA (4.5:1) for small text, for task and agent chips, in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const [name, s] of [...Object.entries(TASK_STATUS_STYLES), ...Object.entries(STATUS_STYLES).map(([k, v]) => [`agent:${k}`, v] as const)]) {
        const ratio = contrast(hexOf(s.text, theme), CHIP_BG[theme]);
        assert.ok(ratio >= 4.5, `${theme} ${name}: ${ratio.toFixed(2)}:1`);
      }
    }
  });
});

describe("main nav", () => {
  it("marks exactly one link active, including nested routes", () => {
    const active = (p: string) => NAV_LINKS.filter((l) => isActive(p, l.href)).map((l) => l.href);
    assert.deepEqual(active("/"), ["/"]);
    assert.deepEqual(active("/tasks"), ["/tasks"]);
    assert.deepEqual(active("/history"), ["/history"]);
    assert.deepEqual(active("/usage/accounts"), ["/usage"]);
    assert.deepEqual(active("/login"), []);
  });
  it("keeps the agreed link set and order", () => {
    assert.deepEqual(NAV_LINKS.map((l) => l.label), ["Fleet", "Progress", "Velocity", "Usage and Costs", "Langfuse", "Tasks", "Decisions", "History", "Traces", "Memory", "Skills", "Gibson", "Settings", "Help"]);
  });
});
