/**
 * Process-local store for demo mode (no DATABASE_URL).
 *
 * The five MCP write tools record here for the life of this process.
 * get_fleet_status, recall, get_task_queue, and list_activity read it back. The data is
 * gone when the process exits. Every successful tool response from this
 * module carries DEMO_BANNER so a client cannot treat it as durable.
 *
 * This module does not import the database. With DATABASE_URL set, callers
 * must not use it. Caps evict the oldest row so a public demo cannot grow
 * without a limit. Sessions are capped per agent. An idempotency key stays
 * until its own expiry: evicting the task row must not drop it.
 */
import { currentActor, type Actor } from "./actor";
import {
  activityDetail,
  activityRow,
  attachReceipt,
  readReceipt,
  withReceipt,
  type ActivityRow,
  type Receipt,
} from "./activity";
import { mcpToolError, memoryKeyError, type McpToolResult } from "./api-error";
import { diffMemoryWrite, diffTaskUpdate, readDryRun, type MemoryWriteInput } from "./dry-run";
import { requeueBlock } from "./requeue";
import { StaleWrite, absentRevision, memoryRevision, taskRevision } from "./revision";
import {
  IDEMPOTENCY_ROUTE,
  IDEMPOTENCY_TTL_MS,
  IdempotencyConflict,
  IdempotencyKeyInvalid,
  hashPayload,
  idempotencyScope,
  payloadOf,
} from "./idempotency";
import type { Event, FleetAgent, MemoryItem, Message, Session, Task, TaskStatus } from "./types";

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
  messages: 200,
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
/** Test-only. A task-status write rolls back both the row and the event. */
let activityFault: "after-write" | "after-event" | null = null;
let touchCount = 0;
let tail: Promise<void> = Promise.resolve();
let nextTaskId = 1;
let nextNoteId = 1;
let nextEventId = 1;
let nextMessageId = 1;

const agents = new Map<string, DemoAgent>();
const sessions = new Map<string, Session>();
const events: Event[] = [];
const notes: MemoryItem[] = [];
const tasks: Task[] = [];
const messages: Message[] = [];
const idempotency = new Map<string, IdemRow>();

interface MessageIdemRow {
  hash: string;
  message: Message;
  expiresAt: number;
  storedAt: number;
}

/** Separate from task idempotency. Evicting a message must not drop its key. */
const messageIdempotency = new Map<string, MessageIdemRow>();

/** Tests move the 24 hour idempotency window. Production never calls this. */
export function setDemoClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/**
 * Fail a task-status write after the row changes, or after the event is
 * pushed. Both leave the store as it was. Production never calls this.
 * On the SQL path the same two failures are one statement: neither commits.
 */
