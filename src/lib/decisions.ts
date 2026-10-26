import { sql } from "./db";

/**
 * The decisions queue.
 *
 * Rows are upserted by `key`. A collector that sees the same GitHub label
 * again bumps `last_seen_at` and does not reopen a decided or deferred row
 * unless `force` is true. A withdrawn row comes back to `open` when the
 * label returns. A github-label row whose issue closed or lost the label
 * becomes `withdrawn`, including a decided row. The stored decision text,
 * `decided_by`, and `decided_at` stay. `github_present` goes false, so the
 * morning brief can be rebuilt from this table.
 */

export const DECISION_STATUSES = ["open", "decided", "deferred", "withdrawn"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const LIST_STATUSES = [...DECISION_STATUSES, "all"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

/** `row` is the queue. `brief` is `morning-brief.sh --json .decisions`. */
export const LIST_SHAPES = ["row", "brief"] as const;
export type ListShape = (typeof LIST_SHAPES)[number];

export interface Decision {
  id: number;
  key: string;
  source: string;
  repo: string | null;
  repo_short: string | null;
  number: number | null;
  url: string | null;
  title: string;
  why: string | null;
  options: unknown;
  recommended: string | null;
  requested_by: string | null;
  status: string;
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  defer_until: string | null;
  kind: "issue" | "pr" | null;
  labels: string[];
  opened_at: string | null;
  github_present: boolean | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  /** Whole days from opened_at (else first_seen_at) to now. Same floor as morning-brief.sh. */
  age_days: number;
}

/** One element of `morning-brief.sh --json .decisions`. */
export interface BriefDecision {
  /** Canonical `owner/name`. The brief joins on this, not on the short name. */
  repo: string;
  /** Config short name. Display only. */
  repo_short: string;
  number: number;
  title: string;
  url: string;
  kind: "issue" | "pr";
  age_hours: number;
  age_days: number;
  labels: string[];
}

export interface GhLabel {
  name?: string;
}

/** A `gh issue list` or `gh pr list` row. PRs have `isDraft`; issues do not. */
export interface GhItem {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels?: GhLabel[] | null;
  isDraft?: boolean;
}

export interface UpsertInput {
  key: string;
  source: string;
  repo: string | null;
  repo_short: string | null;
  number: number | null;
  url: string | null;
  title: string;
  why: string | null;
  options: unknown | null;
  recommended: string | null;
  requested_by: string | null;
  kind: "issue" | "pr" | null;
  labels: string[] | null;
  opened_at: string | null;
  first_seen_at: string | null;
  github_present: boolean | null;
  force: boolean;
}

export interface PatchInput {
  status?: DecisionStatus;
  decision?: string | null;
  setDecision: boolean;
  decided_by?: string | null;
  setDecidedBy: boolean;
  defer_until?: string | null;
  setDefer: boolean;
}

export interface ReconcileInput {
  repo: string;
  source: string;
  seen_keys: string[];
}

export type ParseFail = {
  ok: false;
  code: "missing_field" | "validation_failed";
  message: string;
  fields: Record<string, string>;
};

const KEY_RE = /^[A-Za-z0-9_.:/#-]{1,300}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(code: ParseFail["code"], fields: Record<string, string>): ParseFail {
  const message = Object.values(fields)[0] ?? (code === "missing_field" ? "a required field is missing" : "validation failed");
  return { ok: false, code, message, fields };
}

export function isDecisionStatus(value: string): value is DecisionStatus {
  return (DECISION_STATUSES as readonly string[]).includes(value);
}

/** Same wildcard rule as morning-brief.sh: `owner-gate-*` matches a prefix, anything else is exact. */
export function isDecisionLabel(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
    return pattern === name;
  });
}

export function decisionKey(repo: string, number: number): string {
  return `github:${repo}#${number}`;
}

/**
 * Hours between two ISO timestamps, matching morning-brief.sh:
 * fractional seconds before `Z` are dropped, then the unix-second difference is divided by 3600.
 */
export function hoursBetween(earlierIso: string, laterIso: string): number {
  const seconds = (iso: string) => {
    const stripped = iso.replace(/\.[0-9]+(?=Z$)/, "");
    const ms = Date.parse(stripped);
    if (Number.isNaN(ms)) return Number.NaN;
    return Math.trunc(ms / 1000);
  };
  return (seconds(laterIso) - seconds(earlierIso)) / 3600;
}

