import type { AccountRecord } from "../usage-accounts";
import type { UsageFact } from "../usage-types";

export interface AccountSnapshot {
  account_id: string;
  collected_at: string;
  balance_usd?: number | null;
  credits_remaining?: number | null;
  quota_detail?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
}

export interface ProviderUsageBatch {
  facts: UsageFact[];
  snapshot?: AccountSnapshot;
}

export interface ProviderAdapter {
  id: string;
  fetchUsage(account: AccountRecord, since: Date): Promise<ProviderUsageBatch>;
  fetchSnapshot?(account: AccountRecord): Promise<AccountSnapshot>;
}
