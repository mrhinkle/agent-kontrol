import type { Actor } from "./actor";
import { IDEMPOTENCY_ROUTE, payloadOf, runIdempotent } from "./idempotency";
import { writeSessionNote } from "./session-memory";
import { sql, type SqlTag } from "./db";
import type { Event, FleetAgent, Message, MemoryItem, Session, Task, TaskStatus } from "./types";
import { asUnknownWriteOutcome } from "./write-outcome";

export interface ReportInput {
  agent_id: string;
  platform?: string;
  machine?: string;
  display_name?: string;
  session_id?: string;
  kind: string; // session_start | turn_start | waiting | notification | session_end | milestone | status | error | heartbeat
  title?: string;
  detail?: Record<string, unknown>;
  project?: string;
  summary?: string;
  status?: string; // explicit session status override
}

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

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Keep a connection loss typed so idempotency does not drop a claim that may have committed. */
function rethrowStore(e: unknown): never {
  const unknown = asUnknownWriteOutcome(e);
  if (unknown) throw unknown;
  throw new Error(errMsg(e));
}

export async function report(input: ReportInput): Promise<void> {
  const db = sql();
  const now = new Date().toISOString();
  const agentId = slugify(input.agent_id);

  // Only write metadata fields that were provided, so a bare MCP report
  // never clobbers platform/machine/display_name set by hooks (or vice versa).
  // COALESCE on conflict keeps existing values when the new side is null.
  const platform = input.platform ?? null;
  const machine = input.machine ?? null;
  const displayName = input.display_name ?? null;
  try {
    await db`
      insert into agents (id, platform, machine, display_name, last_seen_at)
      values (
        ${agentId},
        coalesce(${platform}, 'other'),
        ${machine},
        ${displayName},
        ${now}
      )
      on conflict (id) do update set
        last_seen_at = excluded.last_seen_at,
        platform = coalesce(${platform}, agents.platform),
        machine = coalesce(${machine}, agents.machine),
        display_name = coalesce(${displayName}, agents.display_name)
    `;
  } catch (e) {
    throw new Error(`agents upsert: ${errMsg(e)}`);
  }

  if (input.session_id) {
    const status = input.status ?? KIND_TO_STATUS[input.kind] ?? "active";
    let existing: { id: string; status: string } | null = null;
    try {
      const rows = await db`
        select id, status from sessions where id = ${input.session_id} limit 1
      `;
      existing = (rows[0] as { id: string; status: string } | undefined) ?? null;
    } catch (e) {
      throw new Error(`sessions select: ${errMsg(e)}`);
    }

    const isClosed = existing?.status === "done" || existing?.status === "failed";
    const reopens = input.kind === "session_start" || input.status === "active";

    if (!existing) {
      const project = input.project ?? null;
      const summary = input.summary ?? null;
      const endedAt = input.kind === "session_end" ? now : null;
      try {
        await db`
          insert into sessions (id, agent_id, status, updated_at, ended_at, project, summary)
          values (
            ${input.session_id},
            ${agentId},
            ${status},
            ${now},
            ${endedAt},
            ${project},
            ${summary}
          )
          on conflict (id) do update set
            agent_id = excluded.agent_id,
            status = excluded.status,
            updated_at = excluded.updated_at,
            ended_at = excluded.ended_at,
            project = coalesce(excluded.project, sessions.project),
            summary = coalesce(excluded.summary, sessions.summary)
        `;
      } catch (e) {
        throw new Error(`sessions insert: ${errMsg(e)}`);
      }
    } else if (!isClosed || reopens) {
      // A closed session only reopens on an explicit session_start / active
      // report — a straggling Stop/heartbeat can't resurrect it.
      const project = input.project ?? null;
      const summary = input.summary ?? null;
      const setEndedAt = input.kind === "session_end";
      const clearEndedAt = Boolean(isClosed && reopens);
      try {
        await db`
          update sessions set
            status = ${status},
            updated_at = ${now},
            project = coalesce(${project}, project),
            summary = coalesce(${summary}, summary),
            ended_at = case
              when ${setEndedAt} then ${now}::timestamptz
              when ${clearEndedAt} then null
              else ended_at
            end
          where id = ${input.session_id}
        `;
      } catch (e) {
        throw new Error(`sessions update: ${errMsg(e)}`);
      }
    }
  }

  try {
    await db`
      insert into events (agent_id, session_id, kind, title, detail)
      values (
        ${agentId},
        ${input.session_id ?? null},
        ${input.kind},
        ${input.title ?? null},
        ${JSON.stringify(input.detail ?? null)}::jsonb
      )
    `;
  } catch (e) {
    throw new Error(`events insert: ${errMsg(e)}`);
  }

  // Any platform that ends a session (hook, watcher, or an MCP report with status
  // done or failed) leaves a short note in shared memory. Best effort and bounded:
  // it never fails the report, and ingest waits at most a couple of seconds for it.
  if (input.session_id && (input.kind === "session_end" || input.status === "done" || input.status === "failed")) {
    const work = writeSessionNote(input.session_id).catch((e) => console.error("[memory] session note failed", e));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, 2500)))]);
    clearTimeout(timer);
  }
}

