import { anthropicAdminAdapter } from "./anthropic";
import { openAIAdminAdapter } from "./openai";
import { openRouterAdapter } from "./openrouter";
import { xaiManagementAdapter } from "./xai";
import type { ProviderAdapter } from "./types";

export type { ProviderAdapter, ProviderUsageBatch, AccountSnapshot } from "./types";
export { openRouterAdapter, fetchUsageFromFixture, activityToFacts } from "./openrouter";
export type { OpenRouterFixture, OpenRouterActivityDay } from "./openrouter";

export const PROVIDER_ADAPTERS: Record<string, ProviderAdapter> = {
  openrouter: openRouterAdapter,
  "openai-admin": openAIAdminAdapter,
  "anthropic-admin": anthropicAdminAdapter,
  "xai-management": xaiManagementAdapter,
};
