/** Completed dispatcher invocations. No text, prices, or billing fields belong in this contract. */
export interface ModelUsage {
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

export interface RunTelemetry {
  schema: "mc.run.v2";
  run_id: string;
  role: "worker" | "review";
  started_at: string;
  ended_at: string;
  duration_ms: number;
  outcome: "completed" | "failed" | "timeout" | "unavailable";
  error_class: "process_error" | "timeout" | "unavailable" | "protocol_error" | null;
  usage_scope: "run" | "session_cumulative" | "unavailable";
  usage_complete: boolean;
  model_usage: ModelUsage[];
  task_id?: number;
}

export const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const;
const OUTCOMES = new Set(["completed", "failed", "timeout", "unavailable"]);
const ERRORS = new Set(["process_error", "timeout", "unavailable", "protocol_error"]);
const PLATFORMS = new Set(["claude-code", "cowork-cloud", "cowork-local", "chatgpt-work", "codex", "grok", "hermes", "other"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function platformLabel(value: unknown): string {
  return typeof value === "string" && PLATFORMS.has(value) ? value : "other";
}

/** Keep recognizable model identifiers, and never forward arbitrary free-form labels. */
export function safeModel(value: unknown): string {
  if (typeof value !== "string" || value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._/+:-]*$/.test(value)) return "unknown";
  if (/(?:^|[-_])(sk|pk)[-_]|secret|password|bearer|api.?key/i.test(value)) return "unknown";
  return /^(?:[a-z0-9._-]+\/)?(?:gpt-|o\d(?:-|$)|claude-|grok-|gemini-|deepseek[-/]|qwen|llama|mistral|mixtral|glm-|kimi-|minimax|hermes-|nous-|unknown$)/i.test(value) ? value : "unknown";
}

export function parseRunTelemetry(value: unknown): RunTelemetry | null {
  const raw = record(value);
  if (!raw || raw.schema !== "mc.run.v2" || typeof raw.run_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw.run_id)) return null;
  if (raw.role !== "worker" && raw.role !== "review") return null;
  if (typeof raw.started_at !== "string" || typeof raw.ended_at !== "string") return null;
  const start = Date.parse(raw.started_at), end = Date.parse(raw.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end - start > 7 * 86400_000) return null;
  if (typeof raw.duration_ms !== "number" || !Number.isFinite(raw.duration_ms) || raw.duration_ms < 0 || raw.duration_ms > 7 * 86400_000) return null;
  if (Math.abs(end - start - raw.duration_ms) > 1000) return null;
  if (typeof raw.outcome !== "string" || !OUTCOMES.has(raw.outcome)) return null;
  if (raw.usage_scope !== "run" && raw.usage_scope !== "session_cumulative" && raw.usage_scope !== "unavailable") return null;
  if (typeof raw.usage_complete !== "boolean" || !Array.isArray(raw.model_usage) || raw.model_usage.length > 32) return null;
  const usage: ModelUsage[] = [];
  for (const item of raw.model_usage) {
    const source = record(item);
    if (!source) return null;
    const model: ModelUsage = { model: safeModel(source.model) };
    for (const field of TOKEN_FIELDS) {
      const n = source[field];
      if (n === undefined) continue;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000) return null;
      model[field] = n;
    }
    if (model.input_tokens !== undefined && (model.cache_read_tokens ?? 0) + (model.cache_write_tokens ?? 0) > model.input_tokens) return null;
    usage.push(model);
  }
  // Resumed/cumulative envelopes cannot be counted as the current invocation's usage.
  if (raw.usage_scope !== "run" && usage.length) return null;
  const result: RunTelemetry = {
    schema: "mc.run.v2", run_id: raw.run_id.toLowerCase(), role: raw.role,
    started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(),
    duration_ms: raw.duration_ms, outcome: raw.outcome as RunTelemetry["outcome"],
    error_class: typeof raw.error_class === "string" && ERRORS.has(raw.error_class) ? raw.error_class as RunTelemetry["error_class"] : null,
    usage_scope: raw.usage_scope, usage_complete: raw.usage_complete && raw.usage_scope === "run" && usage.length > 0 && usage.every((u) => u.input_tokens !== undefined && u.output_tokens !== undefined),
    model_usage: usage,
  };
  if (Number.isSafeInteger(raw.task_id) && Number(raw.task_id) > 0) result.task_id = Number(raw.task_id);
  return result;
}

export interface RunView { event_id: number; agent_id: string; platform: string; run: RunTelemetry }

export function summarizeRuns(rows: RunView[], since: number, until: number) {
  const unique = new Map<string, RunView>();
  for (const row of rows) {
    const run = parseRunTelemetry(row.run);
    if (!run || Date.parse(run.ended_at) < since || Date.parse(run.ended_at) >= until) continue;
    unique.set(`${row.agent_id}:${run.run_id}`, { ...row, platform: platformLabel(row.platform), run });
  }
  const runs = [...unique.values()].sort((a, b) => Date.parse(b.run.ended_at) - Date.parse(a.run.ended_at));
  const durations = runs.map((r) => r.run.duration_ms).sort((a, b) => a - b);
  const quantile = (q: number) => durations.length ? durations[Math.max(0, Math.ceil(q * durations.length) - 1)] : null;
  const models = new Map<string, { model: string; input_tokens: number | null; output_tokens: number | null; runs: number }>();
  for (const { run } of runs) {
    if (run.usage_scope !== "run") continue;
    const seen = new Set<string>();
    for (const usage of run.model_usage) {
      const row = models.get(usage.model) ?? { model: usage.model, input_tokens: null, output_tokens: null, runs: 0 };
      if (!seen.has(usage.model)) row.runs++;
      seen.add(usage.model);
      if (usage.input_tokens !== undefined) row.input_tokens = (row.input_tokens ?? 0) + usage.input_tokens;
      if (usage.output_tokens !== undefined) row.output_tokens = (row.output_tokens ?? 0) + usage.output_tokens;
      models.set(usage.model, row);
    }
  }
  return {
    runs,
    totals: {
      completed_runs: runs.length,
      failed_runs: runs.filter(({ run }) => run.outcome !== "completed").length,
      runs_with_usage: runs.filter(({ run }) => run.usage_scope === "run" && run.model_usage.length).length,
      complete_usage_runs: runs.filter(({ run }) => run.usage_complete).length,
      p50_duration_ms: quantile(0.5), p95_duration_ms: quantile(0.95),
    },
    models: [...models.values()].sort((a, b) => (b.input_tokens ?? 0) - (a.input_tokens ?? 0)),
  };
}
