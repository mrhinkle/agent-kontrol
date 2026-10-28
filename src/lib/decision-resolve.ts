/**
 * Decide, defer, withdraw, and the agent tools that file a decision.
 *
 * The actor comes from the principal. Body fields decided_by, actor_type,
 * actor_id, repo, number, key, and force are not read here.
 * A decided or withdrawn row is a conflict. Deferred is not terminal.
 * expected_updated_at is checked before that conflict, so a stale page
 * hears `stale` rather than `conflict`.
 */

import type { Actor } from "./actor";
import { currentActor } from "./actor";
import { mcpToolError, type McpToolResult } from "./api-error";
import { parseDeferInstant, readOptions } from "./decision-format";
import { writeDecisionBack, type WritebackOutcome } from "./decision-writeback";
import {
  decisionPersistenceOn,
  getDecision,
  isDecisionStatus,
  parseListQuery,
  patchDecision,
  listDecisions,
  upsertDecision,
  type Decision,
  type DecisionStatus,
  type ParseFail,
} from "./decisions";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface ResolveBody {
  status?: DecisionStatus;
  decision?: string | null;
  setDecision: boolean;
  defer_until?: string | null;
  setDefer: boolean;
  option_id?: string | null;
  expected_updated_at?: string | null;
}

export type ResolveOutcome =
  | { ok: true; decision: Decision }
  | {
      ok: false;
      code: "not_found" | "conflict" | "stale" | "validation_failed" | "missing_field";
      message: string;
      fields?: Record<string, string>;
    };

function fail(code: ParseFail["code"], fields: Record<string, string>): ParseFail {
  const message = Object.values(fields)[0] ?? (code === "missing_field" ? "a required field is missing" : "validation failed");
  return { ok: false, code, message, fields };
}

function sameInstant(left: string, right: string): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return !Number.isNaN(a) && a === b;
}

/**
 * Body for PATCH and resolve_decision. `decided_by` counts toward "a field
 * was sent" and is then discarded. A past or impossible defer date is 400
 * here, not inside patchDecision, so the library can still store a past
 * defer the collector tests use.
 */
export function parseResolveBody(body: unknown, nowMs: number = Date.now()): { ok: true; value: ResolveBody } | ParseFail {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("validation_failed", { body: "Send a JSON object." });
  }
  const raw = body as Record<string, unknown>;
  const setDecision = Object.prototype.hasOwnProperty.call(raw, "decision");
  const setDecidedBy = Object.prototype.hasOwnProperty.call(raw, "decided_by");
  const setDefer = Object.prototype.hasOwnProperty.call(raw, "defer_until");
  const hasStatus = Object.prototype.hasOwnProperty.call(raw, "status");
  const hasOption = Object.prototype.hasOwnProperty.call(raw, "option_id");
  const hasExpected = Object.prototype.hasOwnProperty.call(raw, "expected_updated_at");
  if (!hasStatus && !setDecision && !setDecidedBy && !setDefer && !hasOption) {
    return fail("missing_field", { body: "Send status, decision, decided_by, or defer_until." });
  }
  const fields: Record<string, string> = {};
  let status: DecisionStatus | undefined;
  if (hasStatus) {
    if (typeof raw.status !== "string" || !isDecisionStatus(raw.status)) {
      fields.status = "status must be open, decided, deferred, or withdrawn.";
    } else status = raw.status;
  }
  let decision: string | null | undefined;
  if (setDecision) {
    if (raw.decision == null) decision = null;
    else if (typeof raw.decision !== "string") fields.decision = "decision must be a string.";
    else if (raw.decision.length > 8000) fields.decision = "decision is too long.";
    else if (CONTROL.test(raw.decision)) fields.decision = "decision must not contain control characters.";
    else decision = raw.decision;
  }
  let optionId: string | null | undefined;
  if (hasOption && raw.option_id != null && raw.option_id !== "") {
    if (typeof raw.option_id !== "string" || CONTROL.test(raw.option_id) || raw.option_id.length > 200) {
      fields.option_id = "option_id must be a short string.";
    } else optionId = raw.option_id;
  }
  let expected: string | null | undefined;
  if (hasExpected && raw.expected_updated_at != null && raw.expected_updated_at !== "") {
    if (typeof raw.expected_updated_at !== "string" || Number.isNaN(Date.parse(raw.expected_updated_at))) {
      fields.expected_updated_at = "expected_updated_at must be an ISO 8601 timestamp.";
    } else expected = new Date(raw.expected_updated_at).toISOString();
  }
  const deferring = status === "deferred" || (status == null && setDefer);
  let deferUntil: string | null | undefined;
  if (deferring) {
    const parsed = parseDeferInstant(raw.defer_until, nowMs);
    if (!parsed.ok) fields.defer_until = parsed.message;
    else deferUntil = parsed.iso;
  } else if (setDefer && raw.defer_until != null && raw.defer_until !== "") {
    if (typeof raw.defer_until !== "string" || Number.isNaN(Date.parse(raw.defer_until))) {
      fields.defer_until = "defer_until must be an ISO 8601 timestamp.";
    }
  }
  if (status === "decided") {
    const text = decision == null ? "" : decision.trim();
    if (text === "" && !optionId) fields.decision = "A decided row needs the decision text.";
  }
  if (Object.keys(fields).length > 0) return fail("validation_failed", fields);
  return {
    ok: true,
    value: {
      status,
      decision: decision ?? null,
      setDecision,
      defer_until: deferUntil ?? null,
      setDefer: deferring || setDefer,
      option_id: optionId ?? null,
      expected_updated_at: expected ?? null,
    },
  };
}

