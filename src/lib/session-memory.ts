import { sql } from "./db";
import { buildSessionNote, includePrompts, writebackDays, writebackEnabled, type SessionFacts } from "./session-note";

/**
 * Write (or refresh) the automatic memory note for a session that has ended.
 * Called by `report()` for every platform, so any adapter that ends a session
 * (hook, watcher, MCP `report_status` with status done) gets the same behavior.
 * Idempotent: the note's key is the session id. Failures are the caller's to log;
 * this must never make an ingest fail.
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

  const events = await db`
    select kind, title from events where session_id = ${sessionId} order by created_at asc limit 2000
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
    event_count: events.length,
    error_count: events.filter((e) => e.kind === "error").length,
    tools,
    milestones: events.filter((e) => e.kind === "milestone" || e.kind === "status").map((e) => String(e.title ?? "")),
    summary: s.summary ?? null,
  };

  const note = buildSessionNote(facts, { includePrompts: includePrompts() });
  if (!note) return;

  await db`
    insert into memory (key, content, tags, agent_id, updated_at)
    values (${note.key}, ${note.content}, ${note.tags}, ${facts.agent_id}, ${new Date().toISOString()})
    on conflict (key) do update set
      content = excluded.content,
      tags = excluded.tags,
      agent_id = excluded.agent_id,
      updated_at = excluded.updated_at
  `;

  // Housekeeping on roughly 1 in 25 writes so automatic notes do not pile up forever.
  if (Math.random() < 0.04) {
    const days = writebackDays();
    await db`delete from memory where 'session-summary' = any(tags) and updated_at < now() - (${days}::int * interval '1 day')`;
  }
}
