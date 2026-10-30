import { randomUUID } from "node:crypto";
import { withTransaction, type SqlTag } from "./db";

// A literal end assertion also rejects the trailing newline JavaScript's $ permits.
export const CONSUMER_ID = /^[a-z0-9][a-z0-9._-]{0,63}(?![\s\S])/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?![\s\S])/;
const EVENT = /^[a-z][a-z0-9_.-]{0,63}(?![\s\S])/;
const BIGINT_MAX = 9223372036854775807n;
// One bounded payload per database batch keeps a slow reader from retaining
// dozens of maximum-size inbox payloads in memory.
export const STREAM_BATCH = 1;
export const STREAM_FRAME_MAX = 1_048_576;
export const STREAM_HEARTBEAT_MS = 25_000;
export const STREAM_LIFETIME_MS = 240_000;

export class EventStreamError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

export interface ConsumerRegistration {
  id: string;
  credential_id: string;
  repos: string[];
  event_types: string[];
  enabled: boolean;
}

export function checkStreamRegistration(input: unknown): ConsumerRegistration {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EventStreamError("invalid_consumer", 400);
  const o = input as Record<string, unknown>;
  const fields = ["id", "credential_id", "repos", "event_types", "enabled"];
  if (Object.keys(o).some(k => !fields.includes(k)) || typeof o.id !== "string" || !CONSUMER_ID.test(o.id)
    || typeof o.credential_id !== "string" || o.credential_id.length > 100 || !/^[A-Za-z0-9_-]+(?![\s\S])/.test(o.credential_id)
    || (o.enabled !== undefined && typeof o.enabled !== "boolean")) throw new EventStreamError("invalid_consumer", 400);
  const list = (value: unknown, max: number, pattern: RegExp): string[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > max
      || value.some(v => typeof v !== "string" || !pattern.test(v))) throw new EventStreamError("invalid_consumer", 400);
    return [...new Set(value as string[])];
  };
  return { id: o.id, credential_id: o.credential_id, repos: list(o.repos, 50, REPO),
    event_types: list(o.event_types, 32, EVENT), enabled: o.enabled !== false };
}

/** Cursor position is not authority: every read also checks the registered credential and filters. */
export function streamCursor(consumer: string, id: string): string {
  if (!CONSUMER_ID.test(consumer) || !/^(0|[1-9][0-9]{0,18})(?![\s\S])/.test(id) || BigInt(id) > BIGINT_MAX) {
    throw new EventStreamError("invalid_cursor", 400);
  }
  return `${consumer}:${id}`;
}

export function cursorPosition(consumer: string, cursor: string | null): string {
  if (!CONSUMER_ID.test(consumer)) throw new EventStreamError("invalid_consumer", 400);
  if (cursor == null || cursor === "") return "0";
  if (cursor.length > 85) throw new EventStreamError("invalid_cursor", 400);
  const parts = cursor.split(":");
  if (parts.length !== 2 || !CONSUMER_ID.test(parts[0])) throw new EventStreamError("invalid_cursor", 400);
  if (parts[0] !== consumer) throw new EventStreamError("foreign_cursor", 403);
  streamCursor(consumer, parts[1]);
  return parts[1];
}

export async function registerStreamConsumer(c: ConsumerRegistration): Promise<void> {
  await withTransaction(async tx => {
    const credentials = await tx`select id from agent_credentials where id = ${c.credential_id}
      and revoked_at is null and (expires_at is null or expires_at > clock_timestamp())
      and 'events:read' = any(scopes) for share`;
    if (!credentials.length) throw new EventStreamError("credential_not_eligible", 400);
    await tx`insert into event_stream_consumers (id, credential_id, repos, event_types, enabled)
      values (${c.id}, ${c.credential_id}, ${c.repos}::text[], ${c.event_types}::text[], ${c.enabled})
      on conflict (id) do update set credential_id = excluded.credential_id, repos = excluded.repos,
      event_types = excluded.event_types, enabled = excluded.enabled,
      generation = event_stream_consumers.generation + 1, updated_at = clock_timestamp()`;
  });
}

async function binding(tx: SqlTag, consumer: string, credential: string) {
  const rows = await tx`select c.id, c.repos, c.event_types, c.generation::text as generation
    from event_stream_consumers c join agent_credentials a on a.id = c.credential_id
    where c.id = ${consumer} and c.credential_id = ${credential} and c.enabled
    and a.revoked_at is null and (a.expires_at is null or a.expires_at > clock_timestamp())
    and 'events:read' = any(a.scopes) for update of c`;
  if (!rows.length) throw new EventStreamError("consumer_forbidden", 403);
  return rows[0];
}

async function boundedTransaction<T>(run: (tx: SqlTag) => Promise<T>): Promise<T> {
  return withTransaction(async tx => {
    await tx`set local lock_timeout = '1s'`;
    await tx`set local statement_timeout = '3s'`;
    return run(tx);
  });
}

export async function acquireStream(consumer: string, credential: string): Promise<string> {
  return boundedTransaction(async tx => {
    await binding(tx, consumer, credential);
    const rows = await tx`update event_stream_consumers set generation = generation + 1
      where id = ${consumer} returning generation::text as generation`;
    return String(rows[0].generation);
  });
}

