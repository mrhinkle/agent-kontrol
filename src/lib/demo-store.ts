/**
 * Process-local store for demo mode (no DATABASE_URL).
 *
 * The five MCP write tools record here for the life of this process.
 * get_fleet_status, recall, and get_task_queue read it back. The data is
 * gone when the process exits. Every successful tool response from this
 * module carries DEMO_BANNER so a client cannot treat it as durable.
 *
 * This module does not import the database. With DATABASE_URL set, callers
 * must not use it. Caps evict the oldest row so a public demo cannot grow
 * without a limit. Sessions are capped per agent. An idempotency key stays
 * until its own expiry: evicting the task row must not drop it.
 */
import type { Actor } from "./actor";
import { mcpToolError, memoryKeyError, type McpToolResult } from "./api-error";
import { diffMemoryWrite, diffTaskUpdate, readDryRun, type MemoryWriteInput } from "./dry-run";
import {
  IDEMPOTENCY_ROUTE,
  IDEMPOTENCY_TTL_MS,
  IdempotencyConflict,
  IdempotencyKeyInvalid,
  hashPayload,
  idempotencyScope,
  payloadOf,
} from "./idempotency";
import type { Event, FleetAgent, MemoryItem, Session, Task, TaskStatus } from "./types";

/** Same rule as store.slugify. Kept here so this module does not import the database store. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

export const DEMO_BANNER = "[demo — in-memory, cleared when this process restarts]";

/**
 * Oldest row is dropped past these counts. Events are capped so reports cannot
 * grow the process by themselves. Sessions are capped per agent: fleet status
 * keeps a handful, and a fresh session id on every report would otherwise
 * retain every session for that agent.
 */
export const DEMO_CAPS = {
  tasks: 200,
  notes: 200,
  agents: 100,
  events: 400,
  idempotency: 200,
  sessionsPerAgent: 5,
} as const;

const OFFLINE_AFTER_MS = 15 * 60 * 1000;
const OPEN_STATUSES: TaskStatus[] = ["queued", "claimed", "running", "review"];
const KIND_TO_STATUS: Record<string, string> = {
  session_start: "active",
  turn_start: "active",
  milestone: "active",
  heartbeat: "active",
  waiting: "waiting",
  notification: "waiting",
  session_end: "done",
  error: "failed",
};
const MISMATCH = "This idempotency key was already used with different arguments.";
const BAD_KEY = "Use 1 to 200 characters and no control characters, or omit the key.";
const KEY_MAX = 200;

export const DEMO_EMPTY_CLAIM = "No queued tasks for your platform.";

interface DemoAgent {
  id: string;
  platform: string;
  machine: string | null;
  display_name: string | null;
  last_seen_at: string;
}

interface IdemRow {
  hash: string;
  task: Task;
  expiresAt: number;
  storedAt: number;
}

let nowFn: () => number = () => Date.now();
let touchCount = 0;
let tail: Promise<void> = Promise.resolve();
let nextTaskId = 1;
let nextNoteId = 1;
let nextEventId = 1;

const agents = new Map<string, DemoAgent>();
const sessions = new Map<string, Session>();
const events: Event[] = [];
const notes: MemoryItem[] = [];
const tasks: Task[] = [];
const idempotency = new Map<string, IdemRow>();

/** Tests move the 24 hour idempotency window. Production never calls this. */
export function setDemoClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/** How many times a demo-store operation has run. The configured path must not change this. */
export function demoStoreTouchCount(): number {
  return touchCount;
}

export function demoStoreSize(): { tasks: number; notes: number; agents: number; events: number; sessions: number } {
  return {
    tasks: tasks.length,
    notes: notes.length,
    agents: agents.size,
    events: events.length,
    sessions: sessions.size,
  };
}

/** Session ids currently retained. Tests use this to see per-agent eviction. */
export function demoSessionsForTests(): { id: string; agent_id: string; updated_at: string }[] {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    agent_id: session.agent_id,
    updated_at: session.updated_at,
  }));
}

export function resetDemoStoreForTests(): void {
  agents.clear();
  sessions.clear();
  events.length = 0;
  notes.length = 0;
  tasks.length = 0;
  idempotency.clear();
  nextTaskId = 1;
  nextNoteId = 1;
  nextEventId = 1;
}

function withDemoLabel(text: string): string {
  return `${DEMO_BANNER}\n${text}`;
}

