/**
 * Automatic session notes: when a session ends, Agent Kontrol writes one short
 * note to shared memory so the next agent can `recall` who worked where, for how
 * long, and what went wrong. Pure functions here; the database side is in
 * session-memory.ts.
 *
 * The note is built only from facts the fleet already recorded. No model is
 * called. By default it holds structured facts only: who, where, how long, the
 * outcome, counts and tool names. Free text that agents reported (titles and
 * summaries) is added only when MC_MEMORY_WRITEBACK_TEXT=1, redacted, and text
 * derived from a prompt only when MC_MEMORY_WRITEBACK_PROMPTS=1 as well. Every
 * agent that can `recall` can read these notes, so the default is conservative.
 */
import { createHash } from "node:crypto";
import { formatDuration, parseWholeDays, redactText } from "./traces";

export interface SessionFacts {
  session_id: string;
  agent_id: string;
  display_name: string | null;
  platform: string | null;
  project: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  event_count: number;
  error_count: number;
  tools: { name: string; count: number; failed: number }[];
  /** Titles of events the agent or adapter reported on purpose (milestones and statuses), in order. */
  milestones: string[];
  /** The session's last one-line summary, if any. */
  summary: string | null;
}

export interface SessionNote {
  key: string;
  content: string;
  tags: string[];
}

/** On unless MC_MEMORY_WRITEBACK=0. */
export function writebackEnabled(): boolean {
  return process.env.MC_MEMORY_WRITEBACK?.trim() !== "0";
}

/** Off unless MC_MEMORY_WRITEBACK_TEXT=1: add the free text agents reported (milestones, summary). */
export function includeText(): boolean {
  const v = process.env.MC_MEMORY_WRITEBACK_TEXT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Off unless MC_MEMORY_WRITEBACK_PROMPTS=1 (and only with text on): keep prompt-derived titles. */
export function includePrompts(): boolean {
  const v = process.env.MC_MEMORY_WRITEBACK_PROMPTS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Days to keep automatic notes. Default 30. */
export function writebackDays(): number {
  return parseWholeDays(process.env.MC_MEMORY_WRITEBACK_DAYS, 30);
}

const PROMPT_TITLE = /^New instruction\b/i;
const GENERIC_PREFIX = /^(session started|session ended|turn finished|heartbeat)/i;
const GENERIC_EXACT = /^(precompact|subagentstop|pretooluse|posttooluse|stop|sessionstart|sessionend|userpromptsubmit|notification|status)$/i;

/** Titles every adapter emits mechanically carry no information worth a note. */
export function isUsefulTitle(title: string | null | undefined, withPrompts: boolean): title is string {
  const t = (title ?? "").trim();
  if (!t) return false;
  if (!withPrompts && PROMPT_TITLE.test(t)) return false;
  return !GENERIC_PREFIX.test(t) && !GENERIC_EXACT.test(t);
}

function slug(s: string, max = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}

const MAX_NOTE = 1500;

/** The memory key for a session. Long ids keep a hash suffix so two ids with a shared prefix never collide. */
export function sessionKey(sessionId: string): string {
  const prefix = "session/";
  if (sessionId.length <= 150) return prefix + sessionId;
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `${prefix}${sessionId.slice(0, 150)}~${hash}`;
}

/**
 * Counts come from aggregates over possibly partial data, so a negative,
 * fractional, NaN or infinite value is a recording artifact, not a fact. Clamp
 * to a non-negative whole number before it can reach the note or the
 * thin-session check (a fractional total must not make an empty session look busy).
 */
function wholeCount(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

/**
 * Build the note, or null when the session was too thin to be worth remembering
 * (under two minutes with no tool calls and nothing reported).
 */
export function buildSessionNote(
  f: SessionFacts,
  opts: { includeText?: boolean; includePrompts?: boolean } = {},
): SessionNote | null {
  const withText = opts.includeText === true;
  const withPrompts = withText && opts.includePrompts === true;
  const startMs = f.started_at ? Date.parse(f.started_at) : NaN;
  const endMs = f.ended_at ? Date.parse(f.ended_at) : NaN;
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;

  const milestones = f.milestones.filter((m) => isUsefulTitle(m, withPrompts));
  const toolTotal = f.tools.reduce((n, t) => n + wholeCount(t.count), 0);
  if (toolTotal === 0 && milestones.length === 0 && (durationMs === null || durationMs < 120_000)) return null;

  const who = redactText(f.display_name?.trim() || f.agent_id, 80);
  const lines: string[] = [];
  lines.push(
    `Session summary (automatic): ${who}${f.platform ? ` [${redactText(f.platform, 40)}]` : ""}${f.project ? ` on ${redactText(f.project, 80)}` : ""}.`,
  );
  const outcome = f.status === "failed" ? "failed" : "done";
  lines.push(`Outcome: ${outcome}.${durationMs !== null ? ` Ran ${formatDuration(durationMs)}.` : ""}${f.ended_at ? ` Ended ${f.ended_at}.` : ""}`);
  lines.push(`Events: ${wholeCount(f.event_count)}, errors: ${wholeCount(f.error_count)}.`);
  if (f.tools.length > 0) {
    const parts = f.tools
      .slice(0, 8)
      .map((t) => {
        const count = wholeCount(t.count);
        const failed = wholeCount(t.failed);
        return `${redactText(t.name, 40)}×${count}${failed > 0 ? ` (${failed} failed)` : ""}`;
      })
      .join(", ");
    lines.push(`Tools: ${parts}.`);
  }
  if (milestones.length > 0) lines.push(`Milestones reported: ${milestones.length}.`);
  if (withText) {
    if (f.summary && isUsefulTitle(f.summary, withPrompts)) lines.push(`Last summary: ${redactText(f.summary.trim(), 200)}`);
    if (milestones.length > 0) {
      lines.push("Reported:");
      for (const m of milestones.slice(-5)) lines.push(`- ${redactText(m.trim(), 160)}`);
    }
  }

  const tags = ["session-summary"];
  if (f.platform) tags.push(slug(f.platform));
  if (f.project) tags.push(slug(f.project));
  return { key: sessionKey(f.session_id), content: lines.join("\n").slice(0, MAX_NOTE), tags: [...new Set(tags.filter(Boolean))] };
}