const OFFLINE_AFTER_MS = 15 * 60 * 1000;

export async function fleet(): Promise<{ agents: FleetAgent[]; events: Event[] }> {
  const db = sql();
  let agentsData: FleetAgent[];
  let sessions: Session[];
  let events: Event[];
  let msgsData: { agent_id: string }[];
  let unreadData: { agent_id: string }[];
  try {
    const [agentsRows, sessionsRows, eventsRows, msgsRows, unreadRows] = await Promise.all([
      db`select * from agents order by last_seen_at desc`,
      db`select * from sessions order by updated_at desc limit 200`,
      // Background events (heartbeats, collector telemetry) are capped separately so
      // they can't push real work out of the window; History and Fleet hide them by default.
      db`(select * from events where kind not in ('heartbeat', 'telemetry') and created_at > now() - interval '14 days'
          order by created_at desc limit 120)
         union all
         (select * from events where kind in ('heartbeat', 'telemetry') order by created_at desc limit 40)
         order by created_at desc`,
      // Inbound still waiting for the agent (legacy rows have no direction → treat as inbound).
      db`select agent_id from messages
         where acked_at is null
           and (direction = 'inbound' or direction is null)`,
      db`select agent_id from messages
         where direction = 'outbound' and read_by_dashboard_at is null`,
    ]);
    agentsData = agentsRows as FleetAgent[];
    sessions = sessionsRows as Session[];
    events = eventsRows as Event[];
    msgsData = msgsRows as { agent_id: string }[];
    unreadData = unreadRows as { agent_id: string }[];
  } catch (e) {
    // Pre-migration DBs lack direction / read_by_dashboard_at — fall back.
    try {
      const [agentsRows, sessionsRows, eventsRows, msgsRows] = await Promise.all([
        db`select * from agents order by last_seen_at desc`,
        db`select * from sessions order by updated_at desc limit 200`,
        // Background events (heartbeats, collector telemetry) are capped separately so
        // they can't push real work out of the window; History and Fleet hide them by default.
        db`(select * from events where kind not in ('heartbeat', 'telemetry') and created_at > now() - interval '14 days'
          order by created_at desc limit 120)
           union all
           (select * from events where kind in ('heartbeat', 'telemetry') order by created_at desc limit 40)
           order by created_at desc`,
        db`select agent_id from messages where acked_at is null`,
      ]);
      agentsData = agentsRows as FleetAgent[];
      sessions = sessionsRows as Session[];
      events = eventsRows as Event[];
      msgsData = msgsRows as { agent_id: string }[];
      unreadData = [];
    } catch (e2) {
      throw new Error(errMsg(e2));
    }
  }

  const pendingByAgent: Record<string, number> = {};
  for (const m of msgsData) {
    pendingByAgent[m.agent_id] = (pendingByAgent[m.agent_id] ?? 0) + 1;
  }
  const unreadByAgent: Record<string, number> = {};
  for (const m of unreadData) {
    unreadByAgent[m.agent_id] = (unreadByAgent[m.agent_id] ?? 0) + 1;
  }
  const now = Date.now();

  const agents: FleetAgent[] = agentsData.map((a) => {
    const mine = sessions.filter((s) => s.agent_id === a.id);
    const open = mine.find((s) => s.status === "active" || s.status === "waiting") ?? null;
    const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
    const offline = now - lastSeen > OFFLINE_AFTER_MS;
    // Fall back to the most recent session's status so a fresh failure
    // shows as FAILED, not a green DONE.
    const derived = offline
      ? "offline"
      : ((open?.status ?? mine[0]?.status ?? "done") as FleetAgent["derived_status"]);
    return {
      ...a,
      current_session: open,
      recent_sessions: mine.slice(0, 5),
      derived_status: derived,
      pending_messages: pendingByAgent[a.id] ?? 0,
      unread_replies: unreadByAgent[a.id] ?? 0,
    };
  });

  return { agents, events };
}