function touch(): void {
  touchCount += 1;
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function cloneTask(task: Task): Task {
  return { ...task };
}

function normalizeKey(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new IdempotencyKeyInvalid("idempotency_key must be a string.");
  const key = raw.trim();
  if (!key) return null;
  if (key.length > KEY_MAX || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new IdempotencyKeyInvalid(BAD_KEY);
  }
  return key;
}

function evictOldestTask(): void {
  let index = 0;
  for (let i = 1; i < tasks.length; i++) {
    const row = tasks[i];
    const oldest = tasks[index];
    if (row.created_at < oldest.created_at || (row.created_at === oldest.created_at && row.id < oldest.id)) {
      index = i;
    }
  }
  tasks.splice(index, 1);
  // Leave the idempotency row. A retry inside the 24 hour window has to
  // replay the stored result after this task row is gone.
}

function sessionCount(agentId: string): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.agent_id === agentId) count += 1;
  }
  return count;
}

/** Drops the least-recently updated session for one agent. Equal timestamps keep the earlier insert. */
function evictOldestSession(agentId: string, protectId?: string): boolean {
  let oldest: Session | null = null;
  for (const session of sessions.values()) {
    if (session.agent_id !== agentId || session.id === protectId) continue;
    if (!oldest || session.updated_at < oldest.updated_at) oldest = session;
  }
  if (!oldest) return false;
  sessions.delete(oldest.id);
  return true;
}

function evictOldestNote(): void {
  let index = 0;
  for (let i = 1; i < notes.length; i++) {
    const row = notes[i];
    const oldest = notes[index];
    if (row.updated_at < oldest.updated_at || (row.updated_at === oldest.updated_at && row.id < oldest.id)) {
      index = i;
    }
  }
  notes.splice(index, 1);
}

function evictOldestAgent(): void {
  let oldest: DemoAgent | null = null;
  for (const agent of agents.values()) {
    if (!oldest || agent.last_seen_at < oldest.last_seen_at || (agent.last_seen_at === oldest.last_seen_at && agent.id < oldest.id)) {
      oldest = agent;
    }
  }
  if (!oldest) return;
  agents.delete(oldest.id);
  for (const [id, session] of sessions) {
    if (session.agent_id === oldest.id) sessions.delete(id);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].agent_id === oldest.id) events.splice(i, 1);
  }
}

function evictEvents(): void {
  while (events.length > DEMO_CAPS.events) {
    let index = 0;
    for (let i = 1; i < events.length; i++) {
      if (events[i].created_at < events[index].created_at || (events[i].created_at === events[index].created_at && events[i].id < events[index].id)) {
        index = i;
      }
    }
    events.splice(index, 1);
  }
}

function evictIdempotency(): void {
  while (idempotency.size > DEMO_CAPS.idempotency) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, row] of idempotency) {
      if (row.storedAt < oldestAt) {
        oldestAt = row.storedAt;
        oldestKey = key;
      }
    }
    if (oldestKey == null) return;
    idempotency.delete(oldestKey);
  }
}

function actorFields(actor: Actor | null | undefined): { actor_type: Task["actor_type"]; actor_id: string | null } {
  if (!actor) return { actor_type: null, actor_id: null };
  return { actor_type: actor.actor_type, actor_id: actor.actor_id };
}

export interface DemoReportInput {
  agent_id: string;
  platform?: string;
  machine?: string;
  display_name?: string;
  session_id?: string;
  kind: string;
  title?: string;
  detail?: Record<string, unknown>;
  project?: string;
  summary?: string;
  status?: string;
}