export function setActivityFaultForTests(fault: "after-write" | "after-event" | null): void {
  activityFault = fault;
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
  activityFault = null;
  agents.clear();
  sessions.clear();
  events.length = 0;
  notes.length = 0;
  tasks.length = 0;
  messages.length = 0;
  idempotency.clear();
  messageIdempotency.clear();
  nextTaskId = 1;
  nextNoteId = 1;
  nextEventId = 1;
  nextMessageId = 1;
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

function receiptOf(event: Event): Receipt {
  return { id: String(event.id), kind: event.kind, at: event.created_at };
}

function findActivity(kind: string, key: string, value: string): Event | undefined {
  return events.find((event) => event.kind === kind && String(event.detail?.[key] ?? "") === value);
}

/** An audit row that is not a task-status change. No fault hook. */
function pushActivity(kind: string, title: string, tool: string, extra: Record<string, unknown>): Receipt {
  const event: Event = {
    id: nextEventId++,
    agent_id: "",
    session_id: null,
    kind,
    title,
    detail: activityDetail(tool, currentActor(), extra),
    created_at: iso(nowFn()),
  };
  events.push(event);
  evictEvents();
  return receiptOf(event);
}

function restoreTask(task: Task, snapshot: Task): void {
  task.status = snapshot.status;
  task.assigned_agent = snapshot.assigned_agent;
  task.claimed_at = snapshot.claimed_at;
  task.updated_at = snapshot.updated_at;
  task.completed_at = snapshot.completed_at;
  task.result = snapshot.result;
  task.cost_usd = snapshot.cost_usd;
  task.session_id = snapshot.session_id;
  task.actor_type = snapshot.actor_type;
  task.actor_id = snapshot.actor_id;
}

/**
 * The event is pushed in the same turn as the task mutation. A fault undoes
 * both, in either order, before the caller observes the write.
 */
function finishTaskActivity(task: Task, snapshot: Task, kind: string, title: string, tool: string, extra: Record<string, unknown>): Receipt {
  if (activityFault === "after-write") {
    restoreTask(task, snapshot);
    activityFault = null;
    throw new Error("activity fault after write");
  }
  const event: Event = {
    id: nextEventId++,
    agent_id: "",
    session_id: null,
    kind,
    title,
    detail: activityDetail(tool, currentActor(), extra),
    created_at: iso(nowFn()),
  };
  events.push(event);
  evictEvents();
  if (activityFault === "after-event") {
    const index = events.findIndex((row) => row.id === event.id);
    if (index >= 0) events.splice(index, 1);
    restoreTask(task, snapshot);
    activityFault = null;
    throw new Error("activity fault after event");
  }
  return receiptOf(event);
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

function applyReport(input: DemoReportInput): Receipt {
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

  const event: Event = {
    id: nextEventId++,
    agent_id: agentId,
    session_id: input.session_id ?? null,
    kind: input.kind,
    title: input.title ?? null,
    detail: input.detail ?? null,
    created_at: now,
  };
  events.push(event);
  evictEvents();
  return { id: String(event.id), kind: event.kind, at: event.created_at };
}

export function demoReport(input: DemoReportInput): Promise<Receipt> {
  return enqueue(async () => applyReport(input));
}

export interface DemoActivityFilter {
  actor: string | null;
  kind: string | null;
  since: string | null;
  until: string | null;
}

/** In-memory events. The caller pages them. Empty until a demo write records one. */
export function demoListActivity(filter: DemoActivityFilter): Promise<ActivityRow[]> {
  return enqueue(async () => {
    touch();
    const rows = events.filter((event) => {
      const detail = event.detail;
      const actorId = detail && detail.actor_id != null && detail.actor_id !== "" ? String(detail.actor_id) : null;
      if (filter.actor && actorId !== filter.actor) return false;
      if (filter.kind && event.kind !== filter.kind) return false;
      if (filter.since && event.created_at < filter.since) return false;
      if (filter.until && event.created_at > filter.until) return false;
      return true;
    });
    return rows.map((event) => activityRow({
      id: event.id,
      agent_id: event.agent_id,
      session_id: event.session_id,
      kind: event.kind,
      title: event.title,
      detail: event.detail,
      created_at: event.created_at,
    }));
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
      const saved = { ...existing, tags: [...existing.tags] };
      return attachReceipt(saved, pushActivity("remember", `Stored memory #${saved.id}`, "remember", {
        memory_id: String(saved.id),
        memory_key: saved.key,
      }));
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
  const saved = { ...item, tags: [...item.tags] };
  return attachReceipt(saved, pushActivity("remember", `Stored memory #${saved.id}`, "remember", {
    memory_id: String(saved.id),
    memory_key: saved.key,
  }));
}

export function demoRemember(input: DemoRememberInput): Promise<MemoryItem> {
  return enqueue(async () => rememberUnlocked(input));
}

/**
 * Compare-and-write for a demo confirm. The check and the write stay in one
 * turn of the queue with no await between them, so a second caller sees the
 * first write. A mismatch throws and leaves the note as it was.
 */
export function demoRememberGuarded(
  input: DemoRememberInput & { expected_revision: string },
): Promise<MemoryItem> {
  return enqueue(async () => {
    const key = input.key ?? null;
    const expected = input.expected_revision;
    if (!key) {
      if (expected !== absentRevision()) throw new StaleWrite(absentRevision());
      return rememberUnlocked(input);
    }
    const existing = notes.find((note) => note.key === key);
    if (!existing) {
      if (expected === absentRevision()) return rememberUnlocked(input);
      throw new Error("Memory not found");
    }
    const current = memoryRevision(existing);
    if (current !== expected) throw new StaleWrite(current);
    return rememberUnlocked(input);
  });
}

/** Test hook. Production has no memory delete route. */
export function demoDeleteMemoryForTests(key: string): void {
  const index = notes.findIndex((note) => note.key === key);
  if (index >= 0) notes.splice(index, 1);
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
      const replayed = cloneTask(row.task);
      const prior = findActivity("create_task", "task_id", String(replayed.id));
      return prior ? attachReceipt(replayed, receiptOf(prior)) : replayed;
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
  const saved = cloneTask(task);
  return attachReceipt(saved, pushActivity("create_task", `Task #${saved.id} queued`, "create_task", {
    task_id: String(saved.id),
  }));
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
      const snapshot = cloneTask(current);
      current.status = "claimed";
      current.assigned_agent = input.agent_id;
      current.claimed_at = now;
      current.updated_at = now;
      const receipt = finishTaskActivity(
        current,
        snapshot,
        "task_claimed",
        `Claimed task #${current.id}: ${current.title}`,
        "claim_task",
        { task_id: String(current.id), status: current.status, assigned_agent: current.assigned_agent },
      );
      return attachReceipt(cloneTask(current), receipt);
    }
    return null;
  });
}

function updateTaskUnlocked(input: {
  id: number;
  status?: TaskStatus;
  result?: string;
  cost_usd?: number;
  session_id?: string;
  assigned_agent?: string;
  /** Set only when the caller passes an authenticated actor. Omitted leaves the columns. */
  actor?: Actor | null;
  eventKind?: string;
  activityTool?: string;
}): Task {
  touch();
  const task = tasks.find((row) => row.id === input.id);
  if (!task) throw new Error("Task not found");
  const snapshot = cloneTask(task);
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
  if (input.actor) {
    task.actor_type = input.actor.actor_type;
    task.actor_id = input.actor.actor_id;
  }
  const kind = input.eventKind ?? "task_updated";
  const tool = input.activityTool ?? "update_task";
  const receipt = finishTaskActivity(
    task,
    snapshot,
    kind,
    `Task #${task.id} → ${task.status}: ${task.title}`,
    tool,
    { task_id: String(task.id), status: task.status },
  );
  return attachReceipt(cloneTask(task), receipt);
}

export function demoUpdateTask(input: {
  id: number;
  status?: TaskStatus;
  result?: string;
  cost_usd?: number;
  session_id?: string;
  assigned_agent?: string;
}): Promise<Task> {
  return enqueue(async () => updateTaskUnlocked(input));
}

/**
 * Compare-and-write for a demo task confirm. No await between the revision
 * check and the write, so two confirms with one token cannot both apply.
 */
export function demoUpdateTaskGuarded(input: {
  id: number;
  status?: TaskStatus;
  result?: string;
  cost_usd?: number;
  session_id?: string;
  assigned_agent?: string;
  expected_revision: string;
}): Promise<Task> {
  return enqueue(async () => {
    const task = tasks.find((row) => row.id === input.id);
    if (!task) throw new Error("Task not found");
    const current = taskRevision(task);
    if (current !== input.expected_revision) throw new StaleWrite(current);
    return updateTaskUnlocked(input);
  });
}

/** Test hook. Production has no task delete route. */
export function demoDeleteTaskForTests(id: number): void {
  const index = tasks.findIndex((task) => task.id === id);
  if (index >= 0) tasks.splice(index, 1);
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
  const actor = currentActor();
  const receipt = await demoReport({
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
    detail: activityDetail("report_status", actor, {}),
  });
  return withReceipt(withDemoLabel("Status reported to Agent Kontrol."), receipt);
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
    const revision = existing ? memoryRevision(existing) : absentRevision();
    const preview = diffMemoryWrite(existing, args as MemoryWriteInput, revision);
    return { content: [{ type: "text", text: JSON.stringify(preview) }] };
  }
  const item = await demoRemember(args);
  return withReceipt(
    withDemoLabel(`Stored memory #${item.id}${item.key ? ` (key: ${item.key})` : ""}.`),
    readReceipt(item),
  );
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
  return withReceipt(
    withDemoLabel(`Task #${task.id} queued for ${task.platform} (priority ${task.priority}).`),
    readReceipt(task),
  );
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
  return withReceipt(formatClaim(task), readReceipt(task));
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
    return { content: [{ type: "text", text: JSON.stringify(diffTaskUpdate(task, args, taskRevision(task))) }] };
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
  return withReceipt(withDemoLabel(`Task #${task.id} updated (${task.status}).`), readReceipt(task));
}

