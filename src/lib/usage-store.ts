/**
 * Usage and Costs Neon store.
 * Agents push via POST /api/usage/ingest; the dashboard only reads aggregates.
 * Fleet headlines are always source=hermes_state (see usage-aggregate.ts).
 */
import { isConfigured, sql } from "./db";
import { aggregateUsageFacts } from "./usage-aggregate";
import { usageIdempotentKey } from "./usage-key";
import { assertNoContent } from "./usage-privacy";
import type { UsageFact, UsageIngestInput, UsageSummary } from "./usage-types";
import { demoUsageSummary } from "./demo-usage";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

export async function ingestUsageFacts(input: UsageIngestInput): Promise<number> {
  if (!Array.isArray(input.facts)) throw new Error("facts[] required");
  if (!isConfigured()) {
    // Match progress ingest: accept and drop when DATABASE_URL unset (local demo).
    return 0;
  }
  const db = sql();
  const collectedAt = input.collected_at ?? new Date().toISOString();
  let written = 0;

  for (const raw of input.facts) {
    if (!raw?.model || !raw?.account_id || !raw?.source || !raw?.last_seen_at) continue;
    assertNoContent(raw.detail);
    for (const bad of ["prompt", "completion", "message", "messages", "content", "body", "text"]) {
      if (bad in (raw as object)) {
        throw new Error(`privacy: refusing fact field ${bad}`);
      }
    }
    const key = usageIdempotentKey(raw);
    await db`
      insert into usage_facts (
        idempotency_key, source, account_id, profile, session_id, model,
        billing_provider, billing_mode, cron_job_id, cron_job_name, task,
        api_call_count, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, reasoning_tokens,
        paid_cost_usd, shadow_cost_usd, price_version, cost_status,
        first_seen_at, last_seen_at, collected_at, detail
      ) values (
        ${key},
        ${raw.source},
        ${raw.account_id},
        ${strOrNull(raw.profile)},
        ${strOrNull(raw.session_id)},
        ${raw.model},
        ${strOrNull(raw.billing_provider)},
        ${strOrNull(raw.billing_mode)},
        ${strOrNull(raw.cron_job_id)},
        ${strOrNull(raw.cron_job_name)},
        ${strOrNull(raw.task)},
        ${num(raw.api_call_count)},
        ${num(raw.input_tokens)},
        ${num(raw.output_tokens)},
        ${num(raw.cache_read_tokens)},
        ${num(raw.cache_write_tokens)},
        ${num(raw.reasoning_tokens)},
        ${num(raw.paid_cost_usd)},
        ${num(raw.shadow_cost_usd)},
        ${strOrNull(raw.price_version)},
        ${strOrNull(raw.cost_status)},
        ${strOrNull(raw.first_seen_at)},
        ${raw.last_seen_at},
        ${collectedAt},
        ${JSON.stringify(raw.detail ?? {})}::jsonb
      )
      on conflict (idempotency_key) do update set
        cron_job_name = coalesce(excluded.cron_job_name, usage_facts.cron_job_name),
        api_call_count = excluded.api_call_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        paid_cost_usd = excluded.paid_cost_usd,
        shadow_cost_usd = excluded.shadow_cost_usd,
        price_version = excluded.price_version,
        cost_status = excluded.cost_status,
        first_seen_at = coalesce(excluded.first_seen_at, usage_facts.first_seen_at),
        last_seen_at = excluded.last_seen_at,
        collected_at = excluded.collected_at,
        detail = excluded.detail
    `;
    written++;
  }
  return written;
}

export async function ingestAccountSnapshot(snap: {
  account_id: string;
  collected_at?: string;
  balance_usd?: number | null;
  credits_remaining?: number | null;
  quota_detail?: unknown;
  detail?: unknown;
}): Promise<void> {
  if (!isConfigured()) return;
  assertNoContent(snap.detail);
  assertNoContent(snap.quota_detail);
  const db = sql();
  const collected_at = snap.collected_at ?? new Date().toISOString();
  await db`
    insert into account_snapshots (
      account_id, collected_at, balance_usd, credits_remaining, quota_detail, detail
    ) values (
      ${snap.account_id},
      ${collected_at},
      ${snap.balance_usd ?? null},
      ${snap.credits_remaining ?? null},
      ${JSON.stringify(snap.quota_detail ?? {})}::jsonb,
      ${JSON.stringify(snap.detail ?? {})}::jsonb
    )
    on conflict (account_id, collected_at) do update set
      balance_usd = excluded.balance_usd,
      credits_remaining = excluded.credits_remaining,
      quota_detail = excluded.quota_detail,
      detail = excluded.detail
  `;
}

function rowToFact(row: Record<string, unknown>): UsageFact {
  return {
    source: String(row.source) as UsageFact["source"],
    account_id: String(row.account_id),
    profile: (row.profile as string) ?? null,
    session_id: (row.session_id as string) ?? null,
    model: String(row.model),
    billing_provider: (row.billing_provider as string) ?? null,
    billing_mode: (row.billing_mode as string) ?? null,
    cron_job_id: (row.cron_job_id as string) ?? null,
    cron_job_name: (row.cron_job_name as string) ?? null,
    task: (row.task as string) ?? null,
    api_call_count: num(row.api_call_count),
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    cache_read_tokens: num(row.cache_read_tokens),
    cache_write_tokens: num(row.cache_write_tokens),
    reasoning_tokens: num(row.reasoning_tokens),
    paid_cost_usd: num(row.paid_cost_usd),
    shadow_cost_usd: num(row.shadow_cost_usd),
    price_version: (row.price_version as string) ?? null,
    cost_status: (row.cost_status as string) ?? null,
    first_seen_at: row.first_seen_at
      ? new Date(row.first_seen_at as string).toISOString()
      : null,
    last_seen_at: new Date(row.last_seen_at as string).toISOString(),
    detail: (row.detail as Record<string, unknown>) ?? null,
  };
}

export async function getUsageSummary(opts: {
  since: string;
  until: string;
}): Promise<UsageSummary> {
  if (!isConfigured()) {
    return demoUsageSummary(opts);
  }
  const db = sql();
  const rows = (await db`
    select *
    from usage_facts
    where last_seen_at >= ${opts.since}::timestamptz
      and last_seen_at < ${opts.until}::timestamptz
  `) as Record<string, unknown>[];

  const facts = rows.map(rowToFact);

  const snaps = (await db`
    select account_id, collected_at, balance_usd, credits_remaining
    from account_snapshots
    where account_id = 'openrouter-shared'
    order by collected_at desc
    limit 1
  `) as Record<string, unknown>[];
  const latestOr = snaps[0];

  const collectedRows = (await db`
    select max(collected_at) as collected_at from usage_facts
    where last_seen_at >= ${opts.since}::timestamptz
      and last_seen_at < ${opts.until}::timestamptz
  `) as Record<string, unknown>[];

  const summary = aggregateUsageFacts(facts, {
    since: opts.since,
    until: opts.until,
    collected_at: collectedRows[0]?.collected_at
      ? new Date(collectedRows[0].collected_at as string).toISOString()
      : null,
  });

  summary.demo = false;
  if (latestOr) {
    summary.openrouter = {
      ...summary.openrouter!,
      credits_remaining:
        latestOr.credits_remaining != null ? num(latestOr.credits_remaining) : summary.openrouter?.credits_remaining ?? null,
    };
  }
  return summary;
}

export { usageIdempotentKey } from "./usage-key";
export { assertNoContent } from "./usage-privacy";
export { aggregateUsageFacts, isHermesState } from "./usage-aggregate";
