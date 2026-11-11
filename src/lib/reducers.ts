import { DECISION_LABEL_PATTERNS } from "./progress-config";
import { isDecisionLabel } from "./decisions";
import { SWEEP_CONDITIONS } from "./sweep-logic";
import {
  GitHubCallError,
  GitHubListTruncatedError,
  githubAppConfig,
  githubReadClient,
  installationAuthorizer,
  type GhPull,
  type GitHubAppConfig,
  type GitHubReadClient,
} from "./github-read";
import { githubWriteClient, type GitHubWriteClient } from "./github-write";
import {
  sqlReducerLock,
  sqlTransitionStore,
  type ReducerLock,
  type TransitionRow,
  type TransitionStatus,
  type TransitionSteps,
  type TransitionStore,
} from "./reducer-store";

/**
 * Deterministic reducers (mrhinkle/agent-kontrol#80).
 *
 * Canonical catalogue ids, named here and in the generated docs table:
 * pull_request.opened, pull_request.synchronize, pull_request.ready_for_review,
 * pull_request.closed, issues.closed, issues.labeled, issues.unlabeled, push,
 * check_suite.completed, pull_request_review.submitted, issue_comment.created,
 * plus synthetic sweep: rows from the absence sweeper.
 *
 * A consumer is a string id from CONSUMERS. The runners live outside this module.
 * Nothing here calls a model. Judgment creates a work item and returns.
 * GitHub history is re-read by id. This module does not read the inbox.
 *
 * MC_REDUCERS unset, blank, or 0 is off (no GitHub reads or writes).
 * MC_REDUCERS=dry re-reads and records the plan. MC_REDUCERS=1 or on writes.
 */

export const REDUCER_MAX_ATTEMPTS = 5;
export const REDUCER_BACKOFF_CAP_SECONDS = 600;
const CAUSED_BY_WINDOW_MS = 120_000;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export const CANONICAL_EVENT_IDS = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.ready_for_review",
  "pull_request.closed",
  "issues.closed",
  "issues.labeled",
  "issues.unlabeled",
  "push",
  "check_suite.completed",
  "pull_request_review.submitted",
  "issue_comment.created",
] as const;

export const CONSUMERS = [
  "pr-lifecycle",
  "checks",
  "reviews",
  "branch-update",
  "issues",
  "decisions",
  "sweeper",
] as const;
export type ConsumerId = (typeof CONSUMERS)[number];

export interface CatalogueRow {
  id: string;
  event: string;
  action: string;
  consumer: ConsumerId;
  guard: string;
  transition: string;
  emits: string;
  writes: boolean;
}

const WEBHOOK_CATALOGUE: readonly CatalogueRow[] = [
  { id: "pull_request.opened", event: "pull_request", action: "opened", consumer: "pr-lifecycle", guard: "re-read pull; head matches; draft records no work item", transition: "judgment", emits: "work-item", writes: false },
  { id: "pull_request.synchronize", event: "pull_request", action: "synchronize", consumer: "pr-lifecycle", guard: "re-read pull; drop when head differs from the event", transition: "record-head", emits: "head-moved", writes: false },
  { id: "pull_request.ready_for_review", event: "pull_request", action: "ready_for_review", consumer: "pr-lifecycle", guard: "re-read pull; head matches; not a draft", transition: "judgment", emits: "work-item", writes: false },
  { id: "pull_request.closed", event: "pull_request", action: "closed", consumer: "pr-lifecycle", guard: "re-read closed; missing or still open creates no state", transition: "record-closed", emits: "pr-merged or pr-closed", writes: false },
  { id: "issues.closed", event: "issues", action: "closed", consumer: "issues", guard: "re-read closed; every same-repo blocker closed; marker before comment", transition: "unblock-dependents", emits: "became-unblocked", writes: true },
  { id: "issues.labeled", event: "issues", action: "labeled", consumer: "decisions", guard: "decision label still on the issue", transition: "record-decision-label", emits: "decision-label-added", writes: false },
  { id: "issues.unlabeled", event: "issues", action: "unlabeled", consumer: "decisions", guard: "decision label already absent", transition: "record-decision-label", emits: "decision-label-removed", writes: false },
  { id: "push", event: "push", action: "", consumer: "branch-update", guard: "default branch only; never draft, fork, conflict, protected, or rebase", transition: "update-branch", emits: "update-branch or update-branch-conflict", writes: true },
  { id: "check_suite.completed", event: "check_suite", action: "completed", consumer: "checks", guard: "every required context succeeded at the pinned head", transition: "record-contexts", emits: "contexts-green", writes: false },
  { id: "pull_request_review.submitted", event: "pull_request_review", action: "submitted", consumer: "reviews", guard: "review head is the pull's current head", transition: "record-review", emits: "review-evidence", writes: false },
  { id: "issue_comment.created", event: "issue_comment", action: "created", consumer: "issues", guard: "issue still exists", transition: "record-comment", emits: "comment-seen", writes: false },
];

function sweepCatalogue(): CatalogueRow[] {
  const rows: CatalogueRow[] = [];
  for (const name of SWEEP_CONDITIONS) {
    for (const suffix of ["", "-cleared"]) {
      const condition = `${name}${suffix}`;
      rows.push({
        id: `sweep:${condition}`,
        event: condition,
        action: "",
        consumer: "sweeper",
        guard: "synthetic sweep row",
        transition: "route-synthetic",
        emits: "",
        writes: false,
      });
    }
  }
  return rows;
}

export const CATALOGUE: readonly CatalogueRow[] = [...WEBHOOK_CATALOGUE, ...sweepCatalogue()];

export interface ReducerEvent {
  delivery_id: string;
  event: string;
  action: string;
  repo: string | null;
  number: number | null;
  head_sha: string | null;
  payload: Record<string, unknown>;
  received_at?: string;
}

