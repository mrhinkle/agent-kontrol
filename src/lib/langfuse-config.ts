/**
 * Optional Langfuse connection. Tracing is off unless both API keys are set,
 * so a deploy with no Langfuse variables behaves exactly as before.
 *
 * The host is LANGFUSE_BASEURL, then LANGFUSE_HOST, then LANGFUSE_BASE_URL
 * (the name current Langfuse docs use). The default is Langfuse Cloud (EU).
 * https is required. http is accepted only for localhost and 127.0.0.1.
 */
import "server-only";
import { redactText, sanitizeAttributes } from "@/lib/traces";

export const LANGFUSE_DEFAULT_BASE_URL = "https://cloud.langfuse.com";

const BASE_URL_VARS = ["LANGFUSE_BASEURL", "LANGFUSE_HOST", "LANGFUSE_BASE_URL"] as const;
export type LangfuseBaseUrlVar = (typeof BASE_URL_VARS)[number];

const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REF_HEX = /^[0-9a-f]{12}$/;

/**
 * Names this server registers with MCP. A tool name is copied only when it is
 * one of these. Anything else is a caller string and is fingerprinted.
 */
const MCP_TOOL_NAMES = new Set([
  "report_status",
  "get_fleet_status",
  "get_progress_digest",
  "remember",
  "recall",
  "check_inbox",
  "reply_to_operator",
  "reply_to_mark",
  "create_task",
  "get_task_queue",
  "claim_task",
  "update_task",
]);

/** Literal span names used by call sites. Anything else, including a forged `mcp.*` name, is `unknown`. */
const SPAN_NAMES = new Set([
  "task.create",
  "task.claim",
  "task.update",
  "ingest.event",
  "ingest.usage",
  "ingest.progress",
  "ingest.traces",
]);

const ERROR_KINDS = ["validation", "auth", "not_found", "conflict", "timeout", "upstream", "internal"] as const;
export type LangfuseErrorKind = (typeof ERROR_KINDS)[number];
const ERROR_KIND_SET = new Set<string>(ERROR_KINDS);

/**
 * Class or `error.name` only. The message is never consulted and never copied.
 * A Map, not a plain object: `obj["__proto__"]` and `obj["constructor"]` would
 * otherwise return inherited values and export them as `error_kind`.
 */
const ERROR_NAME_KIND: ReadonlyMap<string, LangfuseErrorKind> = new Map([
  ["ZodError", "validation"],
  ["ValidationError", "validation"],
  ["SyntaxError", "validation"],
  ["URIError", "validation"],
  ["UnauthorizedError", "auth"],
  ["AuthenticationError", "auth"],
  ["ForbiddenError", "auth"],
  ["AuthError", "auth"],
  ["NotFoundError", "not_found"],
  ["ConflictError", "conflict"],
  ["TimeoutError", "timeout"],
  ["AbortError", "timeout"],
  ["FetchError", "upstream"],
  ["UpstreamError", "upstream"],
]);

/** Node errno-style codes. Same Map rule as `ERROR_NAME_KIND`. */
const ERROR_CODE_KIND: ReadonlyMap<string, LangfuseErrorKind> = new Map([
  ["ETIMEDOUT", "timeout"],
  ["ESOCKETTIMEDOUT", "timeout"],
  ["ERR_TIMEOUT", "timeout"],
  ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
  ["UND_ERR_HEADERS_TIMEOUT", "timeout"],
  ["UND_ERR_BODY_TIMEOUT", "timeout"],
  ["ABORT_ERR", "timeout"],
  ["ECONNREFUSED", "upstream"],
  ["ECONNRESET", "upstream"],
  ["EHOSTUNREACH", "upstream"],
  ["EAI_AGAIN", "upstream"],
  ["ENOTFOUND", "upstream"],
  ["UND_ERR_SOCKET", "upstream"],
  ["23505", "conflict"],
  ["23503", "conflict"],
  ["40001", "conflict"],
  ["22P02", "validation"],
  ["23502", "validation"],
  ["23514", "validation"],
  ["28000", "auth"],
  ["28P01", "auth"],
]);

