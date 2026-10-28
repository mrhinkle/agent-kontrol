/**
 * Pure decision formatting. Safe to import from the dashboard page.
 * The GitHub client and the token live in decision-writeback.ts.
 */

import type { Decision } from "./decisions";

export const DECISION_MARKER = "<!-- agent-kontrol-decision:v1 -->";

const KEY_TARGET = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T|\s)/;

export interface DecisionOption {
  id: string;
  label: string;
}

/** The issue or PR named by `github:<owner/repo>#<n>`. Nothing else is a target. */
export function githubTargetFromKey(key: string): { repo: string; number: number } | null {
  const match = KEY_TARGET.exec(key);
  if (!match) return null;
  return { repo: match[1], number: Number(match[2]) };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Marker stays raw so a decision that contains `&lt;` cannot forge a second marker. */
export function buildDecisionComment(input: { who: string; date: string; text: string }): string {
  return `${DECISION_MARKER} Decision (by ${escapeHtml(input.who)}, ${escapeHtml(input.date)}): ${escapeHtml(input.text)}`;
}

/**
 * A comment counts as this write-back only when it contains the full canonical
 * text. The marker alone does not. When the token's GitHub login is known, a
 * different author does not count either.
 */
export function commentRecordsThisDecision(
  comment: { body: string; author?: string | null },
  expected: string,
  viewer: string | null,
): boolean {
  if (expected.length === 0 || !comment.body.includes(expected)) return false;
  if (viewer && comment.author && comment.author !== viewer) return false;
  return true;
}

/**
 * http(s) url on the row, otherwise the GitHub url implied by the key.
 * `repo` and `number` columns are not read. A `javascript:` url falls through to the key.
 */
export function decisionSourceHref(decision: Pick<Decision, "url" | "key" | "kind">): string | null {
  if (decision.url) {
    try {
      const url = new URL(decision.url);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch {
      /* not a url */
    }
  }
  const target = githubTargetFromKey(decision.key);
  if (!target) return null;
  const kind = decision.kind === "pr" ? "pull" : "issues";
  return `https://github.com/${target.repo}/${kind}/${target.number}`;
}

export function readOptions(value: unknown): DecisionOption[] {
  if (!Array.isArray(value)) return [];
  const out: DecisionOption[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      out.push({ id: item, label: item });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as { id?: unknown }).id;
    const label = (item as { label?: unknown }).label;
    if (typeof id !== "string" || id.length === 0) continue;
    out.push({ id, label: typeof label === "string" && label.length > 0 ? label : id });
  }
  return out;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function realCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/**
 * A date-only value is the end of that UTC day, so "today" is still in the
 * future during the evening. Invalid calendar dates do not roll over.
 * An instant at or before `nowMs` is rejected.
 */
export function parseDeferInstant(
  value: unknown,
  nowMs: number,
): { ok: true; iso: string } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: "defer_until is required when status is deferred." };
  }
  const dateOnly = DATE_ONLY.exec(value);
  let ms: number;
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!realCalendarDate(year, month, day)) {
      return { ok: false, message: "defer_until is not a real calendar date." };
    }
    ms = Date.parse(`${value}T23:59:59.999Z`);
  } else {
    const stamped = ISO_DATE.exec(value);
    if (stamped && !realCalendarDate(Number(stamped[1]), Number(stamped[2]), Number(stamped[3]))) {
      return { ok: false, message: "defer_until is not a real calendar date." };
    }
    ms = Date.parse(value);
    if (Number.isNaN(ms)) return { ok: false, message: "defer_until must be an ISO 8601 timestamp." };
  }
  if (Number.isNaN(ms)) return { ok: false, message: "defer_until must be an ISO 8601 timestamp." };
  if (ms <= nowMs) return { ok: false, message: "defer_until must be in the future." };
  return { ok: true, iso: new Date(ms).toISOString() };
}