export interface ReducerGitHub extends GitHubReadClient, GitHubWriteClient {}

export interface ReducerDeps {
  mode: "off" | "dry" | "on";
  now(): number;
  botLogin: string;
  store: TransitionStore;
  locks: ReducerLock;
  github: ReducerGitHub;
  sleep?: (ms: number) => Promise<void>;
  lockTtlMs?: number;
  lockWaitMs?: number;
  lockPollMs?: number;
  blockedLabel?: string;
  decisionLabels?: readonly string[];
  causedByWindowMs?: number;
  /** Present so a test can prove reducers never read stored history. */
  history?: () => unknown;
}

export interface ReduceResult {
  outcome: TransitionStatus | "busy" | "no_state";
  reason: string | null;
  transition_key: string | null;
  emitted: string[];
  attempts: number;
  replay: boolean;
  row: TransitionRow | null;
}

interface HandlerCtx {
  event: ReducerEvent;
  deps: ReducerDeps;
  key: string;
  id: string;
  at: string;
  dry: boolean;
  attempts: number;
  planned: unknown[];
  existing: TransitionRow | null;
}

interface Act {
  status: TransitionStatus;
  reason: string | null;
  emitted: string[];
  head_sha?: string | null;
  steps?: TransitionSteps;
  retryAt?: string;
}

type ReducerHandler = (ctx: HandlerCtx) => Promise<Act>;

type ChildOutcome =
  | { kind: "done" | "dropped"; emit: string | null }
  | { kind: "retry" | "half"; emit: string | null; until?: string };

export function reducerMode(env: NodeJS.ProcessEnv = process.env): "off" | "dry" | "on" {
  const raw = env.MC_REDUCERS;
  if (raw == null) return "off";
  const value = raw.trim();
  if (value === "dry") return "dry";
  if (value === "1" || value === "on") return "on";
  return "off";
}

/** Attempt 1 waits 30s, then doubles. The exponential part stops at 10 minutes. Retry-After wins when it is longer. */
export function nextBackoffSeconds(attempt: number, retryAfter: number | null): number {
  const exp = Math.min(REDUCER_BACKOFF_CAP_SECONDS, 30 * 2 ** Math.max(0, attempt - 1));
  if (retryAfter != null && Number.isFinite(retryAfter) && retryAfter > exp) return retryAfter;
  return exp;
}

export function reducerMarker(key: string): string {
  return `<!-- agent-kontrol-reducer:v1 key=${key} -->`;
}

export function transitionKey(reducer: string, repo: string, number: number | null, episode: string): string {
  const n = number == null ? 0 : number;
  return `${reducer}:${repo.toLowerCase()}#${n}:${episode}`;
}

/**
 * Same-repo issue numbers from "Blocked by" prose.
 * Fenced code, inline code, quoted lines, other/repo#N, #0, and #12abc are ignored.
 */
