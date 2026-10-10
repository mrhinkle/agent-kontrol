/**
 * Automatic session notes: when a session ends, Agent Kontrol writes one short
 * note to shared memory so the next agent can `recall` who worked where, for how
 * long, and what went wrong. Pure functions here; the database side is in
 * session-memory.ts.
 *
 * The note is built only from facts the fleet already recorded. No model is
 * called. Raw prompt text is excluded unless MC_MEMORY_WRITEBACK_PROMPTS=1,
 * because every agent that can `recall` can read the note.
 */
import { formatDuration } from "./traces";

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

/** Off unless MC_MEMORY_WRITEBACK_PROMPTS=1. */
export function includePrompts(): boolean {
  const v = process.env.MC_MEMORY_WRITEBACK_PROMPTS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Days to keep automatic notes. Default 30. */
export function writebackDays(): number {
  const n = Number(process.env.MC_MEMORY_WRITEBACK_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
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

/**
 * Build the note, or null when the session was too thin to be worth remembering
 * (under two minutes with no tool calls and no reported milestones).
 */
export function buildSessionNote(f: SessionFacts, opts: { includePrompts?: boolean } = {}): SessionNote | null {
  const withPrompts = opts.includePrompts === true;
  const startMs = f.started_at ? Date.parse(f.started_at) : NaN;
  const endMs = f.ended_at ? Date.parse(f.ended_at) : NaN;
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;

  const milestones = f.milestones.filter((m) => isUsefulTitle(m, withPrompts));
  const toolTotal = f.tools.reduce((n, t) => n + t.count, 0);
  if (toolTotal === 0 && milestones.length === 0 && (durationMs === null || durationMs < 120_000)) return null;

  const who = f.display_name?.trim() || f.agent_id;
  const lines: string[] = [];
  lines.push(
    `Session summary (automatic): ${who}${f.platform ? ` [${f.platform}]` : ""}${f.project ? ` on ${f.project}` : ""}.`,
  );
  const outcome = f.status === "failed" ? "failed" : "done";
  lines.push(`Outcome: ${outcome}.${durationMs !== null ? ` Ran ${formatDuration(durationMs)}.` : ""}${f.ended_at ? ` Ended ${f.ended_at}.` : ""}`);
  lines.push(`Events: ${f.event_count}, errors: ${f.error_count}.`);
  if (f.tools.length > 0) {
    const parts = f.tools
      .slice(0, 8)
      .map((t) => `${t.name}×${t.count}${t.failed > 0 ? ` (${t.failed} failed)` : ""}`)
      .join(", ");
    lines.push(`Tools: ${parts}.`);
  }
  if (f.summary && isUsefulTitle(f.summary, withPrompts)) lines.push(`Last summary: ${f.summary.trim().slice(0, 200)}`);
  if (milestones.length > 0) {
    lines.push("Reported:");
    for (const m of milestones.slice(-5)) lines.push(`- ${m.trim().slice(0, 160)}`);
  }

  const tags = ["session-summary"];
  if (f.platform) tags.push(slug(f.platform));
  if (f.project) tags.push(slug(f.project));
  return { key: `session/${f.session_id}`.slice(0, 200), content: lines.join("\n").slice(0, MAX_NOTE), tags: [...new Set(tags.filter(Boolean))] };
}