function applyReport(input: DemoReportInput): void {
  touch();
  const now = iso(nowFn());
  const agentId = slugify(input.agent_id);
  const existing = agents.get(agentId);
  if (!existing) {
    if (agents.size >= DEMO_CAPS.agents) evictOldestAgent();
    agents.set(agentId, {
      id: agentId,
      platform: input.platform ?? "other",
      machine: input.machine ?? null,
      display_name: input.display_name ?? null,
      last_seen_at: now,
    });
  } else {
    existing.last_seen_at = now;
    if (input.platform) existing.platform = input.platform;
    if (input.machine) existing.machine = input.machine;
    if (input.display_name) existing.display_name = input.display_name;
  }

  if (input.session_id) {
    const status = input.status ?? KIND_TO_STATUS[input.kind] ?? "active";
    const session = sessions.get(input.session_id) ?? null;
    const isClosed = session?.status === "done" || session?.status === "failed";
    const reopens = input.kind === "session_start" || input.status === "active";
    if (!session) {
      while (sessionCount(agentId) >= DEMO_CAPS.sessionsPerAgent) {
        if (!evictOldestSession(agentId)) break;
      }
      sessions.set(input.session_id, {
        id: input.session_id,
        agent_id: agentId,
        project: input.project ?? null,
        status,
        summary: input.summary ?? null,
        started_at: now,
        ended_at: input.kind === "session_end" ? now : null,
        updated_at: now,
      });
    } else if (!isClosed || reopens) {
      const moved = session.agent_id !== agentId;
      session.agent_id = agentId;
      session.status = status;
      session.updated_at = now;
      if (input.project) session.project = input.project;
      if (input.summary) session.summary = input.summary;
      if (input.kind === "session_end") session.ended_at = now;
      if (isClosed && reopens) session.ended_at = null;
      if (moved) {
        while (sessionCount(agentId) > DEMO_CAPS.sessionsPerAgent) {
          if (!evictOldestSession(agentId, session.id)) break;
        }
      }
    }
  }

  events.push({
    id: nextEventId++,
    agent_id: agentId,
    session_id: input.session_id ?? null,
    kind: input.kind,
    title: input.title ?? null,
    detail: input.detail ?? null,
    created_at: now,
  });
  evictEvents();
}

export function demoReport(input: DemoReportInput): Promise<void> {
  return enqueue(async () => {
    applyReport(input);
  });
}