export function blockedByIssueNumbers(body: string): number[] {
  const noFence = body.replace(/```[\s\S]*?```/g, " ");
  const noInline = noFence.replace(/`[^`\n]*`/g, " ");
  const text = noInline
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/g, " ");
  const found: number[] = [];
  const clause = /blocked by\s+([^\n.]*)/gi;
  for (const match of text.matchAll(clause)) {
    for (const num of match[1].matchAll(/#(\d+)\b/g)) {
      const value = Number(num[1]);
      if (value > 0 && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

export function renderReducerCatalogueMarkdown(): string {
  const header = "| Catalogue id | Event | Action | Consumer | Guard | Transition | Emits | GitHub writes |";
  const rule = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const lines = CATALOGUE.map((row) =>
    `| ${row.id} | ${row.event} | ${row.action} | ${row.consumer} | ${row.guard} | ${row.transition} | ${row.emits} | ${row.writes ? "yes" : "no"} |`,
  );
  return [header, rule, ...lines].join("\n");
}

/**
 * Handler map. This switch is not derived from CATALOGUE: a new catalogue row
 * with no case here fails the coverage test. Sweep ids share one handler.
 */
export function handlerFor(id: string): ReducerHandler | undefined {
  switch (id) {
    case "pull_request.opened":
    case "pull_request.synchronize":
    case "pull_request.ready_for_review":
    case "pull_request.closed":
      return handlePull;
    case "issues.closed":
      return handleIssuesClosed;
    case "issues.labeled":
    case "issues.unlabeled":
      return handleLabel;
    case "push":
      return handlePush;
    case "check_suite.completed":
      return handleChecks;
    case "pull_request_review.submitted":
      return handleReview;
    case "issue_comment.created":
      return handleComment;
    default:
      break;
  }
  if (id.startsWith("sweep:")) {
    const name = id.slice("sweep:".length);
    const base = name.endsWith("-cleared") ? name.slice(0, -"-cleared".length) : name;
    if ((SWEEP_CONDITIONS as readonly string[]).includes(base)) return handleSweep;
  }
  return undefined;
}

function catalogueId(event: ReducerEvent): string {
  if (event.delivery_id.startsWith("sweep:") || event.event.startsWith("sweep:")) {
    const name = event.event.startsWith("sweep:") ? event.event.slice("sweep:".length) : event.event;
    return `sweep:${name}`;
  }
  if (!event.action) return event.event;
  return `${event.event}.${event.action}`;
}

function validRepo(repo: string | null): repo is string {
  if (!repo) return false;
  const slash = repo.indexOf("/");
  return slash > 0 && slash === repo.lastIndexOf("/") && !/\s/.test(repo);
}

function malformedReason(id: string, event: ReducerEvent): string | null {
  if (!event.delivery_id) return "malformed";
  if (!validRepo(event.repo)) return "malformed";
  if (id.startsWith("sweep:")) return null;
  const needsNumber = id.startsWith("pull_request") || id.startsWith("issues.") || id === "issue_comment.created";
  const needsSha = id.startsWith("pull_request") || id === "push" || id === "check_suite.completed";
  if (needsNumber && !(typeof event.number === "number" && Number.isInteger(event.number) && event.number > 0)) return "malformed";
  if (needsSha && !(event.head_sha && SHA_RE.test(event.head_sha))) return "malformed";
  return null;
}

function episodeFor(id: string, event: ReducerEvent): string {
  const sha = (event.head_sha ?? "").toLowerCase();
  switch (id) {
    case "pull_request.opened":
    case "pull_request.synchronize":
    case "pull_request.ready_for_review":
    case "push":
      return sha;
    case "pull_request_review.submitted":
    case "check_suite.completed":
      return `${sha}:${event.delivery_id}`;
    default:
      return event.delivery_id;
  }
}

function actorLogin(event: ReducerEvent): string {
  const sender = event.payload.sender;
  if (sender && typeof sender === "object" && typeof (sender as { login?: unknown }).login === "string") {
    return (sender as { login: string }).login;
  }
  return "";
}

function sameLogin(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && a.toLowerCase() === b.toLowerCase();
}

function sameSha(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function addDelivery(list: string[] | undefined, delivery: string): string[] {
  const next = [...(list ?? [])];
  if (!next.includes(delivery)) next.push(delivery);
  return next;
}

function emittedOf(steps: TransitionSteps): string[] {
  if (!Array.isArray(steps.emitted)) return [];
  return steps.emitted.filter((item): item is string => typeof item === "string");
}

function fromRow(row: TransitionRow, replay: boolean): ReduceResult {
  return {
    outcome: row.status,
    reason: row.reason,
    transition_key: row.transition_key,
    emitted: emittedOf(row.steps),
    attempts: row.attempts,
    replay,
    row,
  };
}

function noState(): ReduceResult {
  return { outcome: "no_state", reason: "no_state", transition_key: null, emitted: [], attempts: 0, replay: false, row: null };
}

function busy(): ReduceResult {
  return { outcome: "busy", reason: "lock_held", transition_key: null, emitted: [], attempts: 0, replay: false, row: null };
}

function isEchoRow(row: TransitionRow): boolean {
  return row.reason === "caused_by" || row.reason === "echo";
}

function echoMatch(row: TransitionRow, event: ReducerEvent, deps: ReducerDeps): boolean {
  if (!isEchoRow(row)) return false;
  const caused = row.steps.caused_by;
  const actor = actorLogin(event);
  if (sameLogin(actor, caused?.actor ?? "") || sameLogin(actor, deps.botLogin)) return true;
  const until = caused?.until ? Date.parse(caused.until) : Number.NaN;
  const received = event.received_at ? Date.parse(event.received_at) : deps.now();
  return Number.isFinite(until) && Number.isFinite(received) && received <= until;
}

function shouldReplay(row: TransitionRow, event: ReducerEvent, deps: ReducerDeps): boolean {
  if (row.reason === "caused_by" || row.reason === "echo") return false;
  if (row.reason === "dry_run") return deps.mode !== "on";
  const capped = row.status === "failed" && (row.steps.terminal === true || row.attempts >= REDUCER_MAX_ATTEMPTS);
  const terminal = row.status === "done" || row.status === "skipped" || row.status === "dropped" || capped;
  if (!terminal) return false;
  return true;
}

function waiting(row: TransitionRow, deps: ReducerDeps): boolean {
  if (row.status !== "failed" && row.status !== "half_done" && row.status !== "started") return false;
  if (!row.steps.next_attempt_at) return false;
  const when = Date.parse(row.steps.next_attempt_at);
  return Number.isFinite(when) && when > deps.now();
}

async function acquire(deps: ReducerDeps, key: string): Promise<{ token: string } | null> {
  const ttl = deps.lockTtlMs ?? 60_000;
  const wait = deps.lockWaitMs ?? 5_000;
  const poll = deps.lockPollMs ?? 20;
  const deadline = deps.now() + wait;
  for (;;) {
    const got = await deps.locks.tryAcquire(key, ttl, deps.now());
    if (got.ok) return { token: got.token };
    if (deps.now() >= deadline) return null;
    if (deps.sleep) await deps.sleep(poll);
    else await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

function drop(reason: string, emit: string[] = []): Act {
  return { status: "dropped", reason, emitted: emit };
}

function labelName(event: ReducerEvent): string | null {
  const label = event.payload.label;
  if (typeof label === "string" && label.trim()) return label.trim();
  if (label && typeof label === "object" && typeof (label as { name?: unknown }).name === "string") {
    const name = (label as { name: string }).name.trim();
    return name || null;
  }
  return null;
}

async function handleSweep(): Promise<Act> {
  return { status: "done", reason: "routed", emitted: [] };
}

async function handleComment(ctx: HandlerCtx): Promise<Act> {
  const issue = await ctx.deps.github.getIssue(ctx.event.repo!, ctx.event.number!);
  if (!issue) return drop("absent");
  return { status: "done", reason: null, emitted: ["comment-seen"] };
}

async function handleReview(ctx: HandlerCtx): Promise<Act> {
  const pull = await ctx.deps.github.getPull(ctx.event.repo!, ctx.event.number!);
  if (!pull) return drop("absent");
  if (!sameSha(pull.headSha, ctx.event.head_sha!)) return drop("stale_head");
  return { status: "done", reason: null, emitted: ["review-evidence"], head_sha: pull.headSha };
}

async function handlePull(ctx: HandlerCtx): Promise<Act> {
  const pull = await ctx.deps.github.getPull(ctx.event.repo!, ctx.event.number!);
  if (!pull) return drop("absent");
  if (!sameSha(pull.headSha, ctx.event.head_sha!)) return drop("stale_head");
  if (ctx.id === "pull_request.closed") {
    if (pull.state !== "closed") return drop("reopened");
    return { status: "done", reason: null, emitted: [pull.merged ? "pr-merged" : "pr-closed"], head_sha: pull.headSha };
  }
  if (ctx.id === "pull_request.synchronize") {
    return { status: "done", reason: null, emitted: ["head-moved"], head_sha: pull.headSha };
  }
  if (pull.draft) return { status: "done", reason: "draft", emitted: [], head_sha: pull.headSha };
  const work_item = {
    kind: "work-item",
    repo: ctx.event.repo!.toLowerCase(),
    number: ctx.event.number,
    head_sha: pull.headSha.toLowerCase(),
    catalogue_id: ctx.id,
  };
  ctx.planned.push({ action: "work-item", work_item });
  return { status: "done", reason: null, emitted: ["work-item"], head_sha: pull.headSha, steps: { work_item } };
}

async function handleLabel(ctx: HandlerCtx): Promise<Act> {
  const issue = await ctx.deps.github.getIssue(ctx.event.repo!, ctx.event.number!);
  if (!issue) return drop("absent");
  const label = labelName(ctx.event);
  if (!label) return drop("malformed");
  const patterns = ctx.deps.decisionLabels ?? DECISION_LABEL_PATTERNS;
  if (!isDecisionLabel(label, patterns)) return drop("not_decision_label");
  const live = issue.labels.includes(label);
  const added = ctx.id === "issues.labeled";
  if (added !== live) return drop("stale_label");
  return { status: "done", reason: null, emitted: [added ? "decision-label-added" : "decision-label-removed"] };
}

async function handleChecks(ctx: HandlerCtx): Promise<Act> {
  const repo = ctx.event.repo!;
  const sha = ctx.event.head_sha!;
  let branch: string;
  if (ctx.event.number) {
    const pull = await ctx.deps.github.getPull(repo, ctx.event.number);
    if (!pull) return drop("absent");
    if (!sameSha(pull.headSha, sha)) return drop("stale_head");
    branch = pull.baseRef || (await ctx.deps.github.getRepo(repo)).defaultBranch;
  } else {
    branch = (await ctx.deps.github.getRepo(repo)).defaultBranch;
  }
  const required = await ctx.deps.github.requiredContexts(repo, branch);
  if (required.length === 0) return drop("no_required_contexts");
  const conclusions = await ctx.deps.github.checkConclusions(repo, sha);
  const green = required.every((name) => conclusions[name] === "success");
  if (!green) return { status: "done", reason: "checks_not_green", emitted: [], head_sha: sha };
  return { status: "done", reason: null, emitted: ["contexts-green"], head_sha: sha };
}

async function persist(ctx: HandlerCtx, status: TransitionStatus, reason: string | null, steps: TransitionSteps): Promise<void> {
  await ctx.deps.store.update(ctx.key, { status, reason, steps, attempts: ctx.attempts }, new Date(ctx.deps.now()).toISOString());
}

async function handleIssuesClosed(ctx: HandlerCtx): Promise<Act> {
  const repo = ctx.event.repo!;
  const closedNumber = ctx.event.number!;
  const closed = await ctx.deps.github.getIssue(repo, closedNumber);
  if (!closed || closed.state !== "closed") return drop("reopened");
  const open = await ctx.deps.github.listOpenIssues(repo);
  const label = ctx.deps.blockedLabel ?? "blocked";
  const dependents: NonNullable<TransitionSteps["dependents"]> = { ...(ctx.existing?.steps.dependents ?? {}) };
  const emitted: string[] = [];
  for (const issue of open) {
    if (issue.number === closedNumber) continue;
    const blockers = blockedByIssueNumbers(issue.body);
    if (!blockers.includes(closedNumber)) continue;
    let allClosed = true;
    for (const blocker of blockers) {
      if (blocker === closedNumber) continue;
      const other = await ctx.deps.github.getIssue(repo, blocker);
      if (!other || other.state !== "closed") {
        allClosed = false;
        break;
      }
    }
    if (!allClosed) continue;
    const depKey = `${ctx.key}:dep#${issue.number}`;
    const prior = { ...(dependents[String(issue.number)] ?? {}) };
    const marker = reducerMarker(depKey);
    if (!prior.comment) {
      if (ctx.dry) ctx.planned.push({ action: "comment", repo: repo.toLowerCase(), number: issue.number, marker });
      else {
        const comments = await ctx.deps.github.listComments(repo, issue.number);
        if (!comments.some((comment) => comment.body.includes(marker))) {
          await ctx.deps.github.comment(repo, issue.number, `${marker}\nUnblocked: #${closedNumber} closed.`);
        }
        prior.comment = true;
        dependents[String(issue.number)] = prior;
        await persist(ctx, "half_done", null, { ...ctx.existing?.steps, dependents, deliveries: addDelivery(ctx.existing?.steps.deliveries, ctx.event.delivery_id) });
      }
    }
    if (!prior.unlabel) {
      if (ctx.dry) ctx.planned.push({ action: "remove_label", repo: repo.toLowerCase(), number: issue.number, label });
      else {
        try {
          await ctx.deps.github.removeLabel(repo, issue.number, label);
        } catch (error) {
          dependents[String(issue.number)] = prior;
          await persist(ctx, "half_done", error instanceof GitHubCallError ? error.reason : "error", {
            dependents,
            deliveries: addDelivery(ctx.existing?.steps.deliveries, ctx.event.delivery_id),
          });
          return { status: "half_done", reason: error instanceof GitHubCallError ? error.reason : "error", emitted, steps: { dependents } };
        }
        prior.unlabel = true;
        dependents[String(issue.number)] = prior;
        await persist(ctx, "half_done", null, { dependents, deliveries: addDelivery(ctx.existing?.steps.deliveries, ctx.event.delivery_id) });
      }
    }
    emitted.push("became-unblocked");
  }
  return { status: "done", reason: null, emitted, steps: { dependents } };
}