export function ageDays(openedIso: string, nowIso: string): number {
  return Math.floor(hoursBetween(openedIso, nowIso) / 24);
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string");
    } catch {
      return [];
    }
  }
  return [];
}

function asId(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}

export function presentDecision(row: Record<string, unknown>, nowIso: string): Decision {
  const opened = iso(row.opened_at) ?? iso(row.first_seen_at) ?? nowIso;
  const kind = row.kind === "pr" || row.kind === "issue" ? row.kind : null;
  const github = row.github_present;
  return {
    id: asId(row.id),
    key: String(row.key ?? ""),
    source: String(row.source ?? ""),
    repo: row.repo == null ? null : String(row.repo),
    repo_short: row.repo_short == null ? null : String(row.repo_short),
    number: row.number == null ? null : Number(row.number),
    url: row.url == null ? null : String(row.url),
    title: String(row.title ?? ""),
    why: row.why == null ? null : String(row.why),
    options: row.options ?? null,
    recommended: row.recommended == null ? null : String(row.recommended),
    requested_by: row.requested_by == null ? null : String(row.requested_by),
    status: String(row.status ?? "open"),
    decision: row.decision == null ? null : String(row.decision),
    decided_by: row.decided_by == null ? null : String(row.decided_by),
    decided_at: iso(row.decided_at),
    defer_until: iso(row.defer_until),
    kind,
    labels: asLabels(row.labels),
    opened_at: iso(row.opened_at),
    github_present: typeof github === "boolean" ? github : null,
    first_seen_at: iso(row.first_seen_at) ?? nowIso,
    last_seen_at: iso(row.last_seen_at) ?? nowIso,
    created_at: iso(row.created_at) ?? nowIso,
    updated_at: iso(row.updated_at) ?? nowIso,
    age_days: ageDays(opened, nowIso),
  };
}

/**
 * Rows the brief can show from the table alone: GitHub-sourced, still carrying
 * the label (`github_present` is not false), and not withdrawn. Oldest first,
 * which is `sort_by(-.age_hours)` in morning-brief.sh. `repo` is `owner/name`.
 * `repo_short` is the display name and is not a join key.
 */
export function toBriefDecisions(rows: readonly Decision[], nowIso: string): BriefDecision[] {
  const brief: BriefDecision[] = [];
  for (const row of rows) {
    if (row.source !== "github-label") continue;
    if (row.status === "withdrawn") continue;
    if (row.github_present === false) continue;
    if (row.number == null || !Number.isFinite(row.number)) continue;
    const opened = row.opened_at ?? row.first_seen_at;
    const age_hours = hoursBetween(opened, nowIso);
    const repo = row.repo ?? "";
    const repo_short = row.repo_short ?? (row.repo?.split("/")[1] ?? row.repo ?? "");
    brief.push({
      repo,
      repo_short,
      number: row.number,
      title: row.title,
      url: row.url ?? "",
      kind: row.kind === "pr" ? "pr" : "issue",
      age_hours,
      age_days: Math.floor(age_hours / 24),
      labels: row.labels,
    });
  }
  brief.sort((a, b) => b.age_hours - a.age_hours || a.repo.localeCompare(b.repo) || a.number - b.number);
  return brief;
}

/** What `GET /api/decisions` returns in `decisions`. `brief` is the morning-brief list. */
export function decisionListBody(
  shape: ListShape,
  rows: readonly Decision[],
  nowIso: string,
): Decision[] | BriefDecision[] {
  if (shape === "brief") return toBriefDecisions(rows, nowIso);
  return [...rows];
}

function decisionLabelsOf(item: GhItem, patterns: readonly string[]): string[] {
  return (item.labels ?? [])
    .map((label) => label.name)
    .filter((name): name is string => typeof name === "string" && isDecisionLabel(name, patterns));
}

/** True when `gh` included `isDraft`, which is how morning-brief.sh tells a PR from an issue. */
export function ghKind(item: GhItem): "issue" | "pr" {
  return Object.prototype.hasOwnProperty.call(item, "isDraft") ? "pr" : "issue";
}

/** The POST body `scripts/collect-progress.sh` sends for one labeled issue or PR. */
export function collectorDecisionBody(
  item: GhItem,
  repo: string,
  short: string,
  patterns: readonly string[],
): UpsertInput {
  const labels = decisionLabelsOf(item, patterns);
  return {
    key: decisionKey(repo, item.number),
    source: "github-label",
    repo,
    repo_short: short,
    number: item.number,
    url: item.url,
    title: item.title,
    why: labels.join(", "),
    options: null,
    recommended: null,
    requested_by: "collector",
    kind: ghKind(item),
    labels,
    opened_at: item.createdAt,
    first_seen_at: item.createdAt,
    github_present: true,
    force: false,
  };
}