function notFound(): ResolveOutcome {
  return {
    ok: false,
    code: "not_found",
    message: "Decision not found",
    fields: { id: "No decision with that id." },
  };
}

function stale(): ResolveOutcome {
  return { ok: false, code: "stale", message: "This decision changed since you loaded it." };
}

function terminalConflict(): ResolveOutcome {
  return {
    ok: false,
    code: "conflict",
    message: "This decision is already decided or withdrawn.",
    fields: { status: "Already decided or withdrawn." },
  };
}

export async function resolveDecision(input: ResolveBody & { id: number; actor: Actor | null }): Promise<ResolveOutcome> {
  const row = await getDecision(input.id);
  if (!row) return notFound();
  if (input.expected_updated_at && !sameInstant(row.updated_at, input.expected_updated_at)) return stale();

  const next = input.status;
  // status open is the explicit reopen. Every other mutation of a decided or
  // withdrawn row is a conflict, including a body that omits status and only
  // sends decision text. Deferred is not terminal.
  const reopening = next === "open";
  if ((row.status === "decided" || row.status === "withdrawn") && !reopening) return terminalConflict();

  let decisionText = input.setDecision ? input.decision ?? null : undefined;
  let chosen: string | null = null;
  let setChosen = false;
  if (input.option_id) {
    const match = readOptions(row.options).find((option) => option.id === input.option_id);
    if (!match) {
      return {
        ok: false,
        code: "validation_failed",
        message: "option_id is not one of this decision's options.",
        fields: { option_id: "Unknown option." },
      };
    }
    setChosen = true;
    chosen = match.id;
    if (next === "decided" && (decisionText == null || decisionText.trim() === "")) decisionText = match.label;
  }
  if (next === "decided" && (decisionText == null || decisionText.trim() === "")) {
    return {
      ok: false,
      code: "validation_failed",
      message: "A decided row needs the decision text.",
      fields: { decision: "A decided row needs the decision text." },
    };
  }

  const updated = await patchDecision(input.id, {
    status: next,
    decision: decisionText ?? null,
    setDecision: decisionText !== undefined,
    decided_by: input.actor?.actor_id ?? null,
    setDecidedBy: true,
    defer_until: input.defer_until ?? null,
    setDefer: input.setDefer,
    setActor: true,
    actor_type: input.actor?.actor_type ?? null,
    actor_id: input.actor?.actor_id ?? null,
    setChosen,
    chosen_option: chosen,
    expectedUpdatedAt: input.expected_updated_at ?? null,
    guardTerminal: true,
  });
  if (!updated) {
    const again = await getDecision(input.id);
    if (!again) return notFound();
    if (input.expected_updated_at && !sameInstant(again.updated_at, input.expected_updated_at)) return stale();
    if (again.status === "decided" || again.status === "withdrawn") return terminalConflict();
    return notFound();
  }
  if (updated.status !== "decided") return { ok: true, decision: updated };
  return afterWrite(updated, await writeDecisionBack(updated));
}

/**
 * Read the row after write-back. The stamp lives inside writeDecisionBack
 * and only lands when that decided revision is still current, so the response
 * is the stored row rather than a stamp applied in memory.
 * One follow handles a retry that lost the race to a failed stamp and still
 * needs to post. A reopen is not followed.
 */
async function afterWrite(row: Decision, write: WritebackOutcome, follows = 0): Promise<ResolveOutcome> {
  const current = await getDecision(row.id);
  const visible = current ?? row;
  if (write.status === "no_target") return { ok: true, decision: visible };
  if (
    write.status === "superseded"
    && follows < 1
    && visible.status === "decided"
    && visible.writeback !== "written"
    && !sameInstant(visible.updated_at, row.updated_at)
  ) {
    return afterWrite(visible, await writeDecisionBack(visible), follows + 1);
  }
  return { ok: true, decision: visible };
}

