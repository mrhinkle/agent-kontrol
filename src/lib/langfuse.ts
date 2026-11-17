import { createHash } from "node:crypto";
import type { LangfuseConfig } from "./langfuse-config";
import type { RunTelemetry } from "./run-telemetry";
import { langfuseRunPayload } from "./langfuse-run";

/** A persisted activity event, not a model call or a cumulative usage snapshot. */
export interface LangfuseEvent {
  id: number;
  created_at: string | Date;
  agent_id: string;
  session_id?: string | null;
  platform?: string | null;
  kind: string;
  status?: string;
  run?: RunTelemetry;
}

const KINDS = new Set(["session_start", "turn_start", "waiting", "notification", "session_end", "milestone", "status", "error"]);
const PLATFORMS = new Set(["claude-code", "cowork-cloud", "cowork-local", "chatgpt-work", "codex", "grok", "hermes", "other"]);
const STATUSES = new Set(["active", "waiting", "done", "failed"]);

function hash(namespace: string, ...parts: string[]) {
  return createHash("sha256").update(JSON.stringify(["mission-control", namespace, ...parts])).digest("hex");
}

/** Constructs every exported field from scratch. Free-form event content never crosses this boundary. */
export function langfusePayload(event: LangfuseEvent, environment: string) {
  if (event.kind === "run_complete") return event.run ? langfuseRunPayload(event.run, event.agent_id, event.platform, environment) : null;
  if (!KINDS.has(event.kind) || !Number.isSafeInteger(event.id) || event.id <= 0 || typeof event.agent_id !== "string") return null;
  if (event.session_id != null && typeof event.session_id !== "string") return null;
  const ms = event.created_at instanceof Date ? event.created_at.getTime() : Date.parse(event.created_at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const time = (BigInt(ms) * 1_000_000n).toString();
  const eventKey = String(event.id);
  const failed = event.kind === "error" || event.status === "failed";
  const attrs = [
    ["langfuse.trace.name", `fleet.${event.kind}`],
    ["langfuse.observation.type", "event"],
    ["langfuse.observation.level", failed ? "ERROR" : "DEFAULT"],
    ["langfuse.environment", ["production", "preview", "development"].includes(environment) ? environment : "default"],
    ["langfuse.trace.metadata.event_id", eventKey],
    ["langfuse.trace.metadata.agent_ref", hash("agent", event.agent_id).slice(0, 32)],
    ["langfuse.trace.metadata.platform", PLATFORMS.has(event.platform ?? "") ? event.platform! : "other"],
    ["langfuse.trace.metadata.kind", event.kind],
  ];
  if (STATUSES.has(event.status ?? "")) attrs.push(["langfuse.trace.metadata.reported_status", event.status!]);
  if (event.session_id) {
    attrs.push(["langfuse.session.id", hash("session", event.agent_id, event.session_id).slice(0, 32)]);
  }
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "mission-control" } }] },
      scopeSpans: [{
        scope: { name: "mission-control.fleet", version: "1" },
        spans: [{
          traceId: hash("event-trace", event.agent_id, eventKey).slice(0, 32),
          spanId: hash("event-span", event.agent_id, eventKey).slice(0, 16),
          name: `fleet.${event.kind}`,
          kind: 1,
          startTimeUnixNano: time,
          endTimeUnixNano: time,
          attributes: attrs.map(([key, stringValue]) => ({ key, value: { stringValue } })),
          status: { code: failed ? 2 : 0 },
        }],
      }],
    }],
  };
}

export type ExportResult = "sent" | "skipped" | "http_error" | "partial_rejection" | "invalid_response" | "network_error";

/** One attempt only: v4 observations are immutable and duplicate IDs do not deduplicate retries. */
export async function exportLangfuseEvent(
  event: LangfuseEvent,
  config: LangfuseConfig,
  send: typeof fetch = fetch,
): Promise<ExportResult> {
  const payload = langfusePayload(event, config.environment);
  if (!payload) return "skipped";
  try {
    const response = await send(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return "http_error";
    let result;
    try {
      result = await response.json();
    } catch {
      return "invalid_response";
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) return "invalid_response";
    if (result.partialSuccess && (Number(result.partialSuccess.rejectedSpans ?? 0) !== 0 || result.partialSuccess.errorMessage)) {
      return "partial_rejection";
    }
    return "sent";
  } catch {
    // Never log response bodies, URLs, raw exceptions, or credentials.
    return "network_error";
  }
}