function mappedKind(map: ReadonlyMap<string, LangfuseErrorKind>, key: string): LangfuseErrorKind | undefined {
  const kind = map.get(key);
  return kind !== undefined && ERROR_KIND_SET.has(kind) ? kind : undefined;
}

const PLATFORMS = new Set([
  "claude-code",
  "cowork-cloud",
  "cowork-local",
  "chatgpt-work",
  "codex",
  "grok",
  "hermes",
  "other",
  "any",
]);
const REVIEWER_PLATFORMS = new Set(["claude-code", "codex", "grok"]);
const EVENT_KINDS = new Set([
  "session_start",
  "turn_start",
  "waiting",
  "notification",
  "session_end",
  "milestone",
  "status",
  "error",
  "heartbeat",
  "tick",
  "daily",
  "backfill",
]);
const STATUSES = new Set([
  "active",
  "waiting",
  "done",
  "failed",
  "offline",
  "queued",
  "claimed",
  "running",
  "review",
  "cancelled",
  "open",
  "all",
]);
const WINDOWS = new Set(["24h", "7d", "30d", "90d"]);
const COST_BUCKETS = new Set(["none", "lt_1", "lt_10", "lt_100", "gte_100"]);
/** The only tag this process attaches. Anything else is dropped at the gate. */
const EXPORT_TAGS = new Set(["agent-kontrol"]);

/** Caller-supplied strings. Exported only as a keyed fingerprint, never raw. */
const REF_FIELDS = [
  "agent_id",
  "machine",
  "session_id",
  "project",
  "created_by",
  "assigned_agent",
  "in_reply_to",
  "id",
  "tool",
] as const;

const COUNT_FIELDS = new Set([
  "repo_count",
  "fact_count",
  "span_count",
  "rejected",
  "agent_count",
  "tag_count",
  "content_chars",
  "body_chars",
  "description_chars",
  "result_chars",
  "title_chars",
  "summary_chars",
  "http_status",
]);
const BOOL_FIELDS = new Set(["demo", "ack", "has_query", "has_key", "has_result", "has_snapshot"]);

/** Settings probe refuses a project list larger than this. */
const MAX_PROBE_BYTES = 64 * 1024;

/** `-0` compares equal to `0`. `Object.is` is what rejects it. */
function asCount(value: unknown, max = 1_000_000_000): number | undefined {
  if (typeof value !== "number" || Object.is(value, -0) || !Number.isInteger(value) || value < 0 || value > max) return undefined;
  return value;
}

function asPriority(value: unknown): number | undefined {
  if (typeof value !== "number" || Object.is(value, -0) || !Number.isInteger(value) || value < 1 || value > 3) return undefined;
  return value;
}

function asLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || Object.is(value, -0) || !Number.isInteger(value) || value < 1 || value > 100) return undefined;
  return value;
}

/**
 * Coarse cost band. The request's dollar amount is not exported.
 * Zero is `none`. A non-finite value, a negative value, or `-0` is dropped.
 */