/**
 * Status a re-seen key lands on. Decided and deferred stay put unless force.
 * Withdrawn reopens, because the label is back. A new key is open.
 */
export function nextStatusOnUpsert(current: DecisionStatus | null, force: boolean): DecisionStatus {
  if (current == null) return "open";
  if (force && (current === "decided" || current === "deferred")) return "open";
  if (current === "decided" || current === "deferred") return current;
  return "open";
}

function optionalString(value: unknown, field: string, max: number, fields: Record<string, string>): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") {
    fields[field] = `${field} must be a string.`;
    return undefined;
  }
  if (value.length > max) {
    fields[field] = `${field} is too long.`;
    return undefined;
  }
  if (CONTROL.test(value)) {
    fields[field] = `${field} must not contain control characters.`;
    return undefined;
  }
  return value;
}

function optionalTimestamp(value: unknown, field: string, fields: Record<string, string>): string | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fields[field] = `${field} must be an ISO 8601 timestamp.`;
    return undefined;
  }
  return new Date(value).toISOString();
}

export function parseUpsert(body: unknown): { ok: true; value: UpsertInput } | ParseFail {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("validation_failed", { body: "Send a JSON object." });
  }
  const raw = body as Record<string, unknown>;
  const fields: Record<string, string> = {};
  if (typeof raw.key !== "string" || raw.key.length === 0) fields.key = "key is required.";
  else if (!KEY_RE.test(raw.key)) fields.key = "key must be 1 to 300 characters of letters, numbers, and . _ : / # -.";
  if (typeof raw.source !== "string" || raw.source.length === 0) fields.source = "source is required.";
  else if (!SOURCE_RE.test(raw.source)) fields.source = "source must be a short lowercase slug.";
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) fields.title = "title is required.";
  else if (raw.title.length > 500) fields.title = "title is too long.";
  else if (CONTROL.test(raw.title)) fields.title = "title must not contain control characters.";

  let repo: string | null = null;
  if (raw.repo != null) {
    if (typeof raw.repo !== "string" || !REPO_RE.test(raw.repo)) fields.repo = "repo must be owner/name.";
    else repo = raw.repo;
  }
  const repoShort = optionalString(raw.repo_short ?? null, "repo_short", 64, fields);
  let number: number | null = null;
  if (raw.number != null) {
    if (typeof raw.number !== "number" || !Number.isInteger(raw.number) || raw.number < 1 || raw.number > 2_000_000_000) {
      fields.number = "number must be a positive integer.";
    } else number = raw.number;
  }
  const url = optionalString(raw.url ?? null, "url", 2000, fields);
  const why = optionalString(raw.why ?? null, "why", 8000, fields);
  const recommended = optionalString(raw.recommended ?? null, "recommended", 100, fields);
  const requestedBy = optionalString(raw.requested_by ?? null, "requested_by", 200, fields);
  const openedAt = optionalTimestamp(raw.opened_at ?? null, "opened_at", fields);
  const firstSeen = optionalTimestamp(raw.first_seen_at ?? null, "first_seen_at", fields);

  let kind: "issue" | "pr" | null = null;
  if (raw.kind != null) {
    if (raw.kind !== "issue" && raw.kind !== "pr") fields.kind = "kind must be issue or pr.";
    else kind = raw.kind;
  }
  let labels: string[] | null = null;
  if (raw.labels != null) {
    if (!Array.isArray(raw.labels) || raw.labels.length > 30 || raw.labels.some((item) => typeof item !== "string" || item.length < 1 || item.length > 100 || CONTROL.test(item))) {
      fields.labels = "labels must be a list of up to 30 short strings.";
    } else labels = raw.labels as string[];
  }
  let options: unknown | null = null;
  if (raw.options != null) {
    const encoded = JSON.stringify(raw.options);
    if (!Array.isArray(raw.options) || raw.options.length > 20 || encoded.length > 8000) {
      fields.options = "options must be a JSON array of at most 20 items.";
    } else options = raw.options;
  }
  let githubPresent: boolean | null = null;
  if (raw.github_present != null) {
    if (typeof raw.github_present !== "boolean") fields.github_present = "github_present must be true or false.";
    else githubPresent = raw.github_present;
  }
  let force = false;
  if (raw.force != null) {
    if (typeof raw.force !== "boolean") fields.force = "force must be true or false.";
    else force = raw.force;
  }

  if (Object.keys(fields).length > 0) {
    const missing = ["key", "source", "title"].some((name) => fields[name]?.endsWith("is required."));
    return fail(missing ? "missing_field" : "validation_failed", fields);
  }
  if (githubPresent == null && raw.source === "github-label") githubPresent = true;
  return {
    ok: true,
    value: {
      key: raw.key as string,
      source: raw.source as string,
      repo,
      repo_short: repoShort ?? null,
      number,
      url: url ?? null,
      title: (raw.title as string).trim(),
      why: why ?? null,
      options,
      recommended: recommended ?? null,
      requested_by: requestedBy ?? null,
      kind,
      labels,
      opened_at: openedAt ?? null,
      first_seen_at: firstSeen ?? null,
      github_present: githubPresent,
      force,
    },
  };
}

