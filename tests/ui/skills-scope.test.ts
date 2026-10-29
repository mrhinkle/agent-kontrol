import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSettingsPatch } from "../../src/lib/skills/settings";
import { planScopeChange, viewScope, type ScopePlan } from "../../src/components/SkillHelpers";
import type { SkillScope } from "../../src/components/skills-types";

const ALL: SkillScope = { mode: "all", lanes: [] };

/** Every scope the control sends must pass the API's own settings parser. */
function assertSendable(plan: ScopePlan) {
  assert.equal(plan.kind, "patch");
  if (plan.kind !== "patch") return;
  const parsed = parseSettingsPatch({ scope: plan.scope }, null);
  assert.equal(parsed.ok, true, JSON.stringify(plan.scope));
}

describe("skill scope control plan", () => {
  it("keeps Selected lanes local when no lane is chosen yet", () => {
    const plan = planScopeChange(ALL, false, { type: "mode", mode: "selected" });
    assert.deepEqual(plan, { kind: "local", selected: true });
    assert.deepEqual(viewScope(ALL, true), { mode: "selected", lanes: [] });
    assert.deepEqual(viewScope(ALL, false), ALL);
  });

  it("sends selected with the first lane picked from the local draft", () => {
    const plan = planScopeChange(ALL, true, { type: "toggle", lane: "conference-os" });
    assert.deepEqual(plan, { kind: "patch", scope: { mode: "selected", lanes: ["conference-os"] } });
    assertSendable(plan);
    const added = planScopeChange(ALL, true, { type: "add", lane: " chatterbuilt " });
    assert.deepEqual(added, { kind: "patch", scope: { mode: "selected", lanes: ["chatterbuilt"] } });
    assertSendable(added);
  });

  it("clears the local draft without a request when All lanes is chosen back", () => {
    assert.deepEqual(planScopeChange(ALL, true, { type: "mode", mode: "all" }), { kind: "local", selected: false });
    assert.deepEqual(planScopeChange(ALL, false, { type: "mode", mode: "all" }), { kind: "none" });
  });

  it("adds and removes lanes on a saved selection", () => {
    const one: SkillScope = { mode: "selected", lanes: ["conference-os"] };
    const two = planScopeChange(one, false, { type: "toggle", lane: "chatterbuilt" });
    assert.deepEqual(two, { kind: "patch", scope: { mode: "selected", lanes: ["conference-os", "chatterbuilt"] } });
    assertSendable(two);
    const back = planScopeChange({ mode: "selected", lanes: ["conference-os", "chatterbuilt"] }, false, {
      type: "toggle",
      lane: "chatterbuilt",
    });
    assert.deepEqual(back, { kind: "patch", scope: { mode: "selected", lanes: ["conference-os"] } });
    assertSendable(back);
    assert.deepEqual(planScopeChange(one, false, { type: "add", lane: "conference-os" }), { kind: "none" });
    assert.deepEqual(planScopeChange(one, false, { type: "add", lane: "   " }), { kind: "none" });
  });

  it("refuses to drop the last lane instead of sending an empty or broader scope", () => {
    const one: SkillScope = { mode: "selected", lanes: ["conference-os"] };
    assert.deepEqual(planScopeChange(one, false, { type: "toggle", lane: "conference-os" }), { kind: "last_lane" });
    // The API agrees an empty selection is invalid.
    assert.equal(parseSettingsPatch({ scope: { mode: "selected", lanes: [] } }, null).ok, false);
  });

  it("sends all lanes only when the operator chooses it", () => {
    const one: SkillScope = { mode: "selected", lanes: ["conference-os"] };
    const plan = planScopeChange(one, false, { type: "mode", mode: "all" });
    assert.deepEqual(plan, { kind: "patch", scope: { mode: "all", lanes: [] } });
    assertSendable(plan);
  });

  it("ignores a stale local draft once the saved scope is selected", () => {
    const saved: SkillScope = { mode: "selected", lanes: ["agent-kontrol"] };
    assert.deepEqual(viewScope(saved, true), saved);
    assert.deepEqual(planScopeChange(saved, true, { type: "toggle", lane: "agent-kontrol" }), { kind: "last_lane" });
  });
});
