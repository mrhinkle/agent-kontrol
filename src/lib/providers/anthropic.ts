/** Phase 2 stub — Anthropic Admin Usage & Cost API. */
import type { ProviderAdapter } from "./types";

export const anthropicAdminAdapter: ProviderAdapter = {
  id: "anthropic-admin",
  async fetchUsage() {
    throw new Error("Anthropic Admin adapter is Phase 2 — not implemented in Phase 1 prototype");
  },
};