export async function remember(input: {
  content: string;
  key?: string;
  tags?: string[];
  agent_id?: string;
}): Promise<MemoryItem> {
  const db = sql();
  const key = input.key ?? null;
  const content = input.content;
  const tags = input.tags ?? [];
  const agentId = input.agent_id ?? null;
  const updatedAt = new Date().toISOString();

  try {
    if (key) {
      const rows = await db`
        insert into memory (key, content, tags, agent_id, updated_at)
        values (${key}, ${content}, ${tags}, ${agentId}, ${updatedAt})
        on conflict (key) do update set
          content = excluded.content,
          tags = excluded.tags,
          agent_id = excluded.agent_id,
          updated_at = excluded.updated_at,
          source = null,
          facts_at = null
        returning *
      `;
      if (!rows[0]) throw new Error("memory upsert returned no row");
      return rows[0] as MemoryItem;
    }
    const rows = await db`
      insert into memory (key, content, tags, agent_id, updated_at)
      values (${key}, ${content}, ${tags}, ${agentId}, ${updatedAt})
      returning *
    `;
    if (!rows[0]) throw new Error("memory insert returned no row");
    return rows[0] as MemoryItem;
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

export async function recall(input: {
  query?: string;
  key?: string;
  tags?: string[];
  limit?: number;
}): Promise<MemoryItem[]> {
  const db = sql();
  const limit = input.limit ?? 20;
  const key = input.key ?? null;
  const query = input.query ?? null;
  const like = query ? `%${query}%` : null;
  const tags = input.tags && input.tags.length > 0 ? input.tags : null;

  try {
    // Optional filters: null means "no filter" (predicate short-circuits).
    const rows = await db`
      select * from memory
      where
        (${key}::text is null or key = ${key})
        and (${like}::text is null or content ilike ${like})
        and (${tags}::text[] is null or tags && ${tags}::text[])
      order by updated_at desc
      limit ${limit}
    `;
    return rows as MemoryItem[];
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

function asMessage(row: Record<string, unknown>): Message {
  return {
    id: Number(row.id),
    agent_id: String(row.agent_id),
    body: String(row.body),
    created_by: (row.created_by as string | null) ?? null,
    actor_type: row.actor_type === "human" || row.actor_type === "agent" ? row.actor_type : null,
    actor_id: row.actor_id == null || row.actor_id === "" ? null : String(row.actor_id),
    created_at: String(row.created_at),
    delivered_at: (row.delivered_at as string | null) ?? null,
    acked_at: (row.acked_at as string | null) ?? null,
    direction: (row.direction as Message["direction"]) ?? "inbound",
    in_reply_to: row.in_reply_to == null ? null : Number(row.in_reply_to),
    thread_id: (row.thread_id as string | null) ?? null,
    read_by_dashboard_at: (row.read_by_dashboard_at as string | null) ?? null,
  };
}

function actorFields(actor: Actor | null | undefined): { actor_type: string | null; actor_id: string | null } {
  if (!actor) return { actor_type: null, actor_id: null };
  return { actor_type: actor.actor_type, actor_id: actor.actor_id };
}

function asTask(row: Record<string, unknown>): Task {
  return {
    ...(row as unknown as Task),
    actor_type: row.actor_type === "human" || row.actor_type === "agent" ? row.actor_type : null,
    actor_id: row.actor_id == null || row.actor_id === "" ? null : String(row.actor_id),
  };
}

type EnqueueInput = {
  agent_id: string;
  body: string;
  created_by?: string;
  /** From the authenticated principal. Never taken from the request body. */
  actor?: Actor | null;
  /** Optional client key. Blank is the same as omitting it. */
  idempotency_key?: string | null;
};

/** Operator → agent. Sets direction=inbound and thread_id = own id when new. */
export async function enqueueMessage(input: EnqueueInput): Promise<Message> {
  return runIdempotent({
    actor: input.actor,
    route: IDEMPOTENCY_ROUTE.enqueueMessage,
    key: input.idempotency_key,
    payload: payloadOf(input, ["agent_id", "body", "created_by"]),
    execute: () => insertEnqueuedMessage(input),
  });
}

type MessageWrite = {
  agentId: string;
  body: string;
  createdBy: string;
  direction: "inbound" | "outbound";
  inReplyTo: number | null;
  /** Null means this row is the thread root, so thread_id is its own id. */
  threadId: string | null;
  actorType: string | null;
  actorId: string | null;
};

/**
 * One statement. A new thread sets thread_id to the new id in that statement.
 * Neon HTTP autocommits each call, so a follow-up write can commit the row
 * and then fail on a deadlock, a cancel, or a trigger. The claim would be
 * released and a retry would insert a second message.
 */
async function insertMessage(db: SqlTag, input: MessageWrite): Promise<Message> {
  try {
    const rows = input.threadId == null
      ? await db`
          insert into messages (
            id, agent_id, body, created_by, direction, in_reply_to, thread_id, actor_type, actor_id
          )
          overriding system value
          select
            allocated.nid,
            ${input.agentId},
            ${input.body},
            ${input.createdBy},
            ${input.direction},
            ${input.inReplyTo},
            allocated.nid::text,
            ${input.actorType},
            ${input.actorId}
          from (
            select nextval(pg_get_serial_sequence('messages', 'id')) as nid
          ) allocated
          returning *
        `
      : await db`
          insert into messages (
            agent_id, body, created_by, direction, in_reply_to, thread_id, actor_type, actor_id
          )
          values (
            ${input.agentId},
            ${input.body},
            ${input.createdBy},
            ${input.direction},
            ${input.inReplyTo},
            ${input.threadId},
            ${input.actorType},
            ${input.actorId}
          )
          returning *
        `;
    if (!rows[0]) throw new Error("messages insert returned no row");
    return asMessage(rows[0] as Record<string, unknown>);
  } catch (e) {
    rethrowStore(e);
  }
}

async function insertEnqueuedMessage(input: EnqueueInput): Promise<Message> {
  const actor = actorFields(input.actor);
  return insertMessage(sql(), {
    agentId: slugify(input.agent_id),
    body: input.body,
    createdBy: input.created_by ?? "dashboard",
    direction: "inbound",
    inReplyTo: null,
    threadId: null,
    actorType: actor.actor_type,
    actorId: actor.actor_id,
  });
}

type ReplyInput = {
  agent_id: string;
  body: string;
  in_reply_to?: number;
  created_by?: string;
  /** From the authenticated principal. Never taken from the request body. */
  actor?: Actor | null;
  /** Optional client key. Blank is the same as omitting it. */
  idempotency_key?: string | null;
};

/** Agent → operator reply. */
export async function replyFromAgent(input: ReplyInput): Promise<Message> {
  return runIdempotent({
    actor: input.actor,
    route: IDEMPOTENCY_ROUTE.reply,
    key: input.idempotency_key,
    payload: payloadOf(input, ["agent_id", "body", "in_reply_to", "created_by"]),
    execute: () => insertReply(input),
  });
}

async function insertReply(input: ReplyInput): Promise<Message> {
  const db = sql();
  const agentId = slugify(input.agent_id);
  const actor = actorFields(input.actor);
  let threadId: string | null = null;
  let parentId: number | null = input.in_reply_to ?? null;
  if (parentId != null) {
    try {
      const parents = await db`
        select id, thread_id, agent_id from messages where id = ${parentId} limit 1
      `;
      if (!parents[0]) throw new Error(`in_reply_to ${parentId} not found`);
      if (String(parents[0].agent_id) !== agentId) {
        throw new Error("in_reply_to belongs to a different agent");
      }
      threadId = (parents[0].thread_id as string | null) ?? String(parents[0].id);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  }
  return insertMessage(db, {
    agentId,
    body: input.body,
    createdBy: input.created_by ?? agentId,
    direction: "outbound",
    inReplyTo: parentId,
    threadId,
    actorType: actor.actor_type,
    actorId: actor.actor_id,
  });
}

/** Fetch an agent's pending inbound (unacked) messages. Ack keeps history. */
export async function fetchMessages(input: {
  agent_id: string;
  ack?: boolean;
}): Promise<Message[]> {
  const db = sql();
  const agentId = slugify(input.agent_id);
  let msgs: Message[];
  try {
    const rows = await db`
      select * from messages
      where agent_id = ${agentId}
        and acked_at is null
        and (direction = 'inbound' or direction is null)
      order by created_at asc
    `;
    msgs = (rows as Record<string, unknown>[]).map(asMessage);
  } catch (e) {
    // Pre-migration: no direction column.
    try {
      const rows = await db`
        select * from messages
        where agent_id = ${agentId} and acked_at is null
        order by created_at asc
      `;
      msgs = (rows as Record<string, unknown>[]).map(asMessage);
    } catch (e2) {
      throw new Error(errMsg(e2));
    }
  }
  if (input.ack && msgs.length > 0) {
    const now = new Date().toISOString();
    const ids = msgs.map((m) => m.id);
    try {
      await db`
        update messages
        set delivered_at = coalesce(delivered_at, ${now}), acked_at = ${now}
        where id = any(${ids}::bigint[])
      `;
      msgs = msgs.map((m) => ({
        ...m,
        delivered_at: m.delivered_at ?? now,
        acked_at: now,
      }));
    } catch (e) {
      throw new Error(errMsg(e));
    }
  }
  return msgs;
}

/** Full conversation for the dashboard drawer (history kept after ack). */
export async function listConversation(input: {
  agent_id: string;
  limit?: number;
}): Promise<Message[]> {
  const db = sql();
  const agentId = slugify(input.agent_id);
  const limit = input.limit ?? 100;
  try {
    const rows = await db`
      select * from messages
      where agent_id = ${agentId}
      order by created_at asc
      limit ${limit}
    `;
    return (rows as Record<string, unknown>[]).map(asMessage);
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

/** Operator opens the drawer — clear unread on outbound replies. */
export async function markConversationRead(input: {
  agent_id: string;
}): Promise<number> {
  const db = sql();
  const agentId = slugify(input.agent_id);
  const now = new Date().toISOString();
  try {
    const rows = await db`
      update messages
      set read_by_dashboard_at = ${now}
      where agent_id = ${agentId}
        and direction = 'outbound'
        and read_by_dashboard_at is null
      returning id
    `;
    return rows.length;
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// Tasks — the work queue that turns Agent Kontrol into a harness.
// ---------------------------------------------------------------------------

type CreateTaskInput = {
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
  /** Optional client key. Blank is the same as omitting it. */
  idempotency_key?: string | null;
};

export async function createTask(input: CreateTaskInput): Promise<Task> {
  return runIdempotent({
    actor: input.actor,
    route: IDEMPOTENCY_ROUTE.createTask,
    key: input.idempotency_key,
    payload: payloadOf(input, [
      "title",
      "description",
      "project",
      "platform",
      "machine",
      "priority",
      "reviewer_platform",
      "created_by",
    ]),
    execute: () => insertTask(input),
  });
}

async function insertTask(input: CreateTaskInput): Promise<Task> {
  const db = sql();
  const actor = actorFields(input.actor);
  try {
    const rows = await db`
      insert into tasks (
        title, description, project, platform, machine,
        priority, reviewer_platform, created_by, actor_type, actor_id
      )
      values (
        ${input.title},
        ${input.description ?? null},
        ${input.project ?? null},
        ${input.platform ?? "any"},
        ${input.machine ?? null},
        ${input.priority ?? 2},
        ${input.reviewer_platform ?? null},
        ${input.created_by ?? "dashboard"},
        ${actor.actor_type},
        ${actor.actor_id}
      )
      returning *
    `;
    if (!rows[0]) throw new Error("tasks insert returned no row");
    return asTask(rows[0] as Record<string, unknown>);
  } catch (e) {
    rethrowStore(e);
  }
}

const OPEN_STATUSES: TaskStatus[] = ["queued", "claimed", "running", "review"];

export async function listTasks(input?: {
  status?: string; // a status, "open", or "all"
  limit?: number;
}): Promise<Task[]> {
  const db = sql();
  const limit = input?.limit ?? 100;
  const status = input?.status ?? "all";

  try {
    if (status === "open") {
      const rows = await db`
        select * from tasks
        where status = any(${OPEN_STATUSES}::text[])
        order by status asc, priority asc, updated_at desc
        limit ${limit}
      `;
      return (rows as Record<string, unknown>[]).map(asTask);
    }
    if (status !== "all") {
      const rows = await db`
        select * from tasks
        where status = ${status}
        order by status asc, priority asc, updated_at desc
        limit ${limit}
      `;
      return (rows as Record<string, unknown>[]).map(asTask);
    }
    const rows = await db`
      select * from tasks
      order by status asc, priority asc, updated_at desc
      limit ${limit}
    `;
    return (rows as Record<string, unknown>[]).map(asTask);
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

/**
 * Atomically claim the next queued task for a platform (and optionally a
 * machine). Guarded update (`status = 'queued'`) means two dispatchers racing
 * for the same row can't both win — the loser just tries the next candidate.
 */
export async function claimNextTask(input: {
  platform: string;
  machine?: string;
  agent_id: string;
}): Promise<Task | null> {
  const db = sql();
  let candidates: Task[];
  try {
    const rows = await db`
      select * from tasks
      where status = 'queued'
        and platform = any(${[input.platform, "any"]}::text[])
      order by priority asc, created_at asc
      limit 10
    `;
    candidates = (rows as Record<string, unknown>[]).map(asTask);
  } catch (e) {
    throw new Error(errMsg(e));
  }

  const now = new Date().toISOString();
  for (const t of candidates) {
    if (t.machine && input.machine && t.machine !== input.machine) continue;
    if (t.machine && !input.machine) continue;
    try {
      const claimed = await db`
        update tasks set
          status = 'claimed',
          assigned_agent = ${input.agent_id},
          claimed_at = ${now},
          updated_at = ${now}
        where id = ${t.id} and status = 'queued'
        returning *
      `;
      if (claimed.length > 0) return asTask(claimed[0] as Record<string, unknown>);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  }
  return null;
}

export async function updateTask(input: {
  id: number;
  status?: TaskStatus;
  result?: string;
  cost_usd?: number;
  session_id?: string;
  assigned_agent?: string;
}): Promise<Task> {
  const db = sql();
  const now = new Date().toISOString();
  const hasStatus = input.status !== undefined && input.status !== null;
  const status = input.status ?? null;
  const complete =
    input.status === "done" || input.status === "failed" || input.status === "cancelled";
  const hasResult = input.result !== undefined;
  const hasCost = input.cost_usd !== undefined;
  const hasSession = input.session_id !== undefined;
  const hasAgent = input.assigned_agent !== undefined;

  try {
    const rows = await db`
      update tasks set
        updated_at = ${now},
        status = case when ${hasStatus} then ${status} else status end,
        completed_at = case when ${complete} then ${now}::timestamptz else completed_at end,
        result = case when ${hasResult} then ${input.result ?? null} else result end,
        cost_usd = case when ${hasCost} then ${input.cost_usd ?? null} else cost_usd end,
        session_id = case when ${hasSession} then ${input.session_id ?? null} else session_id end,
        assigned_agent = case when ${hasAgent} then ${input.assigned_agent ?? null} else assigned_agent end
      where id = ${input.id}
      returning *
    `;
    if (!rows[0]) throw new Error("Task not found");
    return asTask(rows[0] as Record<string, unknown>);
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

/** Read one task. Dry-run previews use this so a cancel can show the row without updating it. */
export async function getTask(id: number): Promise<Task | null> {
  const db = sql();
  try {
    const rows = await db`select * from tasks where id = ${id} limit 1`;
    return (rows[0] as Task | undefined) ?? null;
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

/**
 * Read the note stored at a key, if any. Dry-run previews use this so an
 * overwrite can show the current note without writing.
 */
export async function findMemoryByKey(key: string): Promise<MemoryItem | null> {
  const db = sql();
  try {
    const rows = await db`select * from memory where key = ${key} limit 1`;
    return (rows[0] as MemoryItem | undefined) ?? null;
  } catch (e) {
    throw new Error(errMsg(e));
  }
}
