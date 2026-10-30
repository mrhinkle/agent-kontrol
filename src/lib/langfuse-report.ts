import { after } from "next/server";
import { langfuseConfig, type LangfuseConfig } from "./langfuse-config";
import { exportLangfuseEvent, langfusePayload, type LangfuseEvent } from "./langfuse";

/** Called only after the event INSERT succeeds; Next keeps the export alive after the response. */
export function queueLangfuseEvent(event: LangfuseEvent, schedule: typeof after = after, config?: LangfuseConfig | null) {
  try {
    const configured = config === undefined ? langfuseConfig() : config;
    if (!configured || !langfusePayload(event, configured.environment)) return;
    schedule(async () => {
      const result = await exportLangfuseEvent(event, configured);
      if (result !== "sent" && result !== "skipped") console.warn(`Langfuse event export: ${result}`);
    });
  } catch {
    // Optional observability must never change successful fleet ingestion into a failure.
    console.warn("Langfuse event export: scheduling_failed");
  }
}