async function saveChild(
  ctx: HandlerCtx,
  key: string,
  number: number,
  status: TransitionStatus,
  reason: string | null,
  steps: TransitionSteps,
  attempts: number,
  head: string | null,
): Promise<TransitionRow> {
  const at = new Date(ctx.deps.now()).toISOString();
  const existing = await ctx.deps.store.get(key);
  if (!existing) {
    const inserted = await ctx.deps.store.insert({
      transition_key: key,
      reducer: "update-branch",
      repo: ctx.event.repo!.toLowerCase(),
      number,
      head_sha: head,
      status,
      reason,
      steps,
      attempts,
    }, at);
    return inserted.row;
  }
  return ctx.deps.store.update(key, { status, reason, steps, attempts, head_sha: head }, at);
}

async function recordEcho(ctx: HandlerCtx, repo: string, number: number, newSha: string): Promise<void> {
  const sha = newSha.toLowerCase();
  const until = new Date(ctx.deps.now() + (ctx.deps.causedByWindowMs ?? CAUSED_BY_WINDOW_MS)).toISOString();
  const syncKey = transitionKey("pull_request.synchronize", repo, number, sha);
  const pushKey = transitionKey("push", repo, null, sha);
  const caused = { actor: ctx.deps.botLogin, until, keys: [syncKey, pushKey] };
  const at = new Date(ctx.deps.now()).toISOString();
  for (const [key, echoNumber] of [[syncKey, number], [pushKey, null]] as const) {
    await ctx.deps.store.insert({
      transition_key: key,
      reducer: key.slice(0, key.indexOf(":")),
      repo: repo.toLowerCase(),
      number: echoNumber,
      head_sha: sha,
      status: "dropped",
      reason: "caused_by",
      steps: { caused_by: caused, deliveries: [], terminal: true },
      attempts: 0,
    }, at);
  }
}