function cloneMessage(message: Message): Message {
  return { ...message };
}

function evictMessageIdempotency(): void {
  while (messageIdempotency.size > DEMO_CAPS.idempotency) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, row] of messageIdempotency) {
      if (row.storedAt < oldestAt) {
        oldestAt = row.storedAt;
        oldestKey = key;
      }
    }
    if (oldestKey == null) return;
    messageIdempotency.delete(oldestKey);
  }
}

/** Messages the demo send_message tool stored. The idempotency map is separate. */
export function demoMessagesForTests(): Message[] {
  return messages.map(cloneMessage);
}

export type DemoSendResult = { kind: "missing" } | { kind: "message"; message: Message };

/**
 * Inbound message for an agent that already reported. The agent check happens
 * before the idempotency row is written. A replay returns the original message
 * and does not insert another row. Dropping the message at the cap leaves the key.
 */
export function demoSendMessage(input: {
  agent_id: string;
  body: string;
  created_by?: string;
  actor?: Actor | null;
  idempotency_key?: string | null;
}): Promise<DemoSendResult> {
  return enqueue(async () => {
    touch();
    const slug = slugify(input.agent_id);
    if (!slug || !agents.has(slug)) return { kind: "missing" };

    const key = normalizeKey(input.idempotency_key);
    const actor = input.actor ?? null;
    const scope = key ? idempotencyScope(actor, IDEMPOTENCY_ROUTE.enqueueMessage) : null;
    const hash = key ? hashPayload(payloadOf(input, ["agent_id", "body", "created_by"])) : null;
    const mapKey = scope && key ? `${scope}\0${key}` : null;
    const nowMs = nowFn();
    if (mapKey && hash) {
      const row = messageIdempotency.get(mapKey);
      if (row && row.expiresAt > nowMs) {
        if (row.hash !== hash) throw new IdempotencyConflict(MISMATCH);
        const message = cloneMessage(row.message);
        const prior = findActivity("send_message", "message_id", String(message.id));
        return { kind: "message", message: prior ? attachReceipt(message, receiptOf(prior)) : message };
      }
    }

    const recorded = actorFields(actor);
    const now = iso(nowMs);
    if (messages.length >= DEMO_CAPS.messages) messages.shift();
    const id = nextMessageId++;
    const message: Message = {
      id,
      agent_id: slug,
      body: input.body,
      created_by: input.created_by ?? "dashboard",
      actor_type: recorded.actor_type,
      actor_id: recorded.actor_id,
      created_at: now,
      delivered_at: null,
      acked_at: null,
      direction: "inbound",
      in_reply_to: null,
      thread_id: String(id),
      read_by_dashboard_at: null,
    };
    messages.push(message);
    const receipt = pushActivity("send_message", `Message #${id} sent to ${slug}`, "send_message", {
      message_id: String(id),
    });
    if (mapKey && hash) {
      messageIdempotency.set(mapKey, {
        hash,
        message: cloneMessage(message),
        expiresAt: nowMs + IDEMPOTENCY_TTL_MS,
        storedAt: nowMs,
      });
      evictMessageIdempotency();
    }
    return { kind: "message", message: attachReceipt(cloneMessage(message), receipt) };
  });
}