export function parseReconcile(body: unknown): { ok: true; value: ReconcileInput } | ParseFail {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("validation_failed", { body: "Send a JSON object." });
  }
  const raw = body as Record<string, unknown>;
  const reconcile = raw.reconcile;
  if (!reconcile || typeof reconcile !== "object" || Array.isArray(reconcile)) {
    return fail("validation_failed", { reconcile: "reconcile must be an object." });
  }
  const rec = reconcile as Record<string, unknown>;
  const fields: Record<string, string> = {};
  if (typeof rec.repo !== "string" || !REPO_RE.test(rec.repo)) fields.repo = "repo must be owner/name.";
  const source = rec.source == null ? "github-label" : rec.source;
  if (typeof source !== "string" || !SOURCE_RE.test(source)) fields.source = "source must be a short lowercase slug.";
  if (!Array.isArray(rec.seen_keys) || rec.seen_keys.length > 5000) {
    fields.seen_keys = "seen_keys must be an array of at most 5000 keys.";
  } else if (rec.seen_keys.some((key) => typeof key !== "string" || !KEY_RE.test(key))) {
    fields.seen_keys = "every seen key must be a short key string.";
  } else if (typeof rec.repo === "string" && rec.seen_keys.some((key) => typeof key === "string" && !key.startsWith(`github:${rec.repo}#`))) {
    fields.seen_keys = "every seen key must belong to this repo.";
  }
  if (Object.keys(fields).length > 0) return fail("validation_failed", fields);
  return {
    ok: true,
    value: {
      repo: rec.repo as string,
      source: source as string,
      seen_keys: rec.seen_keys as string[],
    },
  };
}

export function parsePatch(body: unknown): { ok: true; value: PatchInput } | ParseFail {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("validation_failed", { body: "Send a JSON object." });
  }
  const raw = body as Record<string, unknown>;
  const setDecision = Object.prototype.hasOwnProperty.call(raw, "decision");
  const setDecidedBy = Object.prototype.hasOwnProperty.call(raw, "decided_by");
  const setDefer = Object.prototype.hasOwnProperty.call(raw, "defer_until");
  const hasStatus = Object.prototype.hasOwnProperty.call(raw, "status");
  if (!hasStatus && !setDecision && !setDecidedBy && !setDefer) {
    return fail("missing_field", { body: "Send status, decision, decided_by, or defer_until." });
  }
  const fields: Record<string, string> = {};
  let status: DecisionStatus | undefined;
  if (hasStatus) {
    if (typeof raw.status !== "string" || !isDecisionStatus(raw.status)) {
      fields.status = "status must be open, decided, deferred, or withdrawn.";
    } else status = raw.status;
  }
  const decision = setDecision ? optionalString(raw.decision, "decision", 8000, fields) : undefined;
  const decidedBy = setDecidedBy ? optionalString(raw.decided_by, "decided_by", 200, fields) : undefined;
  const deferUntil = setDefer ? optionalTimestamp(raw.defer_until, "defer_until", fields) : undefined;
  if (status === "decided" && (decision == null || decision.trim() === "")) {
    fields.decision = "A decided row needs the decision text.";
  }
  if (status === "deferred" && (deferUntil == null || deferUntil === "")) {
    fields.defer_until = "defer_until is required when status is deferred.";
  }
  if (Object.keys(fields).length > 0) return fail("validation_failed", fields);
  return {
    ok: true,
    value: {
      status,
      decision: decision ?? null,
      setDecision,
      decided_by: decidedBy ?? null,
      setDecidedBy,
      defer_until: deferUntil ?? null,
      setDefer,
    },
  };
}