async function updateOne(ctx: HandlerCtx, number: number): Promise<ChildOutcome> {
  const repo = ctx.event.repo!;
  const lockKey = `${repo.toLowerCase()}#${number}`;
  const lock = await acquire(ctx.deps, lockKey);
  if (!lock) return { kind: "retry", emit: null };
  try {
    return await updateOneLocked(ctx, number);
  } finally {
    await ctx.deps.locks.release(lockKey, lock.token);
  }
}

function childEmit(row: TransitionRow): string | null {
  if (row.status === "done") return "update-branch";
  if (row.reason === "conflict") return "update-branch-conflict";
  return null;
}

async function updateOneLocked(ctx: HandlerCtx, number: number): Promise<ChildOutcome> {
  const repo = ctx.event.repo!;
  const github = ctx.deps.github;
  const first = await github.getPull(repo, number);
  if (!first) {
    const key = transitionKey("update-branch", repo, number, "absent");
    await saveChild(ctx, key, number, "dropped", "absent", { terminal: true }, 0, null);
    return { kind: "dropped", emit: null };
  }
  const pinned = first.headSha;
  const key = transitionKey("update-branch", repo, number, pinned.toLowerCase());
  let child = await ctx.deps.store.get(key);
  if (child && (child.status === "done" || child.status === "dropped" || child.status === "skipped")) {
    return { kind: child.status === "done" ? "done" : "dropped", emit: childEmit(child) };
  }
  if (child && child.status === "failed" && (child.steps.terminal === true || child.attempts >= REDUCER_MAX_ATTEMPTS)) {
    return { kind: "dropped", emit: null };
  }
  if (child && waiting(child, ctx.deps)) return { kind: "retry", emit: null, until: child.steps.next_attempt_at };

  if (child?.steps.pending_merge && !sameSha(first.headSha, child.steps.pending_merge)) {
    await saveChild(ctx, key, number, "dropped", "stale_head", { ...child.steps, terminal: true, pending_merge: undefined }, child.attempts, first.headSha);
    return { kind: "dropped", emit: null };
  }
  if (child?.status === "half_done" && (child.steps.completed ?? []).includes("merge")) {
    return resumeAfterMerge(ctx, key, number, child, pinned);
  }

  if (first.draft || first.mergeableState === "draft") {
    await saveChild(ctx, key, number, "dropped", "draft", { terminal: true }, 0, pinned);
    return { kind: "dropped", emit: null };
  }
  if (first.fork && !first.maintainerCanModify) {
    await saveChild(ctx, key, number, "dropped", "fork", { terminal: true }, 0, pinned);
    return { kind: "dropped", emit: null };
  }
  if (await github.branchProtected(repo, first.headRef)) {
    await saveChild(ctx, key, number, "dropped", "protected", { terminal: true }, 0, pinned);
    return { kind: "dropped", emit: null };
  }
  if (first.mergeable == null || first.mergeableState === "unknown" || first.mergeableState === "unstable") {
    const attempts = Math.min(REDUCER_MAX_ATTEMPTS, (child?.attempts ?? 0) + (ctx.dry ? 0 : 1));
    const until = new Date(ctx.deps.now() + nextBackoffSeconds(Math.max(attempts, 1), null) * 1000).toISOString();
    if (!ctx.dry) {
      await saveChild(ctx, key, number, "failed", "mergeable_unknown", { terminal: attempts >= REDUCER_MAX_ATTEMPTS, next_attempt_at: until }, attempts, pinned);
    } else ctx.planned.push({ action: "retry", number, reason: "mergeable_unknown" });
    return { kind: "retry", emit: null, until };
  }
  if (first.mergeable === false || first.mergeableState === "dirty") {
    await saveChild(ctx, key, number, "dropped", "conflict", { terminal: true, emitted: ["update-branch-conflict"] }, 0, pinned);
    return { kind: "dropped", emit: "update-branch-conflict" };
  }
  if (first.mergeableState !== "behind") {
    await saveChild(ctx, key, number, "dropped", "up_to_date", { terminal: true }, 0, pinned);
    return { kind: "dropped", emit: null };
  }

  const second = await github.getPull(repo, number);
  if (!second || !sameSha(second.headSha, pinned)) {
    await saveChild(ctx, key, number, "dropped", "stale_head", { terminal: true }, 0, second?.headSha ?? null);
    return { kind: "dropped", emit: null };
  }
  if (ctx.dry) {
    ctx.planned.push({ action: "merge", repo: repo.toLowerCase(), number, expected_head_sha: pinned });
    ctx.planned.push({ action: "request_reviewers", repo: repo.toLowerCase(), number, reviewers: first.reviewers });
    return { kind: "done", emit: "update-branch" };
  }

  const attempts = Math.min(REDUCER_MAX_ATTEMPTS, (child?.attempts ?? 0) + 1);
  const completed = [...(child?.steps.completed ?? [])];
  if (!completed.includes("merge")) {
    child = await saveChild(ctx, key, number, "started", null, {
      ...(child?.steps ?? {}),
      pending_merge: pinned,
      completed,
      reviewers: first.reviewers,
      deliveries: addDelivery(child?.steps.deliveries, ctx.event.delivery_id),
    }, attempts, pinned);
    try {
      await github.mergeBaseIntoPull(repo, number, pinned);
    } catch (error) {
      if (error instanceof GitHubCallError && error.reason === "stale_head") {
        await saveChild(ctx, key, number, "dropped", "stale_head", { ...child.steps, terminal: true, pending_merge: undefined }, attempts, pinned);
        return { kind: "dropped", emit: null };
      }
      let moved = false;
      try {
        const afterError = await github.getPull(repo, number);
        moved = !afterError || !sameSha(afterError.headSha, pinned);
      } catch {
        moved = false;
      }
      if (moved) {
        await saveChild(ctx, key, number, "dropped", "stale_head", { ...child.steps, terminal: true, pending_merge: undefined }, attempts, null);
        return { kind: "dropped", emit: null };
      }
      const reason = error instanceof GitHubCallError ? error.reason : error instanceof GitHubListTruncatedError ? "issue_list_truncated" : "error";
      const retryAfter = error instanceof GitHubCallError ? error.retryAfterSeconds : null;
      const until = new Date(ctx.deps.now() + nextBackoffSeconds(attempts, retryAfter) * 1000).toISOString();
      await saveChild(ctx, key, number, "failed", reason, { ...child.steps, pending_merge: pinned, terminal: attempts >= REDUCER_MAX_ATTEMPTS, next_attempt_at: until }, attempts, pinned);
      return { kind: "retry", emit: null, until };
    }
    completed.push("merge");
  }

  const after = await github.getPull(repo, number);
  if (!after || sameSha(after.headSha, pinned)) {
    await saveChild(ctx, key, number, "half_done", "awaiting_new_head", { completed, reviewers: first.reviewers, pending_merge: undefined, terminal: false }, attempts, pinned);
    return { kind: "half", emit: null };
  }
  await recordEcho(ctx, repo, number, after.headSha);
  return finishReviewers(ctx, key, number, completed, attempts, after, first.reviewers);
}