function fleetSnapshot(): { agents: FleetAgent[]; events: Event[] } {
  touch();
  const now = nowFn();
  const sessionList = [...sessions.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const agentRows = [...agents.values()].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  const fleetAgents: FleetAgent[] = agentRows.map((agent) => {
    const mine = sessionList.filter((session) => session.agent_id === agent.id);
    const open = mine.find((session) => session.status === "active" || session.status === "waiting") ?? null;
    const lastSeen = agent.last_seen_at ? new Date(agent.last_seen_at).getTime() : 0;
    const offline = now - lastSeen > OFFLINE_AFTER_MS;
    const derived = offline
      ? "offline"
      : ((open?.status ?? mine[0]?.status ?? "done") as FleetAgent["derived_status"]);
    return {
      ...agent,
      current_session: open,
      recent_sessions: mine.slice(0, 5),
      derived_status: derived,
      pending_messages: 0,
      unread_replies: 0,
    };
  });
  const ordered = [...events].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  return { agents: fleetAgents, events: ordered };
}

function formatFleet(snapshot: { agents: FleetAgent[]; events: Event[] }): string {
  if (snapshot.agents.length === 0) {
    return withDemoLabel("No agents have reported in this process.");
  }
  const lines: string[] = [];
  for (const agent of snapshot.agents) {
    const name = agent.display_name ?? agent.id;
    const session = agent.current_session;
    lines.push(
      `- ${name} [${agent.platform}${agent.machine ? ` @ ${agent.machine}` : ""}] — ${agent.derived_status.toUpperCase()}` +
        (session
          ? ` — ${session.summary ?? session.project ?? session.id} (project: ${session.project ?? "n/a"})`
          : " — no open session"),
    );
  }
  lines.push("", "Recent events:");
  for (const event of snapshot.events.slice(0, 15)) {
    lines.push(`- [${event.created_at}] ${event.agent_id}: ${event.kind}${event.title ? ` — ${event.title}` : ""}`);
  }
  return withDemoLabel(lines.join("\n"));
}

export interface DemoRememberInput {
  content: string;
  key?: string;
  tags?: string[];
  agent_id?: string;
}

function rememberUnlocked(input: DemoRememberInput): MemoryItem {
  touch();
  const now = iso(nowFn());
  const key = input.key ?? null;
  const tags = input.tags ?? [];
  const agentId = input.agent_id ?? null;
  if (key) {
    const existing = notes.find((note) => note.key === key);
    if (existing) {
      existing.content = input.content;
      existing.tags = tags;
      existing.agent_id = agentId;
      existing.updated_at = now;
      return { ...existing, tags: [...existing.tags] };
    }
  }
  if (notes.length >= DEMO_CAPS.notes) evictOldestNote();
  const item: MemoryItem = {
    id: nextNoteId++,
    key,
    content: input.content,
    tags,
    agent_id: agentId,
    created_at: now,
    updated_at: now,
  };
  notes.push(item);
  return { ...item, tags: [...item.tags] };
}

export function demoRemember(input: DemoRememberInput): Promise<MemoryItem> {
  return enqueue(async () => rememberUnlocked(input));
}

export interface DemoRecallInput {
  query?: string;
  key?: string;
  tags?: string[];
  limit?: number;
}

function recallUnlocked(input: DemoRecallInput): MemoryItem[] {
  touch();
  const limit = input.limit ?? 20;
  const query = input.query?.toLowerCase() ?? null;
  const tags = input.tags && input.tags.length > 0 ? input.tags : null;
  return notes
    .filter((note) => {
      if (input.key != null && note.key !== input.key) return false;
      if (query != null && !note.content.toLowerCase().includes(query)) return false;
      if (tags && !tags.some((tag) => note.tags.includes(tag))) return false;
      return true;
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id)
    .slice(0, limit)
    .map((note) => ({ ...note, tags: [...note.tags] }));
}

export function demoRecall(input: DemoRecallInput): Promise<MemoryItem[]> {
  return enqueue(async () => recallUnlocked(input));
}

export function demoFindMemoryByKey(key: string): Promise<MemoryItem | null> {
  return enqueue(async () => {
    touch();
    const found = notes.find((note) => note.key === key);
    return found ? { ...found, tags: [...found.tags] } : null;
  });
}

export interface DemoCreateTaskInput {
  title: string;
  description?: string;
  project?: string;
  platform?: string;
  machine?: string;
  priority?: number;
  reviewer_platform?: string;
  created_by?: string;
  /** From the authenticated principal. Never taken from the request body. */
  actor?: Actor | null;
  idempotency_key?: string | null;
}

function createTaskUnlocked(input: DemoCreateTaskInput): Task {
  touch();
  const key = normalizeKey(input.idempotency_key);
  const actor = input.actor ?? null;
  const scope = key ? idempotencyScope(actor, IDEMPOTENCY_ROUTE.createTask) : null;
  const hash = key
    ? hashPayload(payloadOf(input, [
      "title",
      "description",
      "project",
      "platform",
      "machine",
      "priority",
      "reviewer_platform",
      "created_by",
    ]))
    : null;
  const mapKey = scope && key ? `${scope}\0${key}` : null;
  const nowMs = nowFn();
  if (mapKey && hash) {
    const row = idempotency.get(mapKey);
    if (row && row.expiresAt > nowMs) {
      if (row.hash !== hash) throw new IdempotencyConflict(MISMATCH);
      return cloneTask(row.task);
    }
  }

  const recorded = actorFields(actor);
  const now = iso(nowMs);
  if (tasks.length >= DEMO_CAPS.tasks) evictOldestTask();
  const task: Task = {
    id: nextTaskId++,
    title: input.title,
    description: input.description ?? null,
    project: input.project ?? null,
    platform: input.platform ?? "any",
    machine: input.machine ?? null,
    priority: input.priority ?? 2,
    status: "queued",
    reviewer_platform: input.reviewer_platform ?? null,
    assigned_agent: null,
    session_id: null,
    result: null,
    cost_usd: null,
    created_by: input.created_by ?? "dashboard",
    actor_type: recorded.actor_type,
    actor_id: recorded.actor_id,
    created_at: now,
    claimed_at: null,
    updated_at: now,
    completed_at: null,
  };
  tasks.push(task);
  if (mapKey && hash) {
    idempotency.set(mapKey, { hash, task: cloneTask(task), expiresAt: nowMs + IDEMPOTENCY_TTL_MS, storedAt: nowMs });
    evictIdempotency();
  }
  return cloneTask(task);
}

export function demoCreateTask(input: DemoCreateTaskInput): Promise<Task> {
  return enqueue(async () => createTaskUnlocked(input));
}

export function demoListTasks(input?: { status?: string; limit?: number }): Promise<Task[]> {
  return enqueue(async () => {
    touch();
    const limit = input?.limit ?? 100;
    const status = input?.status ?? "all";
    return tasks
      .filter((task) => {
        if (status === "all") return true;
        if (status === "open") return OPEN_STATUSES.includes(task.status);
        return task.status === status;
      })
      .sort((a, b) => a.status.localeCompare(b.status) || a.priority - b.priority || b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map(cloneTask);
  });
}

export function demoGetTask(id: number): Promise<Task | null> {
  return enqueue(async () => {
    touch();
    const task = tasks.find((row) => row.id === id);
    return task ? cloneTask(task) : null;
  });
}

/**
 * Same rule as claimNextTask: only a queued row can be taken, and the
 * status check happens again after a yield so two callers cannot both win.
 * The enqueue lock is what makes the second caller see the first write.
 */
export function demoClaimNextTask(input: {
  platform: string;
  machine?: string;
  agent_id: string;
}): Promise<Task | null> {
  return enqueue(async () => {
    touch();
    const candidates = tasks
      .filter((task) => task.status === "queued" && (task.platform === input.platform || task.platform === "any"))
      .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at))
      .slice(0, 10);
    // The real claim selects, then updates. The yield is that gap.
    await Promise.resolve();
    const now = iso(nowFn());
    for (const candidate of candidates) {
      if (candidate.machine && input.machine && candidate.machine !== input.machine) continue;
      if (candidate.machine && !input.machine) continue;
      const current = tasks.find((task) => task.id === candidate.id);
      // Captured before the yield. The real UPDATE ... WHERE status = 'queued'
      // is the only thing that stops a second caller who already read the row.
      // Re-reading here would hide a missing lock, because the first caller
      // would finish the write before the second resumed.
      const status = current?.status;
      await Promise.resolve();
      if (!current || status !== "queued") continue;
      current.status = "claimed";
      current.assigned_agent = input.agent_id;
      current.claimed_at = now;
      current.updated_at = now;
      return cloneTask(current);
    }
    return null;
  });
}

export function demoUpdateTask(input: {
  id: number;
  status?: TaskStatus;
  result?: string;
  cost_usd?: number;
  session_id?: string;
  assigned_agent?: string;
}): Promise<Task> {
  return enqueue(async () => {
    touch();
    const task = tasks.find((row) => row.id === input.id);
    if (!task) throw new Error("Task not found");
    const now = iso(nowFn());
    task.updated_at = now;
    if (input.status !== undefined && input.status !== null) {
      task.status = input.status;
      if (input.status === "done" || input.status === "failed" || input.status === "cancelled") {
        task.completed_at = now;
      }
    }
    if (input.result !== undefined) task.result = input.result;
    if (input.cost_usd !== undefined) task.cost_usd = input.cost_usd;
    if (input.session_id !== undefined) task.session_id = input.session_id;
    if (input.assigned_agent !== undefined) task.assigned_agent = input.assigned_agent;
    return cloneTask(task);
  });
}

function formatTasks(rows: Task[]): string {
  if (rows.length === 0) return withDemoLabel("Task queue is empty.");
  const text = rows
    .map(
      (task) =>
        `#${task.id} [${task.status.toUpperCase()}] (${task.platform}, p${task.priority}) ${task.title}` +
        (task.project ? ` — project: ${task.project}` : "") +
        (task.assigned_agent ? ` — agent: ${task.assigned_agent}` : "") +
        (task.result ? `\n   result: ${task.result.slice(0, 200)}` : ""),
    )
    .join("\n");
  return withDemoLabel(text);
}

function formatRecall(items: MemoryItem[]): string {
  if (items.length === 0) return withDemoLabel("No matching memory.");
  const text = items
    .map(
      (item) =>
        `#${item.id}${item.key ? ` [${item.key}]` : ""}${item.tags.length ? ` (${item.tags.join(", ")})` : ""} by ${item.agent_id ?? "unknown"} @ ${item.updated_at}\n${item.content}`,
    )
    .join("\n\n");
  return withDemoLabel(text);
}

function formatClaim(task: Task): string {
  return withDemoLabel(
    `Claimed task #${task.id}: ${task.title}\n` +
      (task.project ? `Project: ${task.project}\n` : "") +
      (task.reviewer_platform ? `Review by: ${task.reviewer_platform} when done\n` : "") +
      `Instructions:\n${task.description ?? task.title}\n\n` +
      `When finished, call update_task (id: ${task.id}) with status 'done' or 'failed' and a result summary.`,
  );
}

function dryRunRejected(): McpToolResult {
  return mcpToolError("validation_failed", {
    message: "dry_run must be a boolean.",
    fields: { dry_run: "Use true to preview, or false to apply." },
  });
}

export async function demoReportStatusTool(args: {
  agent_id: string;
  platform?: DemoReportInput["platform"];
  machine?: string;
  display_name?: string;
  session_id?: string;
  status?: string;
  title: string;
  project?: string;
  summary?: string;
}): Promise<McpToolResult> {
  await demoReport({
    agent_id: args.agent_id,
    platform: args.platform,
    machine: args.machine,
    display_name: args.display_name,
    session_id: args.session_id ?? `${args.agent_id}-default`,
    kind: "status",
    status: args.status,
    title: args.title,
    project: args.project,
    summary: args.summary ?? args.title,
  });
  return { content: [{ type: "text", text: withDemoLabel("Status reported to Agent Kontrol.") }] };
}

export async function demoFleetStatusTool(): Promise<McpToolResult> {
  const snapshot = await enqueue(async () => fleetSnapshot());
  return { content: [{ type: "text", text: formatFleet(snapshot) }] };
}

export async function demoRememberTool(args: {
  content: string;
  key?: string;
  tags?: string[];
  agent_id?: string;
  dry_run?: unknown;
}): Promise<McpToolResult> {
  const badKey = memoryKeyError(args.key);
  if (badKey) return badKey;
  const dry = readDryRun(args.dry_run);
  if (!dry.ok) return dryRunRejected();
  if (dry.dryRun) {
    const existing = args.key ? await demoFindMemoryByKey(args.key) : null;
    const preview = diffMemoryWrite(existing, args as MemoryWriteInput);
    return { content: [{ type: "text", text: JSON.stringify(preview) }] };
  }
  const item = await demoRemember(args);
  return {
    content: [{ type: "text", text: withDemoLabel(`Stored memory #${item.id}${item.key ? ` (key: ${item.key})` : ""}.`) }],
  };
}

export async function demoRecallTool(args: DemoRecallInput): Promise<McpToolResult> {
  const badKey = memoryKeyError(args.key);
  if (badKey) return badKey;
  const items = await demoRecall(args);
  return { content: [{ type: "text", text: formatRecall(items) }] };
}

export async function demoCreateTaskTool(
  args: Omit<DemoCreateTaskInput, "actor">,
  actor: Actor | null,
): Promise<McpToolResult> {
  const task = await demoCreateTask({
    title: args.title,
    description: args.description,
    project: args.project,
    platform: args.platform,
    machine: args.machine,
    priority: args.priority,
    reviewer_platform: args.reviewer_platform,
    created_by: args.created_by,
    idempotency_key: args.idempotency_key,
    actor,
  });
  return {
    content: [{ type: "text", text: withDemoLabel(`Task #${task.id} queued for ${task.platform} (priority ${task.priority}).`) }],
  };
}

export async function demoTaskQueueTool(args: { status?: string }): Promise<McpToolResult> {
  const rows = await demoListTasks({ status: args.status ?? "open", limit: 40 });
  return { content: [{ type: "text", text: formatTasks(rows) }] };
}

export async function demoClaimTaskTool(args: {
  platform: string;
  machine?: string;
  agent_id: string;
}): Promise<McpToolResult> {
  const task = await demoClaimNextTask(args);
  if (!task) return { content: [{ type: "text", text: withDemoLabel(DEMO_EMPTY_CLAIM) }] };
  return { content: [{ type: "text", text: formatClaim(task) }] };
}

export async function demoUpdateTaskTool(args: {
  id: number;
  status?: TaskStatus;
  result?: string;
  cost_usd?: number;
  agent_id?: string;
  dry_run?: unknown;
}): Promise<McpToolResult> {
  const dry = readDryRun(args.dry_run);
  if (!dry.ok) return dryRunRejected();
  if (dry.dryRun) {
    const task = await demoGetTask(args.id);
    if (!task) return mcpToolError("task_not_found");
    return { content: [{ type: "text", text: JSON.stringify(diffTaskUpdate(task, args)) }] };
  }
  let task: Task;
  try {
    task = await demoUpdateTask({
      id: args.id,
      status: args.status,
      result: args.result,
      cost_usd: args.cost_usd,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Task not found") return mcpToolError("task_not_found");
    throw error;
  }
  if (args.status && args.agent_id) {
    await demoReport({
      agent_id: args.agent_id,
      kind: args.status === "failed" ? "error" : "status",
      title: `Task #${task.id} → ${args.status}: ${task.title}`,
      detail: { task_id: task.id },
    });
  }
  return { content: [{ type: "text", text: withDemoLabel(`Task #${task.id} updated (${task.status}).`) }] };
}
