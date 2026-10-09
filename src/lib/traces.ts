/**
 * Agent traces: pure helpers with no database or network access.
 *
 * A trace is a tree of spans (a session, its turns, the tool and model calls
 * inside each turn). Spans arrive as OTLP/HTTP JSON, the OpenTelemetry wire
 * format, so any OpenTelemetry exporter can send to Agent Kontrol. This file
 * parses that format, strips anything sensitive, and lays spans out as a
 * waterfall for the trace viewer.
 */

export type SpanKind = "session" | "turn" | "tool" | "model" | "other";
export type SpanStatus = "ok" | "error" | "unset";
export type AttrValue = string | number | boolean;

export interface SpanInput {
  trace_id: string; // 32 hex characters
  span_id: string; // 16 hex characters
  parent_span_id: string | null;
  agent_id: string;
  session_id: string | null;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  status_message: string | null;
  started_at: string; // ISO 8601
  ended_at: string | null; // null while the span is still open
  attributes: Record<string, AttrValue>;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

export interface SpanRow extends SpanInput {
  created_at?: string;
}

export interface TraceSummary {
  trace_id: string;
  agent_id: string;
  root_name: string;
  started_at: string;
  ended_at: string | null;
  span_count: number;
  error_count: number;
  open_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export const MAX_SPANS_PER_REQUEST = 500;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ATTRS = 40;
const MAX_KEY = 64;
const MAX_VALUE = 500;
const MAX_NAME = 200;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const ZERO32 = "0".repeat(32);
const ZERO16 = "0".repeat(16);

/** Attribute names that look like credentials are never stored. */
const SECRET_KEY = /(secret|token|password|passwd|authorization|api[._-]?key|cookie|credential|private[._-]?key)/i;
/** Prompt, completion and tool payloads. Stored only when the operator opts in. */
const CONTENT_KEY = /^(gen_ai\.(prompt|completion|input\.messages|output\.messages|system_instructions)|tool\.(input|output)|content|prompt|completion|input|output)$/i;

export function isTraceId(s: unknown): s is string {
  return typeof s === "string" && HEX32.test(s) && s !== ZERO32;
}
export function isSpanId(s: unknown): s is string {
  return typeof s === "string" && HEX16.test(s) && s !== ZERO16;
}

/** Keep only primitive attributes, drop secrets and (by default) content, cap sizes. */
export function sanitizeAttributes(
  attrs: Record<string, unknown>,
  opts: { captureContent?: boolean } = {},
): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [rawKey, value] of Object.entries(attrs)) {
    if (Object.keys(out).length >= MAX_ATTRS) break;
    const key = rawKey.slice(0, MAX_KEY);
    if (!key || SECRET_KEY.test(key)) continue;
    if (!opts.captureContent && CONTENT_KEY.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, MAX_VALUE);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** True when the operator has opted in to storing prompt and tool content. */
export function captureContentEnabled(): boolean {
  const v = process.env.MC_TRACE_CAPTURE_CONTENT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Days to keep spans. 0 or unset-to-invalid falls back to 30. */
export function retentionDays(): number {
  const n = Number(process.env.MC_TRACE_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}

// ---------------------------------------------------------------- OTLP JSON

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}

function kvToObject(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list as OtlpKeyValue[]) {
    if (!kv || typeof kv.key !== "string" || !kv.value) continue;
    const v = kv.value;
    if (v.stringValue !== undefined) out[kv.key] = v.stringValue;
    else if (v.intValue !== undefined) out[kv.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[kv.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[kv.key] = v.boolValue;
  }
  return out;
}

/** Unix nanoseconds (string or number, as OTLP JSON sends them) to an ISO string. */
export function nanoToIso(v: unknown): string | null {
  if (v === undefined || v === null || v === "" || v === "0" || v === 0) return null;
  try {
    const ns = typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.trunc(v) : String(v));
    const ms = Number(ns / 1_000_000n);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

function pickKind(attrs: Record<string, unknown>, parentless: boolean): SpanKind {
  const hint = attrs["agentkontrol.span.kind"];
  if (hint === "session" || hint === "turn" || hint === "tool" || hint === "model" || hint === "other") return hint;
  const op = attrs["gen_ai.operation.name"];
  if (typeof op === "string") return op === "execute_tool" ? "tool" : "model";
  if (Object.keys(attrs).some((k) => k.startsWith("gen_ai."))) return "model";
  if (typeof attrs["tool.name"] === "string") return "tool";
  return parentless ? "session" : "other";
}

export interface ParseResult {
  spans: SpanInput[];
  rejected: number;
  errors: string[];
}

/**
 * Parse an OTLP/HTTP JSON export request (`{ resourceSpans: [...] }`).
 * Invalid spans are counted and skipped, never thrown, so one bad span does not
 * lose the rest of a batch. The agent id comes from the `agent.id` resource
 * attribute, then `service.name`, then `defaultAgent`.
 */
export function parseOtlp(
  body: unknown,
  opts: { defaultAgent?: string; captureContent?: boolean } = {},
): ParseResult {
  const result: ParseResult = { spans: [], rejected: 0, errors: [] };
  const root = body as { resourceSpans?: unknown };
  if (!root || typeof root !== "object" || !Array.isArray(root.resourceSpans)) {
    result.errors.push("body must be an OTLP JSON export with a resourceSpans array");
    return result;
  }

  const note = (msg: string) => {
    result.rejected += 1;
    if (result.errors.length < 5 && !result.errors.includes(msg)) result.errors.push(msg);
  };

  outer: for (const rs of root.resourceSpans as Record<string, unknown>[]) {
    const resource = kvToObject((rs?.resource as { attributes?: unknown } | undefined)?.attributes);
    const agentRaw = resource["agent.id"] ?? resource["service.name"] ?? opts.defaultAgent;
    const agent = typeof agentRaw === "string" && agentRaw.trim() ? agentRaw.trim().slice(0, 100) : null;
    const scopes = Array.isArray(rs?.scopeSpans) ? (rs.scopeSpans as Record<string, unknown>[]) : [];
    for (const scope of scopes) {
      const spans = Array.isArray(scope?.spans) ? (scope.spans as Record<string, unknown>[]) : [];
      for (const s of spans) {
        if (result.spans.length + result.rejected >= MAX_SPANS_PER_REQUEST) {
          note(`more than ${MAX_SPANS_PER_REQUEST} spans in one request; the rest were dropped`);
          break outer;
        }
        const traceId = String(s?.traceId ?? "").toLowerCase();
        const spanId = String(s?.spanId ?? "").toLowerCase();
        if (!isTraceId(traceId) || !isSpanId(spanId)) {
          note("traceId must be 32 hex characters and spanId 16 (non-zero)");
          continue;
        }
        const started = nanoToIso(s.startTimeUnixNano);
        if (!started) {
          note("startTimeUnixNano is required");
          continue;
        }
        if (!agent) {
          note("no agent id: set the agent.id or service.name resource attribute");
          continue;
        }
        const parentRaw = String(s.parentSpanId ?? "").toLowerCase();
        const parent = isSpanId(parentRaw) ? parentRaw : null;
        const rawAttrs = kvToObject(s.attributes);
        const status = (s.status ?? {}) as { code?: number | string; message?: string };
        const code = typeof status.code === "string" ? status.code : Number(status.code ?? 0);
        const spanStatus: SpanStatus =
          code === 2 || code === "STATUS_CODE_ERROR" ? "error" : code === 1 || code === "STATUS_CODE_OK" ? "ok" : "unset";
        const attrs = sanitizeAttributes(rawAttrs, { captureContent: opts.captureContent });
        const model = rawAttrs["gen_ai.response.model"] ?? rawAttrs["gen_ai.request.model"];
        const sessionRaw = rawAttrs["session.id"] ?? rawAttrs["gen_ai.conversation.id"] ?? resource["session.id"];
        result.spans.push({
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parent,
          agent_id: agent,
          session_id: typeof sessionRaw === "string" ? sessionRaw.slice(0, 200) : null,
          name: String(s.name ?? "span").slice(0, MAX_NAME) || "span",
          kind: pickKind(rawAttrs, parent === null),
          status: spanStatus,
          status_message: typeof status.message === "string" && status.message ? status.message.slice(0, MAX_VALUE) : null,
          started_at: started,
          ended_at: nanoToIso(s.endTimeUnixNano),
          attributes: attrs,
          model: typeof model === "string" ? model.slice(0, 120) : null,
          input_tokens: asNumber(rawAttrs["gen_ai.usage.input_tokens"] ?? rawAttrs["gen_ai.usage.prompt_tokens"]),
          output_tokens: asNumber(rawAttrs["gen_ai.usage.output_tokens"] ?? rawAttrs["gen_ai.usage.completion_tokens"]),
          cost_usd: asNumber(rawAttrs["agentkontrol.cost_usd"]),
        });
      }
    }
  }
  return result;
}

/**
 * A span can arrive twice in one batch (opened, then closed). Keep one row per
 * (trace, span), merging so a later close wins over an earlier open.
 */
export function dedupeSpans(spans: SpanInput[]): SpanInput[] {
  const byKey = new Map<string, SpanInput>();
  for (const s of spans) {
    const key = `${s.trace_id}:${s.span_id}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, s);
      continue;
    }
    byKey.set(key, {
      ...prev,
      ...s,
      parent_span_id: s.parent_span_id ?? prev.parent_span_id,
      ended_at: s.ended_at ?? prev.ended_at,
      status: s.status === "unset" ? prev.status : s.status,
      status_message: s.status_message ?? prev.status_message,
      started_at: prev.started_at < s.started_at ? prev.started_at : s.started_at,
      attributes: { ...prev.attributes, ...s.attributes },
      model: s.model ?? prev.model,
      input_tokens: s.input_tokens ?? prev.input_tokens,
      output_tokens: s.output_tokens ?? prev.output_tokens,
      cost_usd: s.cost_usd ?? prev.cost_usd,
    });
  }
  return [...byKey.values()];
}

// --------------------------------------------------------------- waterfall

export interface WaterfallRow {
  span: SpanRow;
  depth: number;
  /** Where the bar starts, 0 to 100 percent of the trace window. */
  offsetPct: number;
  /** Bar width, at least a sliver so instant spans stay visible. */
  widthPct: number;
  durationMs: number | null;
  open: boolean;
}

export interface Waterfall {
  rows: WaterfallRow[];
  startMs: number;
  endMs: number;
  totalMs: number;
}

export function durationMs(s: Pick<SpanRow, "started_at" | "ended_at">): number | null {
  if (!s.ended_at) return null;
  return Math.max(0, Date.parse(s.ended_at) - Date.parse(s.started_at));
}

/**
 * Order spans depth-first (children under their parent, by start time) and
 * compute each bar's position. A span whose parent is missing is treated as a
 * root, so a partial trace still renders. Open spans extend to `nowMs`.
 */
export function buildWaterfall(spans: SpanRow[], nowMs: number = Date.now()): Waterfall {
  if (spans.length === 0) return { rows: [], startMs: 0, endMs: 0, totalMs: 0 };

  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string | null, SpanRow[]>();
  for (const s of spans) {
    const parent = s.parent_span_id && ids.has(s.parent_span_id) && s.parent_span_id !== s.span_id ? s.parent_span_id : null;
    const list = children.get(parent) ?? [];
    list.push(s);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));

  const startMs = Math.min(...spans.map((s) => Date.parse(s.started_at)));
  const endOf = (s: SpanRow) => (s.ended_at ? Date.parse(s.ended_at) : nowMs);
  const endMs = Math.max(startMs, ...spans.map(endOf));
  const totalMs = Math.max(1, endMs - startMs);

  const rows: WaterfallRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      if (seen.has(s.span_id)) continue; // guards against cycles
      seen.add(s.span_id);
      const a = Date.parse(s.started_at);
      const b = endOf(s);
      rows.push({
        span: s,
        depth,
        offsetPct: ((a - startMs) / totalMs) * 100,
        widthPct: Math.max(0.4, ((Math.max(a, b) - a) / totalMs) * 100),
        durationMs: durationMs(s),
        open: s.ended_at === null,
      });
      walk(s.span_id, depth + 1);
    }
  };
  walk(null, 0);
  return { rows, startMs, endMs, totalMs };
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "running";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
