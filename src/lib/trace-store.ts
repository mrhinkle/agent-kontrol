import { sql } from "./db";
import { retentionDays, type SpanInput, type SpanRow, type TraceSummary } from "./traces";

/** Postgres returns timestamps as Date or string depending on the driver. */
function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Insert or update spans in ONE statement. A span seen again (for example the
 * close of one that was opened earlier) merges into the stored row instead of
 * replacing it: the earliest start, the latest known end, and attributes combined.
 */
export async function upsertSpans(spans: SpanInput[]): Promise<void> {
  if (spans.length === 0) return;
  await sql()`
    insert into spans (
      trace_id, span_id, parent_span_id, agent_id, session_id, name, kind, status, status_message,
      started_at, ended_at, attributes, model, input_tokens, output_tokens, cost_usd
    )
    select trace_id, span_id, parent_span_id, agent_id, session_id, name, kind, status, status_message,
      started_at::timestamptz, ended_at::timestamptz, attributes::jsonb, model,
      input_tokens::bigint, output_tokens::bigint, cost_usd::numeric
    from unnest(
      ${spans.map((s) => s.trace_id)}::text[],
      ${spans.map((s) => s.span_id)}::text[],
      ${spans.map((s) => s.parent_span_id)}::text[],
      ${spans.map((s) => s.agent_id)}::text[],
      ${spans.map((s) => s.session_id)}::text[],
      ${spans.map((s) => s.name)}::text[],
      ${spans.map((s) => s.kind)}::text[],
      ${spans.map((s) => s.status)}::text[],
      ${spans.map((s) => s.status_message)}::text[],
      ${spans.map((s) => s.started_at)}::text[],
      ${spans.map((s) => s.ended_at)}::text[],
      ${spans.map((s) => JSON.stringify(s.attributes))}::text[],
      ${spans.map((s) => s.model)}::text[],
      ${spans.map((s) => (s.input_tokens === null ? null : String(s.input_tokens)))}::text[],
      ${spans.map((s) => (s.output_tokens === null ? null : String(s.output_tokens)))}::text[],
      ${spans.map((s) => (s.cost_usd === null ? null : String(s.cost_usd)))}::text[]
    ) as t(
      trace_id, span_id, parent_span_id, agent_id, session_id, name, kind, status, status_message,
      started_at, ended_at, attributes, model, input_tokens, output_tokens, cost_usd
    )
    on conflict (trace_id, span_id) do update set
      parent_span_id = coalesce(excluded.parent_span_id, spans.parent_span_id),
      name = excluded.name,
      kind = excluded.kind,
      -- Monotonic: a span that failed stays failed, and a retry of an older
      -- update can never shorten a span or erase its end.
      status = case
        when spans.status = 'error' or excluded.status = 'error' then 'error'
        when excluded.status = 'unset' then spans.status
        else excluded.status end,
      status_message = case
        when spans.status = 'error' then coalesce(spans.status_message, excluded.status_message)
        else coalesce(excluded.status_message, spans.status_message) end,
      started_at = least(spans.started_at, excluded.started_at),
      ended_at = case
        when spans.ended_at is null then excluded.ended_at
        when excluded.ended_at is null then spans.ended_at
        else greatest(spans.ended_at, excluded.ended_at) end,
      attributes = spans.attributes || excluded.attributes,
      model = coalesce(excluded.model, spans.model),
      input_tokens = coalesce(excluded.input_tokens, spans.input_tokens),
      output_tokens = coalesce(excluded.output_tokens, spans.output_tokens),
      cost_usd = coalesce(excluded.cost_usd, spans.cost_usd)
  `;
}

export interface TraceFilter {
  agent?: string | null;
  errorsOnly?: boolean;
  /** Return traces that started before this ISO time (for paging). */
  before?: string | null;
  limit?: number;
}

export async function listTraces(f: TraceFilter = {}): Promise<TraceSummary[]> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const rows = await sql()`
    select
      trace_id,
      (array_agg(agent_id order by started_at))[1] as agent_id,
      (array_agg(name order by (parent_span_id is null) desc, started_at))[1] as root_name,
      min(started_at) as started_at,
      case when count(*) filter (where ended_at is null) > 0 then null else max(ended_at) end as ended_at,
      count(*)::int as span_count,
      (count(*) filter (where status = 'error'))::int as error_count,
      (count(*) filter (where ended_at is null))::int as open_count,
      coalesce(sum(input_tokens), 0)::text as input_tokens,
      coalesce(sum(output_tokens), 0)::text as output_tokens,
      coalesce(sum(cost_usd), 0)::text as cost_usd
    from spans
    where (${f.agent ?? null}::text is null or agent_id = ${f.agent ?? null}::text)
    group by trace_id
    having (${f.errorsOnly === true}::boolean = false or count(*) filter (where status = 'error') > 0)
      and min(started_at) < coalesce(${f.before ?? null}::timestamptz, 'infinity'::timestamptz)
    order by min(started_at) desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    trace_id: r.trace_id,
    agent_id: r.agent_id,
    root_name: r.root_name,
    started_at: iso(r.started_at) as string,
    ended_at: iso(r.ended_at),
    span_count: num(r.span_count),
    error_count: num(r.error_count),
    open_count: num(r.open_count),
    input_tokens: num(r.input_tokens),
    output_tokens: num(r.output_tokens),
    cost_usd: num(r.cost_usd),
  }));
}

export async function getTrace(traceId: string): Promise<SpanRow[]> {
  const rows = await sql()`
    select * from spans where trace_id = ${traceId} order by started_at asc limit 2000
  `;
  return rows.map((r) => ({
    trace_id: r.trace_id,
    span_id: r.span_id,
    parent_span_id: r.parent_span_id ?? null,
    agent_id: r.agent_id,
    session_id: r.session_id ?? null,
    name: r.name,
    kind: r.kind,
    status: r.status,
    status_message: r.status_message ?? null,
    started_at: iso(r.started_at) as string,
    ended_at: iso(r.ended_at),
    attributes: typeof r.attributes === "string" ? JSON.parse(r.attributes) : (r.attributes ?? {}),
    model: r.model ?? null,
    input_tokens: numOrNull(r.input_tokens),
    output_tokens: numOrNull(r.output_tokens),
    cost_usd: numOrNull(r.cost_usd),
    created_at: iso(r.created_at) ?? undefined,
  }));
}

/** Delete spans older than the retention window. Returns nothing; failures are non-fatal to callers. */
export async function pruneSpans(): Promise<void> {
  const days = retentionDays();
  await sql()`delete from spans where started_at < now() - (${days}::int * interval '1 day')`;
}