/** Retry a failed GitHub write-back. Does not decide the row again. */
export async function retryDecisionWriteback(id: number, expectedUpdatedAt: string | null): Promise<ResolveOutcome> {
  const row = await getDecision(id);
  if (!row) return notFound();
  if (expectedUpdatedAt && !sameInstant(row.updated_at, expectedUpdatedAt)) return stale();
  if (row.status !== "decided") {
    return {
      ok: false,
      code: "conflict",
      message: "Only a decided row can be written back.",
      fields: { status: "Only a decided row can be written back." },
    };
  }
  return afterWrite(row, await writeDecisionBack(row));
}

function text(value: string): McpToolResult {
  return { content: [{ type: "text", text: value }] };
}

export async function requestDecisionTool(args: {
  slug: string;
  title: string;
  why?: string;
  options?: { id: string; label: string }[];
  recommended?: string;
}): Promise<McpToolResult> {
  const actor = currentActor();
  if (!actor) return mcpToolError("forbidden", { message: "request_decision requires an authenticated actor." });
  if (typeof args.slug !== "string" || !SLUG_RE.test(args.slug)) {
    return mcpToolError("validation_failed", {
      message: "slug must be a short lowercase id.",
      fields: { slug: "Use letters, digits, _, and -." },
    });
  }
  if (typeof args.title !== "string" || args.title.trim() === "" || args.title.length > 500 || CONTROL.test(args.title)) {
    return mcpToolError("validation_failed", { message: "title is required.", fields: { title: "title is required." } });
  }
  const options = args.options ?? null;
  if (options && options.some((option) => !option.id || !option.label)) {
    return mcpToolError("validation_failed", { message: "Each option needs an id and a label.", fields: { options: "Each option needs an id and a label." } });
  }
  if (args.recommended && options && !options.some((option) => option.id === args.recommended)) {
    return mcpToolError("validation_failed", {
      message: "recommended must be one of the option ids.",
      fields: { recommended: "recommended must be one of the option ids." },
    });
  }
  if (!decisionPersistenceOn()) return text("Demo mode; decision not stored.");
  const result = await upsertDecision({
    key: `agent:${actor.actor_id}:${args.slug}`,
    source: "agent",
    repo: null,
    repo_short: null,
    number: null,
    url: null,
    title: args.title.trim(),
    why: args.why ?? null,
    options,
    recommended: args.recommended ?? null,
    requested_by: actor.actor_id,
    kind: null,
    labels: null,
    opened_at: null,
    first_seen_at: null,
    github_present: null,
    force: false,
  });
  return text(JSON.stringify({ status_held: result.status_held, decision: result.decision }));
}

export async function listDecisionsTool(args: {
  status?: string;
  repo?: string;
  limit?: number;
}): Promise<McpToolResult> {
  if (!decisionPersistenceOn()) return text(JSON.stringify({ demo: true, decisions: [] }));
  const params = new URLSearchParams();
  if (args.status) params.set("status", args.status);
  if (args.repo) params.set("repo", args.repo);
  if (args.limit != null) params.set("limit", String(args.limit));
  const parsed = parseListQuery(params);
  if (!parsed.ok) return mcpToolError(parsed.code, { message: parsed.message, fields: parsed.fields });
  const decisions = await listDecisions(parsed);
  return text(JSON.stringify({ decisions }));
}

export async function resolveDecisionTool(args: {
  id: number;
  status: string;
  decision?: string;
  defer_until?: string;
  option_id?: string;
  expected_updated_at?: string;
}): Promise<McpToolResult> {
  if (!decisionPersistenceOn()) return text("Demo mode; decision not resolved.");
  const actor = currentActor();
  const parsed = parseResolveBody({
    status: args.status,
    ...(args.decision !== undefined ? { decision: args.decision } : {}),
    ...(args.defer_until !== undefined ? { defer_until: args.defer_until } : {}),
    ...(args.option_id !== undefined ? { option_id: args.option_id } : {}),
    ...(args.expected_updated_at !== undefined ? { expected_updated_at: args.expected_updated_at } : {}),
  });
  if (!parsed.ok) return mcpToolError(parsed.code, { message: parsed.message, fields: parsed.fields });
  const outcome = await resolveDecision({ ...parsed.value, id: args.id, actor });
  if (!outcome.ok) return mcpToolError(outcome.code, { message: outcome.message, fields: outcome.fields });
  return text(JSON.stringify({ decision: outcome.decision }));
}
