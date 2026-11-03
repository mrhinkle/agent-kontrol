import { createHash } from "node:crypto";
import { sql, type Row } from "./db";
import type { Actor } from "./actor";
import { canonicalJSON, compatibility, summarizeVelocity, type VelocitySnapshot, type VelocityPoint, type VelocityResponse } from "./velocity";

const hash = (value: unknown) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
export function velocityIdentity(snapshot: VelocitySnapshot) {
  return { id: hash(snapshot), scopeKey: createHash("sha256").update(compatibility(snapshot)).digest("hex"),
    inventoryKey: hash({ complete: snapshot.inventoryComplete, repos: snapshot.repositories.map((r) => ({ repo: r.repo, coverage: r.coverage })) }) };
}
export async function insertVelocity(snapshot: VelocitySnapshot, actor: Actor) {
  const db = sql(), { id, scopeKey, inventoryKey } = velocityIdentity(snapshot);
  const payload = JSON.stringify({ snapshot, summary: summarizeVelocity(snapshot), inventoryKey });
  const inserted = await db`insert into velocity_benchmarks (id, metric_version, scope_key, window_start, window_end, captured_at, actor_type, actor_id, payload)
    values (${id}, ${snapshot.metricVersion}, ${scopeKey}, ${snapshot.window.start}::timestamptz, ${snapshot.window.end}::timestamptz, ${snapshot.capturedAt}::timestamptz, ${actor.actor_type}, ${actor.actor_id}, ${payload}::jsonb)
    on conflict (id) do nothing returning id, recorded_at`;
  // Separate statement observes a concurrently committed conflicting insert.
  const rows = inserted.length ? inserted : await db`select id, recorded_at from velocity_benchmarks where id = ${id}`;
  if (!rows[0]) throw new Error("Benchmark receipt is unavailable.");
  return { id, scopeKey, duplicate: inserted.length === 0, recordedAt: new Date(rows[0].recorded_at).toISOString() };
}
function point(row: Row): VelocityPoint {
  return { id: row.id, windowStart: new Date(row.window_start).toISOString(), windowEnd: new Date(row.window_end).toISOString(), capturedAt: new Date(row.captured_at).toISOString(), recordedAt: new Date(row.recorded_at).toISOString(), captureKind: row.capture_kind, summary: row.summary, inventoryKey: row.inventory_key };
}
export async function readVelocity(requestedKey?: string): Promise<VelocityResponse> {
  const db = sql();
  const groups = await db`select scope_key, metric_version, payload->'snapshot'->'scope'->'owners' as owners,
    payload->'snapshot'->'window'->'days' as days, payload->'snapshot'->'window'->>'timezone' as timezone
    from (select distinct on (scope_key) * from velocity_benchmarks order by scope_key, window_end desc, recorded_at desc, id desc) latest
    order by window_end desc, recorded_at desc limit 50`;
  const series = groups.map((r) => ({ key: r.scope_key as string, owners: r.owners as string[], days: Number(r.days), timezone: r.timezone as string, metricVersion: r.metric_version as string }));
  const selectedKey = requestedKey ?? series[0]?.key ?? null;
  if (!selectedKey) return { series, selectedKey, latest: null, baseline: null, history: [], historyLimited: false };
  if (!series.some((s) => s.key === selectedKey)) throw new Error("Unknown benchmark series.");
  const [recent, baselineRows, latestRows] = await Promise.all([
    db`select id, window_start, window_end, captured_at, recorded_at, payload->>'inventoryKey' as inventory_key,
      payload->'summary' as summary, payload->'snapshot'->>'captureKind' as capture_kind
      from (select distinct on (window_start, window_end) * from velocity_benchmarks where scope_key = ${selectedKey}
        order by window_start, window_end, recorded_at desc, id desc) revisions order by window_end desc limit 121`,
    db`select id, window_start, window_end, captured_at, recorded_at, payload->>'inventoryKey' as inventory_key,
      payload->'summary' as summary, payload->'snapshot'->>'captureKind' as capture_kind
      from velocity_benchmarks where scope_key = ${selectedKey} order by recorded_at, id limit 1`,
    db`select id, window_start, window_end, captured_at, recorded_at, payload->>'inventoryKey' as inventory_key,
      payload->'summary' as summary, payload->'snapshot'->>'captureKind' as capture_kind, payload->'snapshot' as snapshot
      from velocity_benchmarks where scope_key = ${selectedKey} order by window_end desc, recorded_at desc, id desc limit 1`,
  ]);
  return { series, selectedKey, latest: latestRows[0] ? { ...point(latestRows[0]), snapshot: latestRows[0].snapshot as VelocitySnapshot } : null,
    baseline: baselineRows[0] ? point(baselineRows[0]) : null, history: recent.slice(0, 120).map(point).reverse(), historyLimited: recent.length > 120 };
}
