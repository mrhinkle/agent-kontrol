/**
 * Rolling time windows for Usage and Costs.
 * Computed at request time — never hardcode calendar dates in the UI.
 */

export const USAGE_WINDOWS = ["24h", "7d", "30d"] as const;
export type UsageTimeWindow = (typeof USAGE_WINDOWS)[number];
export const DEFAULT_USAGE_WINDOW: UsageTimeWindow = "7d";

const MS: Record<UsageTimeWindow, number> = {
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
};

export function isUsageWindow(v: string | null | undefined): v is UsageTimeWindow {
  return !!v && (USAGE_WINDOWS as readonly string[]).includes(v);
}

/**
 * Inclusive-since / exclusive-until ISO range ending at `now` (default: Date.now()).
 * Pass a fixed Date in tests for determinism.
 */
export function usageWindowRange(
  window: UsageTimeWindow = DEFAULT_USAGE_WINDOW,
  now: Date = new Date(),
): { since: string; until: string; window: UsageTimeWindow } {
  const untilMs = now.getTime();
  const sinceMs = untilMs - MS[window];
  return {
    window,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
  };
}

/**
 * Resolve window from query params.
 * Prefer `?window=`; else honor explicit `since`+`until`; else default rolling 7d.
 */
export function resolveUsageWindow(params: {
  window?: string | null;
  since?: string | null;
  until?: string | null;
  now?: Date;
}): { since: string; until: string; window: UsageTimeWindow | null } {
  const now = params.now ?? new Date();
  if (isUsageWindow(params.window)) {
    const r = usageWindowRange(params.window, now);
    return { since: r.since, until: r.until, window: r.window };
  }
  if (params.since && params.until) {
    return { since: params.since, until: params.until, window: null };
  }
  const r = usageWindowRange(DEFAULT_USAGE_WINDOW, now);
  return { since: r.since, until: r.until, window: r.window };
}
