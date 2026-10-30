import { createHash } from "node:crypto";
import { TOKEN_FIELDS, parseRunTelemetry, platformLabel, type RunTelemetry } from "./run-telemetry";

const digest = (...parts: string[]) => createHash("sha256").update(JSON.stringify(["mission-control", ...parts])).digest("hex");
type Attr = { key: string; value: { stringValue: string } | { intValue: string } | { boolValue: boolean } };
interface RunSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string; attributes: Attr[]; status: { code: number };
}
const text = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const integer = (key: string, value: number): Attr => ({ key, value: { intValue: String(Math.round(value)) } });

/** A real worker-run span plus model totals. Totals are not mislabeled as individual inference calls. */
export function langfuseRunPayload(raw: RunTelemetry, agentId: string, platform: unknown, environment: string) {
  const run = parseRunTelemetry(raw);
  if (!run) return null;
  const traceId = digest("run-trace", agentId, run.run_id).slice(0, 32);
  const rootId = digest("run-span", agentId, run.run_id).slice(0, 16);
  const start = (BigInt(Date.parse(run.started_at)) * 1_000_000n).toString();
  const end = (BigInt(Date.parse(run.ended_at)) * 1_000_000n).toString();
  const shared = [
    text("langfuse.trace.name", `fleet.${run.role}_run`),
    text("langfuse.session.id", run.task_id ? digest("task", String(run.task_id)).slice(0, 32) : digest("run", agentId, run.run_id).slice(0, 32)),
    text("langfuse.environment", ["production", "preview", "development"].includes(environment) ? environment : "default"),
    text("langfuse.trace.metadata.agent_ref", digest("agent", agentId).slice(0, 32)),
    text("langfuse.trace.metadata.platform", platformLabel(platform)),
    text("langfuse.trace.metadata.role", run.role),
  ];
  const level = run.outcome === "completed" ? "DEFAULT" : "ERROR";
  const root: RunSpan = {
    traceId, spanId: rootId, name: `fleet.${run.role}_run`, kind: 1,
    startTimeUnixNano: start, endTimeUnixNano: end,
    attributes: [
      ...shared, text("langfuse.observation.type", "agent"), text("langfuse.observation.level", level),
      text("langfuse.observation.metadata.outcome", run.outcome),
      text("langfuse.observation.metadata.latency_scope", "cli_process_wall_time"),
      integer("langfuse.observation.metadata.duration_ms", run.duration_ms),
      text("langfuse.observation.metadata.usage_scope", run.usage_scope),
      { key: "langfuse.observation.metadata.usage_complete", value: { boolValue: run.usage_complete } } as Attr,
      ...(run.error_class ? [text("langfuse.observation.metadata.error_class", run.error_class)] : []),
    ],
    status: { code: run.outcome === "completed" ? 0 : 2 },
  };
  const models: RunSpan[] = run.model_usage.map((usage, index) => ({
    traceId, spanId: digest("run-model", agentId, run.run_id, String(index)).slice(0, 16), parentSpanId: rootId,
    name: "run.model_usage", kind: 1, startTimeUnixNano: end, endTimeUnixNano: end,
    attributes: [
      ...shared, text("langfuse.observation.type", "span"), text("langfuse.observation.metadata.model", usage.model),
      text("langfuse.observation.metadata.usage_scope", "run_total"),
      text("langfuse.observation.metadata.latency_scope", "not_measured"),
      ...TOKEN_FIELDS.flatMap((field) => usage[field] === undefined ? [] : [integer(`langfuse.observation.metadata.${field}`, usage[field]!)]),
    ],
    status: { code: 0 },
  }));
  return { resourceSpans: [{ resource: { attributes: [text("service.name", "mission-control")] }, scopeSpans: [{ scope: { name: "mission-control.runs", version: "2" }, spans: [root, ...models] }] }] };
}
