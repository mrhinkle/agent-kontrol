import type { Event } from "./types";
import { isBackground } from "./events";

export interface FeedItem {
  /** Newest event of the run. */
  event: Event;
  /** How many identical consecutive events this row stands for. */
  count: number;
  /** Oldest event time in the run. */
  oldestAt: string;
}

export interface Feed {
  items: FeedItem[];
  /** Background events (heartbeats, telemetry) left out of `items`. */
  hidden: number;
}

const sameStory = (a: Event, b: Event) =>
  a.agent_id === b.agent_id && a.session_id === b.session_id && a.kind === b.kind && (a.title ?? "").trim() === (b.title ?? "").trim();

/**
 * The live activity feed: newest first, background noise hidden unless asked
 * for, and runs of the same agent repeating the same line ("codex session
 * active" ×14) folded into one row with a count. Only repeats within one
 * session fold, so a new run never hides behind the previous one.
 */
export function buildFeed(events: readonly Event[], opts: { showBackground: boolean; limit: number }): Feed {
  const sorted = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
  let hidden = 0;
  const items: FeedItem[] = [];
  for (const e of sorted) {
    if (!opts.showBackground && isBackground(e)) {
      hidden++;
      continue;
    }
    const last = items[items.length - 1];
    if (last && sameStory(last.event, e)) {
      last.count++;
      last.oldestAt = e.created_at;
      continue;
    }
    items.push({ event: e, count: 1, oldestAt: e.created_at });
  }
  return { items: items.slice(0, opts.limit), hidden };
}