async function resumeAfterMerge(ctx: HandlerCtx, key: string, number: number, child: TransitionRow, pinned: string): Promise<ChildOutcome> {
  if (ctx.dry) return { kind: "half", emit: null };
  const after = await ctx.deps.github.getPull(ctx.event.repo!, number);
  if (!after || sameSha(after.headSha, pinned)) {
    return { kind: "half", emit: null };
  }
  await recordEcho(ctx, ctx.event.repo!, number, after.headSha);
  const reviewers = child.steps.reviewers ?? after.reviewers;
  return finishReviewers(ctx, key, number, [...(child.steps.completed ?? [])], child.attempts, after, reviewers);
}

async function finishReviewers(
  ctx: HandlerCtx,
  key: string,
  number: number,
  completed: string[],
  attempts: number,
  after: GhPull,
  reviewers: string[],
): Promise<ChildOutcome> {
  const doneSteps: TransitionSteps = { completed, reviewers, terminal: false, pending_merge: undefined };
  if (!completed.includes("reviewers")) {
    try {
      await ctx.deps.github.requestReviewers(ctx.event.repo!, number, reviewers);
      completed.push("reviewers");
    } catch (error) {
      const reason = error instanceof GitHubCallError ? error.reason : "error";
      await saveChild(ctx, key, number, "half_done", reason, { ...doneSteps, completed: [...completed], reviewers }, attempts, after.headSha);
      return { kind: "half", emit: null };
    }
  }
  await saveChild(ctx, key, number, "done", null, { completed, terminal: true, emitted: ["update-branch"], pending_merge: undefined }, attempts, after.headSha);
  return { kind: "done", emit: "update-branch" };
}

async function handlePush(ctx: HandlerCtx): Promise<Act> {
  const repo = ctx.event.repo!;
  const ref = typeof ctx.event.payload.ref === "string" ? ctx.event.payload.ref : "";
  const info = await ctx.deps.github.getRepo(repo);
  if (ref !== `refs/heads/${info.defaultBranch}`) return drop("non_default");
  const pulls = await ctx.deps.github.listOpenPulls(repo);
  const emitted: string[] = [];
  let retry = false;
  let half = false;
  let until: string | undefined;
  for (const pull of pulls) {
    if (pull.baseRef !== info.defaultBranch) continue;
    const outcome = await updateOne(ctx, pull.number);
    if (outcome.emit) emitted.push(outcome.emit);
    if (outcome.kind === "retry") {
      retry = true;
      if (outcome.until && (!until || outcome.until > until)) until = outcome.until;
    } else if (outcome.kind === "half") {
      half = true;
    }
  }
  if (retry) return { status: "failed", reason: "child_retry", emitted, retryAt: until };
  if (half) return { status: "half_done", reason: "awaiting_reviewers", emitted };
  return { status: "done", reason: null, emitted };
}