function asCostBucket(value: unknown): string | undefined {
  if (typeof value !== "number" || Object.is(value, -0) || !Number.isFinite(value) || value < 0) return undefined;
  if (value === 0) return "none";
  if (value < 1) return "lt_1";
  if (value < 10) return "lt_10";
  if (value < 100) return "lt_100";
  return "gte_100";
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** `agent_id` becomes `agent_ref`. Other fields keep their name and gain `_ref`. */
function refKeyFor(field: string): string {
  const base = field.endsWith("_id") ? field.slice(0, -3) : field;
  return `${base}_ref`;
}

const KNOWN_REFS = new Set<string>(REF_FIELDS.map((field) => refKeyFor(field)));

type ExportValue = string | number | boolean;
type ExportCheck = (value: unknown) => ExportValue | undefined;

/**
 * Every metadata key that may leave the process, and the only check that
 * accepts it. Lookup is `Map.get`, never `schema[key]` on a plain object.
 * A key that is not registered here is dropped, including keys a new call
 * site invents.
 */
const EXPORT_SCHEMA = new Map<string, ExportCheck>();

function allowEnum(allowed: ReadonlySet<string>): ExportCheck {
  return (value) => (typeof value === "string" && allowed.has(value) ? value : undefined);
}

function allowRef(): ExportCheck {
  return (value) => (typeof value === "string" && REF_HEX.test(value) ? value : undefined);
}

function registerExport(keys: Iterable<string>, check: ExportCheck): void {
  for (const key of keys) EXPORT_SCHEMA.set(key, check);
}

registerExport(["platform"], allowEnum(PLATFORMS));
registerExport(["reviewer_platform"], allowEnum(REVIEWER_PLATFORMS));
registerExport(["kind"], allowEnum(EVENT_KINDS));
registerExport(["status"], allowEnum(STATUSES));
registerExport(["window"], allowEnum(WINDOWS));
registerExport(["error_kind"], allowEnum(ERROR_KIND_SET));
registerExport(["tool"], allowEnum(MCP_TOOL_NAMES));
registerExport(["cost_bucket"], allowEnum(COST_BUCKETS));
registerExport(["priority"], (value) => asPriority(value));
registerExport(["limit"], (value) => asLimit(value));
registerExport(["id", "in_reply_to"], (value) => asCount(value));
registerExport(COUNT_FIELDS, (value) => asCount(value));
registerExport(BOOL_FIELDS, (value) => asBool(value));
registerExport(KNOWN_REFS, allowRef());
registerExport(["error_ref"], allowRef());

export interface LangfuseExportGate {
  metadata: Record<string, ExportValue>;
  level: "DEFAULT" | "ERROR";
  /** A closed error kind. Absent when the caller did not pass one that is on the list. */
  statusMessage?: LangfuseErrorKind;
  tags: string[];
}

/**
 * Own enumerable entries. Throws from ownKeys, hasOwn, get, or a getter
 * propagate. The export gate catches them and returns nothing.
 */
function ownEntries(input: unknown): [string, unknown][] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const keys = Object.keys(input);
  const out: [string, unknown][] = [];
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) continue;
    const desc = Object.getOwnPropertyDescriptor(input, key);
    if (!desc) continue;
    out.push([key, desc.get ? desc.get.call(input) : desc.value]);
  }
  return out;
}

/** Nothing leaves when the gate cannot finish. A new object, so callers cannot share one. */
function emptyLangfuseExport(): LangfuseExportGate {
  return { metadata: {}, tags: [], level: "DEFAULT", statusMessage: undefined };
}

/**
 * Last check before metadata, status, level, or tags are handed to the SDK
 * or the test emitter. Unknown keys and values that fail their validator are
 * dropped. This does not trust the call site that built the record.
 */
export function gateLangfuseExport(input: {
  metadata?: unknown;
  level?: unknown;
  statusMessage?: unknown;
  tags?: unknown;
}): LangfuseExportGate {
  try {
    const metadata: Record<string, ExportValue> = {};
    for (const [key, value] of ownEntries(input.metadata)) {
      const check = EXPORT_SCHEMA.get(key);
      if (!check) continue;
      const kept = check(value);
      if (kept !== undefined) metadata[key] = kept;
    }
    const statusMessage =
      typeof input.statusMessage === "string" && ERROR_KIND_SET.has(input.statusMessage)
        ? (input.statusMessage as LangfuseErrorKind)
        : undefined;
    const level = input.level === "ERROR" ? "ERROR" : "DEFAULT";
    const tags: string[] = [];
    if (Array.isArray(input.tags)) {
      for (const tag of input.tags) {
        if (typeof tag === "string" && EXPORT_TAGS.has(tag)) tags.push(tag);
      }
    }
    return statusMessage ? { metadata, level, statusMessage, tags } : { metadata, level, tags };
  } catch {
    return emptyLangfuseExport();
  }
}

function langfuseSecret(): string | null {
  const trimmed = process.env.LANGFUSE_SECRET_KEY?.trim();
  return trimmed ? trimmed : null;
}

interface Hmac {
  update(data: string, encoding: "utf8"): Hmac;
  digest(encoding: "hex"): string;
}

/**
 * Node's crypto, loaded at call time. A static import breaks the Next build:
 * this module is pulled into the settings page and the instrumentation bundle,
 * and those compilations do not resolve `node:crypto`.
 *
 * `process.getBuiltinModule` exists on Node >=22.3.0. When it is missing, or
 * crypto fails, fingerprints are omitted. This function does not throw.
 */