export interface StreamEvent { id: string; event: string; payload: Record<string, unknown> }
export interface StreamBatch { expired: boolean; events: StreamEvent[] }

/**
 * A sequence allocation is not commit order. A short SHARE table lock waits
 * for prior inbox writers and excludes new inserts until this bounded batch
 * has been selected. No network or model work occurs under the lock. Thus a
 * slow low-id transaction cannot commit after we have advanced past it.
 * Concurrent readers remain compatible; lock/statement timeouts fail closed.
 */
export async function readStreamBatch(consumer: string, credential: string, generation: string, position: string): Promise<StreamBatch> {
  streamCursor(consumer, position);
  return boundedTransaction(async tx => {
    const c = await binding(tx, consumer, credential);
    if (String(c.generation) !== generation) throw new EventStreamError("superseded", 409);
    await tx`lock table gh_events in share mode`;
    if (position !== "0") {
      const cursor = await tx`select repo, event from gh_events where id = ${position}::bigint`;
      if (!cursor.length) return { expired: true, events: [] };
      if (!(c.repos as string[]).includes(String(cursor[0].repo)) || !(c.event_types as string[]).includes(String(cursor[0].event))) {
        throw new EventStreamError("foreign_cursor", 403);
      }
    }
    const rows = await tx`select id::text as id, event, payload from gh_events
      where id > ${position}::bigint and repo = any(${c.repos}::text[])
      and event = any(${c.event_types}::text[]) order by gh_events.id limit ${STREAM_BATCH}`;
    return { expired: false, events: rows.map(r => ({ id: String(r.id), event: String(r.event), payload: r.payload })) };
  });
}

export function eventFrame(consumer: string, row: StreamEvent): string {
  const cursor = streamCursor(consumer, row.id);
  const frame = `id: ${cursor}\nevent: github\ndata: ${JSON.stringify({ id: cursor, event: row.event, payload: row.payload })}\n\n`;
  if (Buffer.byteLength(frame) > STREAM_FRAME_MAX) throw new EventStreamError("event_too_large", 503);
  return frame;
}

const active = new Map<string, { id: string; stop: AbortController }>();

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Bounded transport; options are internal/test inputs, never request parameters. */
export function eventStreamResponse(opts: {
  consumer: string; position: string; generation: string; credential: string; signal: AbortSignal;
  first: StreamBatch; read?: typeof readStreamBatch; pollMs?: number; heartbeatMs?: number; lifetimeMs?: number;
}): Response {
  const stop = new AbortController();
  const id = randomUUID();
  active.get(opts.consumer)?.stop.abort("superseded");
  active.set(opts.consumer, { id, stop });
  const externalAbort = () => stop.abort("client_closed");
  opts.signal.addEventListener("abort", externalAbort, { once: true });
  if (opts.signal.aborted) externalAbort();
  const lifetime = setTimeout(() => stop.abort("duration"), opts.lifetimeMs ?? STREAM_LIFETIME_MS);
  const encoder = new TextEncoder();
  let position = opts.position;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // At most one small terminal control frame may follow a buffered payload.
      // Backpressure must not prevent fencing/expiry from closing the stream.
      const terminal = (frame: string) => {
        try { controller.enqueue(encoder.encode(frame)); } catch { /* already cancelled */ }
      };
      const send = async (frame: string): Promise<boolean> => {
        while ((controller.desiredSize ?? 0) <= 0 && !stop.signal.aborted) await delay(10, stop.signal);
        if (stop.signal.aborted) return false;
        controller.enqueue(encoder.encode(frame));
        return true;
      };
      try {
        let batch = opts.first;
        let lastHeartbeat = Date.now();
        while (!stop.signal.aborted) {
          if (batch.expired) {
            terminal('event: cursor_expired\ndata: {"reconcile":true}\n\n');
            break;
          }
          for (const event of batch.events) {
            if (!await send(eventFrame(opts.consumer, event))) break;
            position = event.id; // advanced only after the frame was queued
          }
          if (Date.now() - lastHeartbeat >= (opts.heartbeatMs ?? STREAM_HEARTBEAT_MS)) {
            await send(": ping\n\n");
            lastHeartbeat = Date.now();
          }
          if (stop.signal.aborted) break;
          await delay(batch.events.length === STREAM_BATCH ? 0 : (opts.pollMs ?? 1000), stop.signal);
          if (!stop.signal.aborted) batch = await (opts.read ?? readStreamBatch)(opts.consumer, opts.credential, opts.generation, position);
        }
      } catch (e) {
        const code = e instanceof EventStreamError ? e.code : "stream_unavailable";
        if (!stop.signal.aborted) {
          if (code === "superseded") stop.abort("superseded");
          else terminal(`event: stream_error\ndata: ${JSON.stringify({ error: code, reconcile: true })}\n\n`);
        }
      } finally {
        clearTimeout(lifetime);
        opts.signal.removeEventListener("abort", externalAbort);
        if (active.get(opts.consumer)?.id === id) active.delete(opts.consumer);
        // Same-instance replacement aborts immediately; cross-instance replacement
        // is found by the generation check on the next bounded database poll.
        if (stop.signal.reason === "superseded") terminal('event: superseded\ndata: {"reconcile":true}\n\n');
        try { controller.close(); } catch { /* reader already cancelled */ }
      }
    },
    cancel() { stop.abort("client_closed"); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
  } });
}