async function closedMissing(id: string, event: ReducerEvent, github: ReducerGitHub): Promise<boolean> {
  if (id === "pull_request.closed") {
    const pull = await github.getPull(event.repo!, event.number!);
    return pull == null || pull.state !== "closed";
  }
  if (id === "issues.closed") {
    const issue = await github.getIssue(event.repo!, event.number!);
    return issue == null || issue.state !== "closed";
  }
  return false;
}

function failureReason(error: unknown): { reason: string; retryAfter: number | null } {
  if (error instanceof GitHubListTruncatedError) return { reason: "issue_list_truncated", retryAfter: null };
  if (error instanceof GitHubCallError) return { reason: error.reason, retryAfter: error.retryAfterSeconds };
  return { reason: "error", retryAfter: null };
}

async function insertFresh(
  deps: ReducerDeps,
  draft: Omit<TransitionRow, "created_at" | "updated_at">,
  at: string,
): Promise<ReduceResult> {
  const existing = await deps.store.get(draft.transition_key);
  if (existing) return fromRow(existing, true);
  const inserted = await deps.store.insert(draft, at);
  return fromRow(inserted.row, false);
}

export async function reduceEvent(event: ReducerEvent, deps: ReducerDeps): Promise<ReduceResult> {
  const at = new Date(deps.now()).toISOString();
  if (deps.mode === "off") {
    const key = `flag-off:${event.delivery_id || "missing"}`;
    return insertFresh(deps, {
      transition_key: key,
      reducer: "flag",
      repo: validRepo(event.repo) ? event.repo.toLowerCase() : null,
      number: event.number,
      head_sha: event.head_sha,
      status: "skipped",
      reason: "skipped-by-flag",
      steps: { deliveries: event.delivery_id ? [event.delivery_id] : [], terminal: true },
      attempts: 0,
    }, at);
  }

  const id = catalogueId(event);
  const handler = handlerFor(id);
  if (!handler) {
    return insertFresh(deps, {
      transition_key: `uncatalogued:${event.delivery_id || "missing"}`.slice(0, 500),
      reducer: "uncatalogued",
      repo: validRepo(event.repo) ? event.repo.toLowerCase() : null,
      number: event.number,
      head_sha: event.head_sha,
      status: "dropped",
      reason: "uncatalogued",
      steps: { deliveries: event.delivery_id ? [event.delivery_id] : [], terminal: true },
      attempts: 0,
    }, at);
  }
  if (malformedReason(id, event)) {
    return insertFresh(deps, {
      transition_key: `malformed:${event.delivery_id}`.slice(0, 500),
      reducer: id.slice(0, 80),
      repo: validRepo(event.repo) ? event.repo.toLowerCase() : null,
      number: event.number,
      head_sha: event.head_sha,
      status: "dropped",
      reason: "malformed",
      steps: { deliveries: [event.delivery_id], terminal: true },
      attempts: 0,
    }, at);
  }

  const repo = event.repo as string;
  const key = transitionKey(id, repo, event.number, episodeFor(id, event));
  if (key.length > 500) {
    return insertFresh(deps, {
      transition_key: `malformed:${event.delivery_id}`.slice(0, 500),
      reducer: id.slice(0, 80),
      repo: repo.toLowerCase(),
      number: event.number,
      head_sha: event.head_sha,
      status: "dropped",
      reason: "malformed",
      steps: { deliveries: [event.delivery_id], terminal: true },
      attempts: 0,
    }, at);
  }

  const prior = await deps.store.get(key);
  if (prior && echoMatch(prior, event, deps)) {
    const deliveries = addDelivery(prior.steps.deliveries, event.delivery_id);
    if (prior.reason === "echo" && (prior.steps.deliveries ?? []).includes(event.delivery_id)) return fromRow(prior, true);
    const updated = await deps.store.update(key, {
      status: "dropped",
      reason: "echo",
      steps: { ...prior.steps, deliveries, terminal: true },
    }, at);
    return fromRow(updated, false);
  }
  if (prior && !isEchoRow(prior) && shouldReplay(prior, event, deps)) return fromRow(prior, true);
  if (prior && waiting(prior, deps)) return fromRow(prior, true);
  if (prior && prior.status === "failed" && prior.attempts >= REDUCER_MAX_ATTEMPTS) {
    if (!prior.steps.terminal) {
      const updated = await deps.store.update(key, { steps: { ...prior.steps, terminal: true } }, at);
      return fromRow(updated, true);
    }
    return fromRow(prior, true);
  }

  const lockKey = `${repo.toLowerCase()}#${event.number ?? 0}`;
  const lock = await acquire(deps, lockKey);
  if (!lock) return busy();
  let started: TransitionRow | null = null;
  try {
    const existing = await deps.store.get(key);
    if (existing && echoMatch(existing, event, deps)) {
      const updated = await deps.store.update(key, {
        status: "dropped",
        reason: "echo",
        steps: { ...existing.steps, deliveries: addDelivery(existing.steps.deliveries, event.delivery_id), terminal: true },
      }, at);
      return fromRow(updated, false);
    }
    if (existing && !isEchoRow(existing) && shouldReplay(existing, event, deps)) return fromRow(existing, true);
    if (existing && waiting(existing, deps)) return fromRow(existing, true);

    if (id === "pull_request.closed" || id === "issues.closed") {
      const missing = await closedMissing(id, event, deps.github);
      if (missing) return noState();
    }

    const attempts = deps.mode === "dry"
      ? (existing?.attempts ?? 0)
      : Math.min(REDUCER_MAX_ATTEMPTS, (existing && !isEchoRow(existing) ? existing.attempts : 0) + 1);
    const baseSteps: TransitionSteps = {
      ...(existing && !isEchoRow(existing) ? existing.steps : {}),
      deliveries: addDelivery(existing?.steps.deliveries, event.delivery_id),
    };
    delete baseSteps.next_attempt_at;
    if (deps.mode === "on") {
      if (!existing || isEchoRow(existing)) {
        const inserted = await deps.store.insert({
          transition_key: key,
          reducer: id.slice(0, 80),
          repo: repo.toLowerCase(),
          number: event.number,
          head_sha: event.head_sha,
          status: "started",
          reason: null,
          steps: baseSteps,
          attempts,
        }, at);
        started = inserted.inserted ? inserted.row : await deps.store.update(key, { status: "started", attempts, steps: baseSteps, reason: null }, at);
      } else {
        started = await deps.store.update(key, {
          status: existing.status === "half_done" ? "half_done" : "started",
          attempts,
          steps: baseSteps,
          reason: existing.reason,
        }, at);
      }
    }

    const planned: unknown[] = [];
    const ctx: HandlerCtx = { event, deps, key, id, at, dry: deps.mode === "dry", attempts, planned, existing: started ?? (existing && !isEchoRow(existing) ? existing : null) };
    const act = await handler(ctx);
    const steps: TransitionSteps = {
      ...baseSteps,
      ...(act.steps ?? {}),
      deliveries: addDelivery(baseSteps.deliveries, event.delivery_id),
      emitted: act.emitted,
    };
    if (deps.mode === "dry") {
      steps.planned = { would_status: act.status, would_reason: act.reason, would_emit: act.emitted, actions: planned };
      steps.terminal = true;
      const draft = {
        transition_key: key,
        reducer: id.slice(0, 80),
        repo: repo.toLowerCase(),
        number: event.number,
        head_sha: act.head_sha === undefined ? event.head_sha : act.head_sha,
        status: "skipped" as const,
        reason: "dry_run",
        steps,
        attempts,
      };
      if (!existing || isEchoRow(existing)) {
        const inserted = await deps.store.insert(draft, at);
        return fromRow(inserted.row, false);
      }
      return fromRow(await deps.store.update(key, draft, at), false);
    }
    const terminal = act.status === "done" || act.status === "dropped" || act.status === "skipped" || (act.status === "failed" && attempts >= REDUCER_MAX_ATTEMPTS);
    steps.terminal = terminal;
    if (!terminal && (act.status === "failed" || act.retryAt)) {
      const backoffAt = deps.now() + nextBackoffSeconds(attempts, null) * 1000;
      const requested = act.retryAt ? Date.parse(act.retryAt) : backoffAt;
      steps.next_attempt_at = new Date(Math.max(backoffAt, Number.isFinite(requested) ? requested : backoffAt)).toISOString();
    } else {
      delete steps.next_attempt_at;
    }
    const saved = await deps.store.update(key, {
      status: act.status,
      reason: act.reason,
      steps,
      attempts,
      head_sha: act.head_sha === undefined ? event.head_sha : act.head_sha,
    }, new Date(deps.now()).toISOString());
    return fromRow(saved, false);
  } catch (error) {
    const { reason, retryAfter } = failureReason(error);
    const existing = started ?? await deps.store.get(key);
    const attempts = Math.min(REDUCER_MAX_ATTEMPTS, existing?.attempts && existing.attempts > 0 ? existing.attempts : 1);
    const fresh = (await deps.store.get(key)) ?? existing;
    const steps: TransitionSteps = {
      ...(fresh?.steps ?? {}),
      deliveries: addDelivery(fresh?.steps.deliveries, event.delivery_id),
      terminal: attempts >= REDUCER_MAX_ATTEMPTS,
    };
    if (steps.terminal) delete steps.next_attempt_at;
    else steps.next_attempt_at = new Date(deps.now() + nextBackoffSeconds(attempts, retryAfter) * 1000).toISOString();
    const atFail = new Date(deps.now()).toISOString();
    if (!fresh) {
      const inserted = await deps.store.insert({
        transition_key: key,
        reducer: id.slice(0, 80),
        repo: repo.toLowerCase(),
        number: event.number,
        head_sha: event.head_sha,
        status: "failed",
        reason,
        steps,
        attempts,
      }, atFail);
      return fromRow(inserted.row, false);
    }
    const saved = await deps.store.update(key, { status: "failed", reason, steps, attempts }, atFail);
    return fromRow(saved, false);
  } finally {
    await deps.locks.release(lockKey, lock.token);
  }
}

