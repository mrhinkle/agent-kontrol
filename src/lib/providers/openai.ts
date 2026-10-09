/** Phase 2 stub — OpenAI Admin Usage/Costs API. */
import type { ProviderAdapter } from "./types";

export const openAIAdminAdapter: ProviderAdapter = {
  id: "openai-admin",
  async fetchUsage() {
    throw new Error("OpenAI Admin adapter is Phase 2 — not implemented in Phase 1 prototype");
  },
};
