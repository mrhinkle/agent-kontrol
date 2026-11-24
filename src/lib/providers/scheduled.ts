/**
 * Provider billing collection run by the deployment itself (a scheduler calls
 * GET /api/usage/collect) instead of a script on an operator's machine.
 * Only providers whose management credentials are set in the environment run.
 */
import { secretsMatch } from "../authcrypto";
import { getAccount } from "../usage-accounts";
import { anthropicAdminAdapter } from "./anthropic";
import { openRouterAdapter } from "./openrouter";
import { DAY_MS, utcMidnight } from "./transport";
import type { ProviderAdapter, ProviderUsageBatch } from "./types";
import { xaiManagementAdapter } from "./xai";

type Env = Record<string, string | undefined>;

export interface ScheduledProvider {
  id: string;
  accountId: string;
  adapter: ProviderAdapter;
  /** True when every credential the adapter needs is present. */
  configured(env: Env): boolean;
}

export const SCHEDULED_PROVIDERS: ScheduledProvider[] = [
  { id: "openrouter", accountId: "openrouter-shared", adapter: openRouterAdapter,
    configured: (env) => !!(env.MC_OPENROUTER_MANAGEMENT_KEY || env.OPENROUTER_MANAGEMENT_KEY) },
  { id: "anthropic", accountId: "anthropic-api-org", adapter: anthropicAdminAdapter,
    configured: (env) => !!(env.MC_ANTHROPIC_ADMIN_KEY || env.ANTHROPIC_ADMIN_KEY) },
  { id: "xai", accountId: "xai-api-team", adapter: xaiManagementAdapter,
    configured: (env) => !!(env.MC_XAI_MANAGEMENT_KEY || env.XAI_MANAGEMENT_KEY) && !!(env.MC_XAI_TEAM_ID || env.XAI_TEAM_ID) },
];

export type ScheduledIngestBody = ProviderUsageBatch & { kind: "cost-collection-v1"; collected_at: string };

export interface ScheduledResult {
  provider: string;
  status: "published" | "skipped" | "failed";
  facts?: number;
}

export interface ScheduledOptions {
  /** Writes one provider's report and returns the number of facts written. */
  ingest: (body: ScheduledIngestBody) => Promise<number>;
  env?: Env;
  now?: Date;
  /** Complete UTC days to collect, 1 to 30. */
  days?: number;
  providers?: ScheduledProvider[];
  log?: (message: string) => void;
}

/**
 * Collect the last `days` complete UTC days for each configured provider.
 * Providers are independent: one failing does not stop the next. `ok` is
 * false when any configured provider failed; an unconfigured one is skipped.
 */
export async function runScheduledCollection(opts: ScheduledOptions): Promise<{ ok: boolean; results: ScheduledResult[] }> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const days = opts.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("days must be 1 to 30");
  const log = opts.log ?? ((message: string) => console.error(message));
  const until = utcMidnight(now);
  const since = new Date(until.getTime() - days * DAY_MS);
  const results: ScheduledResult[] = [];
  for (const provider of opts.providers ?? SCHEDULED_PROVIDERS) {
    if (!provider.configured(env)) {
      results.push({ provider: provider.id, status: "skipped" });
      continue;
    }
    try {
      // Tests inject accounts that are not in the registry; the adapters under test ignore the record.
      const account = getAccount(provider.accountId) ?? { id: provider.accountId };
      const batch = await provider.adapter.fetchUsage(account as NonNullable<ReturnType<typeof getAccount>>, since, until);
      const written = await opts.ingest({ kind: "cost-collection-v1", collected_at: batch.snapshot?.collected_at ?? now.toISOString(), ...batch });
      if (written !== batch.facts.length) throw new Error("Incomplete usage batch");
      results.push({ provider: provider.id, status: "published", facts: written });
    } catch (err) {
      // Adapter and transport messages are fixed strings: no secret or provider response.
      log(`[usage] scheduled collection failed for ${provider.id}: ${err instanceof Error ? err.message : "unknown error"}`);
      results.push({ provider: provider.id, status: "failed" });
    }
  }
  return { ok: results.every((r) => r.status !== "failed"), results };
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. No secret configured means no cron access. */
export async function cronAuthorized(req: Request, env: Env = process.env): Promise<boolean> {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return secretsMatch(header.slice(7), secret);
}