export function parseDecisionId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export function parseListQuery(params: URLSearchParams): { ok: true; status: ListStatus; repo: string | null; source: string | null; limit: number; shape: ListShape } | ParseFail {
  const shapeRaw = params.get("shape") ?? "row";
  if (!(LIST_SHAPES as readonly string[]).includes(shapeRaw)) {
    return fail("validation_failed", { shape: "shape must be row or brief." });
  }
  const statusRaw = params.get("status") ?? "open";
  if (!(LIST_STATUSES as readonly string[]).includes(statusRaw)) {
    return fail("validation_failed", { status: "status must be open, decided, deferred, withdrawn, or all." });
  }
  const repoRaw = params.get("repo");
  if (repoRaw != null && !REPO_RE.test(repoRaw)) {
    return fail("validation_failed", { repo: "repo must be owner/name." });
  }
  const sourceRaw = params.get("source");
  if (sourceRaw != null && !SOURCE_RE.test(sourceRaw)) {
    return fail("validation_failed", { source: "source must be a short lowercase slug." });
  }
  const limitRaw = params.get("limit");
  let limit = 500;
  if (limitRaw != null) {
    if (!/^[1-9][0-9]{0,3}$/.test(limitRaw) || Number(limitRaw) > 1000) {
      return fail("validation_failed", { limit: "limit must be an integer from 1 to 1000." });
    }
    limit = Number(limitRaw);
  }
  return {
    ok: true,
    status: statusRaw as ListStatus,
    repo: repoRaw,
    source: sourceRaw,
    limit,
    shape: shapeRaw as ListShape,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function listDecisions(query: {
  status: ListStatus;
  repo: string | null;
  source: string | null;
  limit: number;
  /** `brief` selects the morning-brief population and ignores status and source. */
  shape?: ListShape;
}): Promise<Decision[]> {
  const db = sql();
  const now = nowIso();
  const brief = query.shape === "brief";
  const rows = await db`
    select * from decisions
    where (
      case
        when ${brief} is true then (
          status <> 'withdrawn'
          and github_present is distinct from false
          and number is not null
        )
        when ${query.status} = 'all' then true
        when ${query.status} = 'open' then
          status = 'open'
          or (status = 'deferred' and defer_until is not null and defer_until <= now())
        else status = ${query.status}
      end
    )
    and (${query.repo}::text is null or repo = ${query.repo})
    and (
      case
        when ${brief} is true then source = 'github-label'
        else (${query.source}::text is null or source = ${query.source})
      end
    )
    order by first_seen_at asc, id asc
    limit ${query.limit}
  `;
  return rows.map((row) => presentDecision(row, now));
}

export interface UpsertResult {
  decision: Decision;
  /** True when a decided or deferred row kept its status because force was not set. */
  status_held: boolean;
}

export async function upsertDecision(input: UpsertInput): Promise<UpsertResult> {
  const db = sql();
  const now = nowIso();
  const optionsJson = input.options == null ? null : JSON.stringify(input.options);
  const labelsJson = input.labels == null ? null : JSON.stringify(input.labels);
  const rows = await db`
    with prior as (
      select status from decisions where key = ${input.key}
    ),
    upserted as (
      insert into decisions (
        key, source, repo, number, url, title, why,
        options, recommended, requested_by, status,
        kind, labels, opened_at, repo_short, github_present,
        first_seen_at, last_seen_at, created_at, updated_at
      ) values (
        ${input.key}, ${input.source}, ${input.repo}, ${input.number}, ${input.url}, ${input.title}, ${input.why},
        ${optionsJson}::jsonb, ${input.recommended}, ${input.requested_by}, 'open',
        ${input.kind}, ${labelsJson}::jsonb, ${input.opened_at}::timestamptz, ${input.repo_short}, ${input.github_present},
        coalesce(${input.first_seen_at}::timestamptz, ${input.opened_at}::timestamptz, now()),
        now(), now(), now()
      )
      on conflict (key) do update set
        source = excluded.source,
        repo = coalesce(excluded.repo, decisions.repo),
        number = coalesce(excluded.number, decisions.number),
        url = coalesce(excluded.url, decisions.url),
        title = excluded.title,
        why = coalesce(excluded.why, decisions.why),
        options = coalesce(excluded.options, decisions.options),
        recommended = coalesce(excluded.recommended, decisions.recommended),
        requested_by = coalesce(decisions.requested_by, excluded.requested_by),
        kind = coalesce(excluded.kind, decisions.kind),
        labels = coalesce(excluded.labels, decisions.labels),
        opened_at = coalesce(decisions.opened_at, excluded.opened_at),
        repo_short = coalesce(excluded.repo_short, decisions.repo_short),
        github_present = case
          when excluded.github_present is null then decisions.github_present
          else excluded.github_present
        end,
        last_seen_at = now(),
        updated_at = now(),
        status = case
          when ${input.force} is true and decisions.status in ('decided', 'deferred') then 'open'
          when decisions.status = 'decided' then decisions.status
          when decisions.status = 'deferred' then decisions.status
          when decisions.status = 'withdrawn' then 'open'
          else decisions.status
        end,
        decision = case
          when ${input.force} is true and decisions.status in ('decided', 'deferred') then null
          else decisions.decision
        end,
        decided_by = case
          when ${input.force} is true and decisions.status in ('decided', 'deferred') then null
          else decisions.decided_by
        end,
        decided_at = case
          when ${input.force} is true and decisions.status in ('decided', 'deferred') then null
          else decisions.decided_at
        end,
        defer_until = case
          when ${input.force} is true and decisions.status = 'deferred' then null
          when decisions.status = 'withdrawn' then null
          else decisions.defer_until
        end
      returning *
    )
    select upserted.*, prior.status as previous_status
    from upserted
    left join prior on true
  `;
  const row = rows[0];
  if (!row) throw new Error("decision upsert returned no row");
  const previous = typeof row.previous_status === "string" ? row.previous_status : null;
  const decision = presentDecision(row, now);
  const held =
    (previous === "decided" && decision.status === "decided") ||
    (previous === "deferred" && decision.status === "deferred");
  return { decision, status_held: held };
}

export interface ReconcileResult {
  reconciled: number;
  withdrawn: number;
}

/**
 * Mark GitHub rows for one repo that were not in this sweep.
 * The issue closed or lost the label, so open, deferred, and decided rows
 * become withdrawn. The stored decision text, decided_by, and decided_at stay.
 * A row already withdrawn with github_present false is left alone.
 */
export async function reconcileDecisions(input: ReconcileInput): Promise<ReconcileResult> {
  const db = sql();
  const seenJson = JSON.stringify(input.seen_keys);
  const rows = await db`
    update decisions
    set
      github_present = false,
      updated_at = now(),
      status = case when status in ('open', 'deferred', 'decided') then 'withdrawn' else status end,
      defer_until = case when status in ('open', 'deferred') then null else defer_until end
    where source = ${input.source}
      and repo = ${input.repo}
      and not (key in (select jsonb_array_elements_text(${seenJson}::jsonb)))
      and (github_present is distinct from false or status in ('open', 'deferred', 'decided'))
    returning id, status
  `;
  return {
    reconciled: rows.length,
    withdrawn: rows.filter((row) => row.status === "withdrawn").length,
  };
}

export async function patchDecision(id: number, input: PatchInput): Promise<Decision | null> {
  const db = sql();
  const now = nowIso();
  const status = input.status ?? null;
  const rows = await db`
    update decisions
    set
      status = coalesce(${status}, status),
      decision = case
        when ${status} = 'open' then null
        when ${input.setDecision} then ${input.decision ?? null}
        else decision
      end,
      decided_by = case
        when ${status} = 'open' then null
        when ${input.setDecidedBy} then ${input.decided_by ?? null}
        else decided_by
      end,
      decided_at = case
        when ${status} = 'decided' then now()
        when ${status} = 'open' then null
        else decided_at
      end,
      defer_until = case
        when ${status} = 'deferred' then ${input.defer_until ?? null}::timestamptz
        when ${status} in ('open', 'withdrawn', 'decided') then null
        when ${input.setDefer} then ${input.defer_until ?? null}::timestamptz
        else defer_until
      end,
      github_present = case
        when ${status} = 'withdrawn' then false
        else github_present
      end,
      updated_at = now()
    where id = ${id}
    returning *
  `;
  const row = rows[0];
  if (!row) return null;
  return presentDecision(row, now);
}
