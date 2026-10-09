import type { Event, FleetAgent, Session } from "./types";
import { isBackground } from "./events";

const PLATFORM_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "cowork-cloud": "Cowork (cloud)",
  "cowork-local": "Cowork (local)",
  "chatgpt-work": "ChatGPT Work",
  codex: "Codex",
  grok: "Grok",
  hermes: "Hermes",
};

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/** Event kinds whose titles are boilerplate ("Session started in ~/x", "Session ended"). */
const GENERIC_KINDS = new Set(["session_start", "session_end", "session_started", "session_ended"]);

const ROLLOUT = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/;

/** True for ids that read as machine noise: Codex rollout files, UUIDs, timestamped run ids. */
export function looksLikeRawId(text: string): boolean {
  const t = text.trim();
  return (
    ROLLOUT.test(t) ||
    /^(?:[a-z]+-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t) ||
    /^\d{8}_\d{6}_[a-z0-9]+$/i.test(t)
  );
}

/** Shorten a raw id for a secondary label: keep the start and the end. */
export function shortId(id: string, keep = 8): string {
  const m = ROLLOUT.exec(id);
  const core = m ? id.slice(m[0].length) : id;
  if (core.length <= keep * 2 + 1) return core;
  return `${core.slice(0, keep)}…${core.slice(-4)}`;
}

/**
 * Lifecycle boilerplate that collectors write as a summary or event title
 * ("codex session active", "Turn finished — waiting for input", "stop"). It says
 * nothing about the work, so it never becomes a headline.
 */
export function isPlaceholder(text: string): boolean {
  const t = text.trim();
  return (
    !t ||
    looksLikeRawId(t) ||
    /^([\w-]+\s+)?session\s+(active|started|resumed|ended|idle|done|stopped)\b/i.test(t) ||
    /^session (started|ended) in\b/i.test(t) ||
    /^turn (started|finished|ended)\b/i.test(t) ||
    /marking done\.?$/i.test(t) ||
    /^(stop|stopped|idle|done|working|waiting|active|running|ok)\.?$/i.test(t)
  );
}

const MAX_TITLE = 140;

/**
 * Turn an instruction event title into a headline: drop the "New instruction:"
 * prefix and keep the first line, capped. Summaries pass `whole` to keep all of
 * their text (the row clamps it visually and the tooltip shows it in full).
 */
export function cleanTitle(raw: string, whole = false): string | null {
  const text = raw.replace(/^\s*new (instruction|prompt|task):\s*/i, "").trim();
  // Machine payloads (XML-ish notifications, JSON) aren't readable headlines.
  if (!text || /^[<{]/.test(text)) return null;
  const line = (whole ? text : text.split(/\n/)[0]).replace(/\s+/g, " ").trim();
  if (isPlaceholder(line)) return null;
  return !whole && line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

export interface SessionTitle {
  /** What to show as the headline. Never a raw id. */
  title: string;
  /** Where the title came from, for honest styling (summaries are bright, fallbacks dim). */
  source: "summary" | "event" | "fallback";
}

/**
 * A human headline for a session: its summary, else the first meaningful event
 * title in that session, else "<Platform> session in <project>".
 * `events` may contain any events; only this session's are considered.
 */
export function sessionTitle(session: Session, platform: string, events: readonly Event[]): SessionTitle {
  const summary = session.summary ? cleanTitle(session.summary, true) : null;
  if (summary) return { title: summary, source: "summary" };

  const own = events
    .filter((e) => e.session_id === session.id && !isBackground(e) && !GENERIC_KINDS.has(e.kind))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map((e) => ({ kind: e.kind, title: e.title ? cleanTitle(e.title) : null }))
    .filter((e): e is { kind: string; title: string } => e.title !== null);
  // Prefer what the agent was asked to do (first turn) over later status lines.
  const first = own.find((e) => e.kind === "turn_start") ?? own[0];
  if (first) return { title: first.title, source: "event" };

  const where = session.project ? ` in ${session.project}` : "";
  return { title: `${platformName(platform)} session${where}`, source: "fallback" };
}

export interface HistorySession {
  session: Session;
  agentId: string;
  agentName: string;
  platform: string;
  title: SessionTitle;
}

/** All recent sessions (current + recent, de-duplicated), newest first, optionally for one agent. */
export function historySessions(agents: readonly FleetAgent[], events: readonly Event[], agentId: string | null): HistorySession[] {
  const out: HistorySession[] = [];
  for (const a of agents) {
    if (agentId && a.id !== agentId) continue;
    const seen = new Set<string>();
    for (const s of [a.current_session, ...a.recent_sessions]) {
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ session: s, agentId: a.id, agentName: a.display_name ?? a.id, platform: a.platform, title: sessionTitle(s, a.platform, events) });
    }
  }
  return out.sort((x, y) => (y.session.updated_at > x.session.updated_at ? 1 : y.session.updated_at < x.session.updated_at ? -1 : 0));
}

export function filterEvents(events: readonly Event[], opts: { agentId: string | null; hideBackground: boolean }): Event[] {
  return events.filter((e) => (!opts.agentId || e.agent_id === opts.agentId) && (!opts.hideBackground || !isBackground(e)));
}

export interface Page<T> {
  items: T[];
  page: number; // 1-based, clamped
  pages: number; // at least 1
  total: number;
  from: number; // 1-based index of first item, 0 when empty
  to: number;
}

export function paginate<T>(items: readonly T[], page: number, size: number): Page<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, size)));
  const p = Math.min(Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)), pages);
  const start = (p - 1) * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: p, pages, total, from: total ? start + 1 : 0, to: start + slice.length };
}

const OPEN_STATUSES = new Set(["active", "waiting", "running"]);

/**
 * Session duration as "42m", "3h 5m", or "42m, running". Only open sessions run:
 * an error marks a session failed without setting ended_at, so a closed session
 * with no ended_at ends at its last update instead of growing forever.
 */
export function sessionSpan(s: Session, now: number): string {
  const running = !s.ended_at && OPEN_STATUSES.has(s.status);
  const start = new Date(s.started_at).getTime();
  const end = new Date(s.ended_at ?? (running ? new Date(now).toISOString() : s.updated_at)).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const mins = Math.max(0, Math.round((end - start) / 60_000));
  const span = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return running ? `${span}, running` : span;
}
