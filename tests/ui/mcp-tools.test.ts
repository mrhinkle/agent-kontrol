import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Static guard on the MCP route source: tool names are public API for the 1.x line.
const src = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");

describe("MCP tool names", () => {
  it("registers the documented tools", () => {
    for (const name of ["report_status", "get_fleet_status", "get_progress_digest", "get_morning_brief", "remember", "recall", "check_inbox", "reply_to_operator", "create_task", "get_task_queue", "claim_task", "update_task", "list_skills", "get_skill", "run_skill", "request_decision", "list_decisions", "resolve_decision", "send_message", "requeue_task", "delete_note", "list_activity", "get_settings", "set_watched_repos"]) {
      assert.ok(src.includes(`"${name}"`), `missing tool ${name}`);
    }
  });

  it("declares an annotations block on every registered tool", () => {
    // One call site per tool, plus one for the reply_to_* loop (reply_to_operator and reply_to_mark).
    const calls = src.match(/server\.registerTool\(/g)?.length ?? 0;
    // 24 call sites: the reply alias shares one call. get_settings and set_watched_repos follow list_activity.
    assert.equal(calls, 24, `expected 24 registerTool call sites, found ${calls}`);
    const annotated = src.match(/^\s+annotations: (READ_ONLY|WRITE|WRITE_IDEMPOTENT|WRITE_DESTRUCTIVE),$/gm)?.length ?? 0;
    assert.equal(annotated, calls, "every registerTool call needs annotations");
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      const defs = src.match(new RegExp(`${hint}: (true|false)`, "g"))?.length ?? 0;
      assert.equal(defs, 4, `${hint} must be an explicit boolean in all four presets`);
    }
    const activity = src.slice(src.indexOf('"list_activity"'), src.indexOf('"list_activity"') + 500);
    assert.match(activity, /annotations: READ_ONLY,/);
  });

  it("keeps reply_to_mark registered as a deprecated alias", () => {
    assert.ok(src.includes('name: "reply_to_mark"'));
    assert.ok(/deprecated alias of reply_to_operator/i.test(src));
  });
});
