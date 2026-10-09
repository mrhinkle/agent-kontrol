/** Phase 2 stub — xAI Management billing/usage API. */
import type { ProviderAdapter } from "./types";

export const xaiManagementAdapter: ProviderAdapter = {
  id: "xai-management",
  async fetchUsage() {
    throw new Error("xAI Management adapter is Phase 2 — not implemented in Phase 1 prototype");
  },
};
