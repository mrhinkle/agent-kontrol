/** Scheduled provider collection: which providers run, isolation between them, and the cron credential. */
import assert from "node:assert/strict";
import { cronAuthorized, runScheduledCollection, type ScheduledProvider } from "../src/lib/providers/scheduled";
import type { ProviderUsageBatch } from "../src/lib/providers/types";
import type { UsageFact } from "../src/lib/usage-types";

const NOW = new Date("2026-11-24T22:10:00Z");
const fact = (id: string): UsageFact => ({ source: "provider_api", account_id: "a", model: "m", session_id: id, last_seen_at: "2026-11-23T23:59:59.999Z" });

function provider(id: string, key: string, facts: number | Error, seen: { since?: Date; until?: Date }[] = []): ScheduledProvider {
  return {
    id, accountId: `${id}-account`, configured: (env) => !!env[key],
    adapter: { id, async fetchUsage(_account, since, until) {
      seen.push({ since, until });
      if (facts instanceof Error) throw facts;
      return { facts: Array.from({ length: facts }, (_, i) => fact(`${id}-${i}`)), snapshot: { account_id: `${id}-account`, collected_at: NOW.toISOString() } };
    } },
  };
}

async function main() {
  // Nothing configured: nothing is fetched or written, and that is not a failure.
  let writes = 0;
  const none = await runScheduledCollection({ env: {}, now: NOW, providers: [provider("one", "K1", 2)], ingest: async () => { writes++; return 0; } });
  assert.deepEqual(none, { ok: true, results: [{ provider: "one", status: "skipped" }] });
  assert.equal(writes, 0);
  console.log("scheduled_skips_unconfigured_ok");

  // Configured: the last 30 complete UTC days are fetched and written as a cost collection.
  const seen: { since?: Date; until?: Date }[] = [];
  const bodies: (ProviderUsageBatch & { kind?: string; collected_at?: string })[] = [];
  const one = await runScheduledCollection({ env: { K1: "x" }, now: NOW, providers: [provider("one", "K1", 2, seen)], ingest: async (body) => { bodies.push(body); return body.facts.length; } });
  assert.deepEqual(one, { ok: true, results: [{ provider: "one", status: "published", facts: 2 }] });
  assert.equal(seen[0].until!.toISOString(), "2026-11-24T00:00:00.000Z");
  assert.equal(seen[0].since!.toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(bodies[0].kind, "cost-collection-v1");
  assert.equal(bodies[0].collected_at, NOW.toISOString());
  assert.equal(bodies[0].snapshot?.account_id, "one-account");
  console.log("scheduled_publishes_window_ok");

  // One provider failing does not stop the next, and the run reports the failure.
  const written: string[] = [];
  const mixed = await runScheduledCollection({
    env: { K1: "x", K2: "y" }, now: NOW,
    providers: [provider("bad", "K1", new Error("provider down")), provider("good", "K2", 1)],
    ingest: async (body) => { written.push(body.facts[0].session_id!); return body.facts.length; },
    log: () => {},
  });
  assert.deepEqual(mixed, { ok: false, results: [{ provider: "bad", status: "failed" }, { provider: "good", status: "published", facts: 1 }] });
  assert.deepEqual(written, ["good-0"]);
  console.log("scheduled_isolates_failures_ok");

  // A short write is a failure, never a silent success.
  const short = await runScheduledCollection({ env: { K1: "x" }, now: NOW, providers: [provider("one", "K1", 3)], ingest: async () => 2, log: () => {} });
  assert.deepEqual(short, { ok: false, results: [{ provider: "one", status: "failed" }] });
  console.log("scheduled_rejects_short_write_ok");

  // The cron credential: only an exact match with a configured CRON_SECRET.
  const req = (auth?: string) => new Request("https://example.test/api/usage/collect", auth ? { headers: { authorization: auth } } : {});
  assert.equal(await cronAuthorized(req("Bearer s3cret-value-123"), { CRON_SECRET: "s3cret-value-123" }), true);
  assert.equal(await cronAuthorized(req("Bearer wrong"), { CRON_SECRET: "s3cret-value-123" }), false);
  assert.equal(await cronAuthorized(req(), { CRON_SECRET: "s3cret-value-123" }), false);
  assert.equal(await cronAuthorized(req("Bearer undefined"), {}), false);
  assert.equal(await cronAuthorized(req("Bearer "), { CRON_SECRET: "" }), false);
  console.log("scheduled_cron_secret_ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