function hmacSha256(secret: string, message: string): string | undefined {
  try {
    const getter = (process as { getBuiltinModule?: unknown }).getBuiltinModule;
    if (typeof getter !== "function") return undefined;
    const loaded = (getter as (id: string) => unknown).call(process, "crypto") as {
      createHmac?: (algorithm: string, key: string) => Hmac;
    } | null;
    if (!loaded || typeof loaded.createHmac !== "function") return undefined;
    const digest = loaded.createHmac("sha256", secret).update(message, "utf8").digest("hex");
    return typeof digest === "string" ? digest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * First 12 hex characters of HMAC-SHA256(secret, field + ":" + value).
 * The field name is part of the message so the same text in two fields
 * does not produce the same fingerprint. No secret, no fingerprint.
 */
function keyedRef(field: string, value: string): string | undefined {
  try {
    const secret = langfuseSecret();
    if (!secret || !value) return undefined;
    const hex = hmacSha256(secret, `${field}:${value}`);
    if (!hex || hex.length < 12) return undefined;
    return hex.slice(0, 12);
  } catch {
    return undefined;
  }
}

function httpStatusKind(status: number): LangfuseErrorKind | undefined {
  if (status === 400 || status === 422) return "validation";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 408 || status === 504) return "timeout";
  if (status === 502 || status === 503) return "upstream";
  return undefined;
}

function readHttpStatus(err: object): number | undefined {
  const rec = err as { status?: unknown; statusCode?: unknown };
  for (const value of [rec.status, rec.statusCode]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

/** Closed kind from the error's class, name, or status code. The message is not read. */
export function langfuseErrorKind(err: unknown): LangfuseErrorKind {
  if (!err || (typeof err !== "object" && typeof err !== "string")) return "internal";
  if (typeof err === "object") {
    const status = readHttpStatus(err);
    if (status !== undefined) {
      const fromStatus = httpStatusKind(status);
      if (fromStatus) return fromStatus;
    }
    const named = err instanceof Error && typeof err.name === "string" ? err.name : "";
    const fromName = named ? mappedKind(ERROR_NAME_KIND, named) : undefined;
    if (fromName) return fromName;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number" && Number.isInteger(code)) {
      const fromCode = httpStatusKind(code);
      if (fromCode) return fromCode;
    }
    if (typeof code === "string") {
      const fromCode = mappedKind(ERROR_CODE_KIND, code);
      if (fromCode) return fromCode;
    }
  }
  return "internal";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return typeof err.message === "string" ? err.message : "";
  if (typeof err === "string") return err;
  return "";
}

/**
 * What a failed span may export: a closed `error_kind`, and `error_ref` when
 * the message can be fingerprinted. The message itself is never returned.
 */
export function langfuseErrorFields(err: unknown): { error_kind: LangfuseErrorKind; error_ref?: string } {
  const error_kind = langfuseErrorKind(err);
  const error_ref = keyedRef("error", errorMessage(err));
  return error_ref ? { error_kind, error_ref } : { error_kind };
}

/** `task.create` and `mcp.<registered tool>` pass through. Every other name is `unknown`. */
export function langfuseSpanName(name: string): string {
  if (typeof name !== "string") return "unknown";
  if (SPAN_NAMES.has(name)) return name;
  if (name.startsWith("mcp.")) {
    const tool = name.slice(4);
    if (MCP_TOOL_NAMES.has(tool)) return `mcp.${tool}`;
  }
  return "unknown";
}

export type EnvLike = Record<string, string | undefined>;

export interface LangfuseConfig {
  enabled: boolean;
  baseUrl: string;
  baseUrlSource: LangfuseBaseUrlVar | "default";
  /** Set when an explicit host was present but rejected. Tracing stays off. */
  baseUrlError: string | null;
  publicKey: string | null;
  secretKey: string | null;
}

export type LangfuseConnectionState = "not_configured" | "connected" | "unreachable";

export interface LangfuseStatus {
  state: LangfuseConnectionState;
  /** True when both keys are set and the host is a usable URL. */
  configured: boolean;
  baseUrl: string;
  projectName: string | null;
  /** Project page when Langfuse returned an id, otherwise the host. Null when not configured. */
  projectUrl: string | null;
  message: string | null;
}

export interface LangfuseProjectsResponse {
  data?: { id?: unknown; name?: unknown }[];
}

function nonempty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** https origin or path prefix. http only for localhost and 127.0.0.1. No credentials, queries, or hashes. */
export function parseLangfuseBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const httpLocal = url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !httpLocal) return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

/** name and code only. Error messages can carry URLs and secrets, so they stay out of the log. */
export function formatLangfuseSetupError(err: unknown): string {
  const name = err instanceof Error && /^[A-Za-z][A-Za-z0-9_]*$/.test(err.name) ? err.name : "Error";
  if (!err || typeof err !== "object" || !("code" in err)) return name;
  const raw = (err as { code?: unknown }).code;
  if ((typeof raw !== "string" && typeof raw !== "number") || !/^[A-Za-z0-9_.-]{1,32}$/.test(String(raw))) return name;
  return `${name} ${raw}`;
}

export function readLangfuseConfig(env: EnvLike = process.env): LangfuseConfig {
  const publicKey = nonempty(env.LANGFUSE_PUBLIC_KEY);
  const secretKey = nonempty(env.LANGFUSE_SECRET_KEY);
  let baseUrl = LANGFUSE_DEFAULT_BASE_URL;
  let baseUrlSource: LangfuseConfig["baseUrlSource"] = "default";
  let baseUrlError: string | null = null;

  for (const name of BASE_URL_VARS) {
    const raw = nonempty(env[name]);
    if (!raw) continue;
    const parsed = parseLangfuseBaseUrl(raw);
    if (!parsed) {
      baseUrlError = `${name} must be an https URL (http is only allowed for localhost), so Langfuse tracing stays off.`;
      break;
    }
    baseUrl = parsed;
    baseUrlSource = name;
    break;
  }

  return {
    enabled: Boolean(publicKey && secretKey && !baseUrlError),
    baseUrl,
    baseUrlSource,
    baseUrlError,
    publicKey,
    secretKey,
  };
}

export function isLangfuseEnabled(env: EnvLike = process.env): boolean {
  return readLangfuseConfig(env).enabled;
}

/**
 * `@langfuse/core` rejects a propagated environment that starts with
 * "langfuse" (ENVIRONMENT_VALUE_PATTERN). The lookahead drops those here,
 * before LangfuseSpanProcessor stamps them onto the span.
 */
const TRACE_ENVIRONMENT = /^(?!langfuse)[a-z0-9][a-z0-9_-]{0,39}$/;
const TRACE_RELEASE = /^[A-Za-z0-9._+-]{1,40}$/;

/**
 * Labels stamped on every span. `environment` is `default` when the variable
 * does not match, including a value reserved by the SDK. `release` is `""`
 * when it does not match: the SDK reads `LANGFUSE_RELEASE` whenever the
 * option is omitted, so an empty string is what "omit" has to be.
 */
export function readLangfuseTraceLabels(env: EnvLike = process.env): { environment: string; release: string } {
  const rawEnvironment = typeof env.LANGFUSE_TRACING_ENVIRONMENT === "string" ? env.LANGFUSE_TRACING_ENVIRONMENT.trim() : "";
  const rawRelease = typeof env.LANGFUSE_RELEASE === "string" ? env.LANGFUSE_RELEASE.trim() : "";
  return {
    environment: TRACE_ENVIRONMENT.test(rawEnvironment) ? rawEnvironment : "default",
    release: TRACE_RELEASE.test(rawRelease) ? rawRelease : "",
  };
}

export function langfuseStatusLabel(state: LangfuseConnectionState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "not_configured":
      return "Not configured";
    case "unreachable":
      return "Not connected";
  }
}

