import { sql } from "./db";
import { buildSessionNote, includePrompts, includeText, writebackDays, writebackEnabled, type SessionFacts, type SessionNote } from "./session-note";

/** The `source` value that marks a memory row the server wrote itself. */
export const AUTOMATIC_SOURCE = "automatic-session";

/**
 * Store a note, but only if it was built from facts at least as new as the stored
 * one. Two session-end reports can race; the staler snapshot must not win. A row
 * with another source (an agent wrote the key itself) is never overwritten.
 */
export async function upsertAutomaticNote(note: SessionNote, agentId: string, factsAt: string): Promise<void> {
  await sql()`
    insert into memory (key, content, tags, agent_id, updated_at, source, facts_at)
    values (${note.key}, ${note.content}, ${note.tags}, ${agentId}, ${new Date().toISOString()}, ${AUTOMATIC_SOURCE}, ${factsAt}::timestamptz)
    on conflict (key) do update set
      content = excluded.content,
      tags = excluded.tags,
      agent_id = excluded.agent_id,
      updated_at = excluded.updated_at,
      facts_at = excluded.facts_at
    where memory.source = ${AUTOMATIC_SOURCE}
      and (memory.facts_at is null or memory.facts_at <= excluded.facts_at)
  `;
}

/** Delete a bounded batch of expired automatic notes. Runs on every write, so growth stays bounded. */
export async function pruneAutomaticNotes(): Promise<void> {
  const days = writebackDays();
  await sql()`
    delete from memory where id in (
      select id from memory
      where source = ${AUTOMATIC_SOURCE} and updated_at < now() - (${days}::int * interval '1 day')
      order by updated_at asc limit 25
    )
  `;
}

/**
 * Write (or refresh) the automatic memory note for a session that has ended.
 * Called by `report()` for every platform, so any adapter that ends a session
 * (hook, watcher, MCP `report_status` with status done) gets the same behavior.
 * Idempotent: the note's key is the session id. Failures are the caller's to log;
 * this must never make an ingest fail. Queries are aggregates and small limits,
 * backed by indexes on (session_id, created_at) and (session_id, kind).
 */
export async function writeSessionNote(sessionId: string): Promise<void> {
  if (!writebackEnabled()) return;
  const db = sql();

  const rows = await db`
    select s.id, s.agent_id, s.project, s.status, s.summary, s.started_at, s.ended_at, s.updated_at,
           a.platform, a.display_name
    from sessions s left join agents a on a.id = s.agent_id
    where s.id = ${sessionId} limit 1
  `;
  const s = rows[0];
  if (!s) return;

  const withText = includeText();
  const [counts] = await db`
    select count(*)::int as n,
           (count(*) filter (where kind = 'error'))::int as errors,
           max(created_at) as newest,
           (count(*) filter (where kind in ('milestone', 'status')))::int as reported
    from events where session_id = ${sessionId}
  `;
  // The last few reported titles. Without the free-text opt-in they only feed a count and are never stored.
  const titles = await db`
    select title from (
      select title, created_at from events
      where session_id = ${sessionId} and kind in ('milestone', 'status') and title is not null
      order by created_at desc limit 20
    ) t order by created_at asc
  `;

  let tools: { name: string; count: number; failed: number }[] = [];
  try {
    const t = await db`
      select name, count(*)::int as n, (count(*) filter (where status = 'error'))::int as failed
      from spans where session_id = ${sessionId} and kind = 'tool'
      group by name order by n desc limit 8
    `;
    tools = t.map((r) => ({ name: String(r.name), count: Number(r.n), failed: Number(r.failed) }));
  } catch {
    // The spans table may not exist yet on a database that has not been upgraded.
  }

  const iso = (v: unknown): string | null => (v ? (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()) : null);
  const facts: SessionFacts = {
    session_id: sessionId,
    agent_id: String(s.agent_id),
    display_name: s.display_name ?? null,
    platform: s.platform ?? null,
    project: s.project ?? null,
    status: String(s.status),
    started_at: iso(s.started_at),
    ended_at: iso(s.ended_at) ?? iso(s.updated_at),
    event_count: Number(counts?.n ?? 0),
    error_count: Number(counts?.errors ?? 0),
    tools,
    milestones: titles.map((e) => String(e.title ?? "")),
    summary: s.summary ?? null,
  };

  const note = buildSessionNote(facts, { includeText: withText, includePrompts: includePrompts() });
  if (!note) return;

  await upsertAutomaticNote(note, facts.agent_id, iso(counts?.newest) ?? new Date().toISOString());
  await pruneAutomaticNotes();
}