export type DemoRequeueResult =
  | { kind: "missing" }
  | { kind: "blocked"; code: "forbidden" | "conflict"; message: string }
  | { kind: "preview"; task: Task; revision: string }
  | { kind: "task"; task: Task };

/**
 * Eligibility, the revision check, and the status write share one turn of the
 * queue. No await between the check and the write.
 */
export function demoRequeueTask(input: {
  id: number;
  callerId: string | null;
  dryRun: boolean;
  expectedRevision?: string;
  actor?: Actor | null;
}): Promise<DemoRequeueResult> {
  return enqueue(async () => {
    touch();
    const task = tasks.find((row) => row.id === input.id);
    if (!task) return { kind: "missing" };
    const block = requeueBlock(task, input.callerId);
    if (!block.ok) return { kind: "blocked", code: block.code, message: block.message };
    const revision = taskRevision(task);
    if (input.dryRun) return { kind: "preview", task: cloneTask(task), revision };
    if (input.expectedRevision !== undefined && revision !== input.expectedRevision) {
      throw new StaleWrite(revision);
    }
    const updated = updateTaskUnlocked({
      id: task.id,
      status: "queued",
      actor: input.actor,
      eventKind: "task_requeued",
      activityTool: "requeue_task",
    });
    return { kind: "task", task: updated };
  });
}

export type DemoDeleteResult =
  | { kind: "missing" }
  | { kind: "preview"; item: MemoryItem; revision: string }
  | { kind: "deleted"; item: MemoryItem };

/** Compare-and-delete. A missing key is not a successful delete, including `absent`. */
export function demoDeleteMemory(input: {
  key: string;
  dryRun: boolean;
  expectedRevision?: string;
}): Promise<DemoDeleteResult> {
  return enqueue(async () => {
    touch();
    const index = notes.findIndex((note) => note.key === input.key);
    if (index < 0) return { kind: "missing" };
    const current = notes[index];
    const revision = memoryRevision(current);
    if (input.dryRun) return { kind: "preview", item: { ...current, tags: [...current.tags] }, revision };
    if (input.expectedRevision !== undefined && revision !== input.expectedRevision) {
      throw new StaleWrite(revision);
    }
    const [removed] = notes.splice(index, 1);
    const item = { ...removed, tags: [...removed.tags] };
    const receipt = pushActivity("delete_note", `Deleted memory key "${input.key}"`, "delete_note", {
      memory_id: String(item.id),
      memory_key: input.key,
    });
    return { kind: "deleted", item: attachReceipt(item, receipt) };
  });
}