/**
 * Export enums, counts, lengths, booleans, and keyed fingerprints.
 * A caller-supplied string is never copied, whatever shape it has.
 * `cost_usd` becomes `cost_bucket`. Repo names are not exported; callers
 * send `repo_count` instead. The export gate runs last, so a key that is
 * not in the schema cannot leave. Returns null when sanitizing throws, so
 * the caller can drop the span.
 */
export function readLangfuseMeta(input: Record<string, unknown> | undefined): Record<string, string | number | boolean> | null {
  try {
    const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const cleaned = sanitizeAttributes(src);
    const draft: Record<string, unknown> = { ...cleaned };
    const bucket = asCostBucket(draft.cost_usd);
    delete draft.cost_usd;
    if (bucket !== undefined) draft.cost_bucket = bucket;
    for (const field of REF_FIELDS) {
      if (!Object.hasOwn(src, field)) continue;
      const desc = Object.getOwnPropertyDescriptor(src, field);
      if (!desc) continue;
      // A throwing getter aborts the span. The message is not copied.
      const raw = desc.get ? desc.get.call(src) : desc.value;
      if (typeof raw !== "string" || raw.length === 0) continue;
      if (field === "tool" && MCP_TOOL_NAMES.has(raw)) continue;
      const ref = keyedRef(field, raw);
      if (ref !== undefined) draft[refKeyFor(field)] = ref;
    }
    return gateLangfuseExport({ metadata: draft }).metadata;
  } catch {
    return null;
  }
}