function unavailableGitHub(): ReducerGitHub {
  const fail = (): Promise<never> => Promise.reject(new GitHubCallError(0, "not_installed", null));
  return {
    botLogin: () => "",
    getRepo: fail,
    getPull: fail,
    getIssue: fail,
    listOpenPulls: fail,
    listOpenIssues: fail,
    listComments: fail,
    branchProtected: fail,
    requiredContexts: fail,
    checkConclusions: fail,
    comment: fail,
    removeLabel: fail,
    mergeBaseIntoPull: fail,
    requestReviewers: fail,
  };
}

export function liveReducerGitHub(config: GitHubAppConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): ReducerGitHub {
  const auth = installationAuthorizer(config, fetchImpl, now);
  const read = githubReadClient(auth, fetchImpl, now);
  const write = githubWriteClient(auth, fetchImpl, now);
  return { ...read, ...write, botLogin: () => config.botLogin };
}

export function productionReducerDeps(env: NodeJS.ProcessEnv = process.env): ReducerDeps {
  const config = githubAppConfig(env);
  return {
    mode: reducerMode(env),
    now: () => Date.now(),
    botLogin: config?.botLogin ?? "",
    store: sqlTransitionStore(),
    locks: sqlReducerLock(),
    github: config ? liveReducerGitHub(config) : unavailableGitHub(),
  };
}
