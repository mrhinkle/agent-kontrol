/**
 * Progress board configuration.
 *
 * Adding a repo is ONE entry in progress.config.json - no code changes here.
 * The JSON is validated at module load so a bad entry fails loudly at import
 * time, not silently at render time.
 */
import config from "../../progress.config.json";

/** One repo's entry on the progress board. */
export interface RepoConfig {
  /** owner/name as GitHub knows it */
  repo: string;
  /** display name on the card */
  label: string;
  /** short key used in copy and alerts */
  short: string;
  /** accent used for this repo's line on the history graph */
  color: string;
  /** the label this repo uses for 'scoped but waiting on something'; null
   *  means blocked work is not tracked there, which the board says out loud
   *  rather than reporting a comforting 0% */
  blockedLabel: string | null;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function fail(entry: unknown, problem: string): never {
  throw new Error(
    `progress.config.json: ${problem}${
      entry === undefined ? "" : ` (entry: ${JSON.stringify(entry)})`
    }`,
  );
}

function validate(raw: typeof config): void {
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    fail(undefined, "repos must be a non-empty array");
  }
  const seenRepos = new Set<string>();
  const seenShorts = new Set<string>();
  for (const entry of raw.repos) {
    const name =
      typeof entry?.repo === "string" ? entry.repo : JSON.stringify(entry);
    if (typeof entry.repo !== "string" || !REPO_RE.test(entry.repo)) {
      fail(name, "repo must be owner/name (letters, digits, ., -, _)");
    }
    if (typeof entry.label !== "string" || entry.label.length === 0) {
      fail(name, "label must be a non-empty string");
    }
    if (typeof entry.short !== "string" || entry.short.length === 0) {
      fail(name, "short must be a non-empty string");
    }
    if (typeof entry.color !== "string" || !COLOR_RE.test(entry.color)) {
      fail(name, "color must be a #rrggbb hex string");
    }
    if (
      entry.blockedLabel !== null &&
      typeof entry.blockedLabel !== "string"
    ) {
      fail(name, "blockedLabel must be a string or null");
    }
    if (seenRepos.has(entry.repo)) {
      fail(name, `duplicate repo "${entry.repo}"`);
    }
    if (seenShorts.has(entry.short)) {
      fail(name, `duplicate short "${entry.short}"`);
    }
    seenRepos.add(entry.repo);
    seenShorts.add(entry.short);
  }
  if (typeof raw.laneBotPrefix !== "string") {
    fail(undefined, "laneBotPrefix must be a string");
  }
}

validate(config);

/** The repos the board tracks, in board order. */
export const REPOS: RepoConfig[] = config.repos.map((entry) => ({
  repo: entry.repo,
  label: entry.label,
  short: entry.short,
  color: entry.color,
  blockedLabel: entry.blockedLabel,
}));

/** Look up one repo's config by its owner/name. */
export function repoConfig(repo: string): RepoConfig | undefined {
  return REPOS.find((r) => r.repo === repo);
}

/** Prefix for bot-authored lane branches, from progress.config.json. */
export const LANE_BOT_PREFIX: string = config.laneBotPrefix;

/**
 * Thresholds. Each one is the line past which the board says something out
 * loud in "Needs you" - every number here is a claim you can argue with, which
 * is the point of keeping them in one place.
 */
export const THRESHOLDS = {
  /** open issues labelled dependency-blocked, as a share of open issues */
  blockedRatio: 0.4,
  /** consecutive daily snapshots with net_backlog > 0 before it's an alert */
  backlogGrowingDays: 3,
  /** an open PR with green checks and no state change for this long is stalled */
  stalledPrHours: 24,
  /** mean review invocations per merged PR */
  reviewRounds: 3.0,
  /** share of review rounds that returned no parseable verdict */
  noVerdictRate: 0.15,
} as const;

export const WINDOWS = ["24h", "7d", "30d", "90d"] as const;
export type TimeWindow = (typeof WINDOWS)[number];

export function windowDays(w: TimeWindow): number {
  return { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[w];
}

export function isWindow(v: string | null): v is TimeWindow {
  return !!v && (WINDOWS as readonly string[]).includes(v);
}