/** Same as `readLangfuseMeta`, but a failure is an empty record instead of null. */
export function sanitizeLangfuseMeta(input: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  return readLangfuseMeta(input) ?? {};
}

/** Enums, fingerprints, and sizes from an MCP tool call. Bodies and prompts are counted, not copied. */
export function mcpToolMeta(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const src = args as Record<string, unknown>;
  const draft: Record<string, unknown> = {
    agent_id: src.agent_id,
    platform: src.platform,
    machine: src.machine,
    status: src.status,
    session_id: src.session_id,
    project: src.project,
    priority: src.priority,
    reviewer_platform: src.reviewer_platform,
    created_by: src.created_by,
    window: src.window,
    limit: src.limit,
    ack: src.ack,
    id: src.id,
    in_reply_to: src.in_reply_to,
    cost_usd: src.cost_usd,
    tool: src.tool,
  };
  if (typeof src.content === "string") draft.content_chars = src.content.length;
  if (typeof src.body === "string") draft.body_chars = src.body.length;
  if (typeof src.description === "string") draft.description_chars = src.description.length;
  if (typeof src.result === "string") draft.result_chars = src.result.length;
  if (typeof src.title === "string") draft.title_chars = src.title.length;
  if (typeof src.summary === "string") draft.summary_chars = src.summary.length;
  if (typeof src.query === "string") draft.has_query = src.query.length > 0;
  if (typeof src.key === "string") draft.has_key = src.key.length > 0;
  if (Array.isArray(src.tags)) draft.tag_count = src.tags.length;
  return sanitizeLangfuseMeta(draft);
}

export function ingestEventMeta(body: {
  agent_id?: string;
  platform?: string;
  machine?: string;
  kind?: string;
  status?: string;
  project?: string;
  session_id?: string;
  title?: string;
}): Record<string, unknown> {
  return sanitizeLangfuseMeta({
    agent_id: body.agent_id,
    platform: body.platform,
    machine: body.machine,
    kind: body.kind,
    status: body.status,
    project: body.project,
    session_id: body.session_id,
    title_chars: typeof body.title === "string" ? body.title.length : undefined,
  });
}

/** Event kind and how many repos arrived. Repo names stay out of the export. */
export function progressIngestMeta(body: { kind?: unknown; repos?: unknown }): Record<string, unknown> {
  const repos = Array.isArray(body.repos) ? body.repos : [];
  return sanitizeLangfuseMeta({
    kind: body.kind,
    repo_count: repos.length,
  });
}

function missingKeyMessage(env: EnvLike): string | null {
  const hasPublic = Boolean(nonempty(env.LANGFUSE_PUBLIC_KEY));
  const hasSecret = Boolean(nonempty(env.LANGFUSE_SECRET_KEY));
  if (hasPublic !== hasSecret) {
    return "Set both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. Tracing stays off until both are present.";
  }
  return null;
}

/** Settings reloads within this window reuse the last Langfuse probe. */
const STATUS_CACHE_MS = 30_000;

interface StatusCacheEntry {
  key: string;
  expires: number;
  status: LangfuseStatus;
}

let statusCache: StatusCacheEntry | null = null;
let statusInflight: { key: string; promise: Promise<LangfuseStatus> } | null = null;

export function clearLangfuseStatusCacheForTests(): void {
  statusCache = null;
  statusInflight = null;
}

function statusCacheKey(cfg: LangfuseConfig): string {
  return `${cfg.publicKey ?? ""}\n${cfg.baseUrl}`;
}

function statusBase(cfg: LangfuseConfig, extra: Partial<LangfuseStatus>): LangfuseStatus {
  return {
    state: "not_configured",
    configured: cfg.enabled,
    baseUrl: cfg.baseUrl,
    projectName: null,
    projectUrl: null,
    message: null,
    ...extra,
  };
}

/** Read a JSON body up to 64 KB. A larger body, or a body that will not parse, is refused. */
async function readProbeJson(res: Response): Promise<LangfuseProjectsResponse | undefined> {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const raw = declared.trim();
    if (!/^\d+$/.test(raw) || Number(raw) > MAX_PROBE_BYTES) return undefined;
  }
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_PROBE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as LangfuseProjectsResponse;
  } catch {
    return undefined;
  }
}

async function probeLangfuse(cfg: LangfuseConfig, fetchImpl: typeof fetch): Promise<LangfuseStatus> {
  const fallback: LangfuseStatus = statusBase(cfg, {
    state: "unreachable",
    configured: true,
    projectUrl: cfg.baseUrl,
    message: "Could not reach Langfuse. Check the keys and the host, then reload Settings.",
  });

  try {
    const res = await fetchImpl(`${cfg.baseUrl}/api/public/projects`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`, "utf8").toString("base64")}`,
        Accept: "application/json",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok || res.status >= 300) {
      return { ...fallback, message: `Langfuse answered HTTP ${res.status}. Check the keys and the host.` };
    }
    const body = await readProbeJson(res);
    if (!body) return fallback;
    const project = Array.isArray(body?.data)
      ? body.data.find((item) => typeof item?.id === "string" && PROJECT_ID.test(item.id))
      : undefined;
    const projectId = typeof project?.id === "string" ? project.id : null;
    const projectName = typeof project?.name === "string" ? redactText(project.name, 80) : null;
    return statusBase(cfg, {
      state: "connected",
      configured: true,
      projectName,
      projectUrl: projectId ? `${cfg.baseUrl}/project/${projectId}` : cfg.baseUrl,
      message: null,
    });
  } catch {
    return fallback;
  }
}

/**
 * Ask Langfuse which project these keys belong to. The secret never leaves
 * this function. A failure here does not affect tracing; the Settings page
 * just shows that the host could not be reached.
 *
 * The Settings page calls this with no arguments. That path caches the probe
 * for 30 seconds so a reload does not wait on the 3 second timeout again.
 * Callers that pass their own fetch (tests) are not cached.
 */
export async function getLangfuseStatus(env: EnvLike = process.env, fetchImpl?: typeof fetch): Promise<LangfuseStatus> {
  const cfg = readLangfuseConfig(env);
  if (!cfg.enabled || !cfg.publicKey || !cfg.secretKey) {
    return statusBase(cfg, {
      state: "not_configured",
      configured: false,
      message: cfg.baseUrlError ?? missingKeyMessage(env),
    });
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (fetchImpl !== undefined) return probeLangfuse(cfg, doFetch);

  const key = statusCacheKey(cfg);
  if (statusCache && statusCache.key === key && statusCache.expires > Date.now()) return statusCache.status;
  if (statusInflight && statusInflight.key === key) return statusInflight.promise;

  const promise = probeLangfuse(cfg, doFetch)
    .then((status) => {
      statusCache = { key, expires: Date.now() + STATUS_CACHE_MS, status };
      return status;
    })
    .finally(() => {
      if (statusInflight?.promise === promise) statusInflight = null;
    });
  statusInflight = { key, promise };
  return promise;
}
