/**
 * Optional Langfuse connection. Tracing is off unless both API keys are set,
 * so a deploy with no Langfuse variables behaves exactly as before.
 *
 * The host is LANGFUSE_BASEURL, then LANGFUSE_HOST, then LANGFUSE_BASE_URL
 * (the name current Langfuse docs use). The default is Langfuse Cloud (EU).
 */
import { redactText, sanitizeAttributes } from "@/lib/traces";

export const LANGFUSE_DEFAULT_BASE_URL = "https://cloud.langfuse.com";

const BASE_URL_VARS = ["LANGFUSE_BASEURL", "LANGFUSE_HOST", "LANGFUSE_BASE_URL"] as const;
export type LangfuseBaseUrlVar = (typeof BASE_URL_VARS)[number];

/** Langfuse drops propagated metadata once its JSON encoding exceeds 200 characters. */
const MAX_META_STRING = 160;

/**
 * Free-text fields. Call sites pass lengths instead. Dropped here as well so a
 * future caller cannot put a prompt or a message body on a span by accident.
 */
const FREE_TEXT_KEY = /^(content|body|description|result|summary|query|title|detail|prompt|input|output|message|messages|note|notes|instructions)$/i;

const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Fields safe to copy off an MCP tool call. Bodies, prompts and notes are not. */
const MCP_SAFE_FIELDS = [
  "agent_id",
  "platform",
  "machine",
  "status",
  "session_id",
  "project",
  "priority",
  "reviewer_platform",
  "created_by",
  "window",
  "limit",
  "ack",
  "id",
  "in_reply_to",
  "cost_usd",
] as const;

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

/** Accept an http(s) origin or path prefix. Reject credentials, queries and hashes. */
export function parseLangfuseBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
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
      baseUrlError = `${name} is not a usable http(s) URL, so Langfuse tracing stays off.`;
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

/** Drop secret-looking keys and content, redact credential-shaped text, cap length. */
export function sanitizeLangfuseMeta(input: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const cleaned = sanitizeAttributes(input ?? {});
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(cleaned)) {
    if (FREE_TEXT_KEY.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, MAX_META_STRING);
    else out[key] = value;
  }
  return out;
}

/** Ids and sizes from an MCP tool call. Message bodies, notes and prompts are counted, not copied. */
export function mcpToolMeta(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const src = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of MCP_SAFE_FIELDS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  if (typeof src.content === "string") out.content_chars = src.content.length;
  if (typeof src.body === "string") out.body_chars = src.body.length;
  if (typeof src.description === "string") out.description_chars = src.description.length;
  if (typeof src.result === "string") out.result_chars = src.result.length;
  if (typeof src.title === "string") out.title_chars = src.title.length;
  if (typeof src.summary === "string") out.summary_chars = src.summary.length;
  if (typeof src.query === "string") out.has_query = src.query.length > 0;
  if (typeof src.key === "string") out.has_key = src.key.length > 0;
  if (Array.isArray(src.tags)) out.tag_count = src.tags.length;
  return out;
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
  return {
    agent_id: body.agent_id,
    platform: body.platform,
    machine: body.machine,
    kind: body.kind,
    status: body.status,
    project: body.project,
    session_id: body.session_id,
    title_chars: typeof body.title === "string" ? body.title.length : undefined,
  };
}

function missingKeyMessage(env: EnvLike): string | null {
  const hasPublic = Boolean(nonempty(env.LANGFUSE_PUBLIC_KEY));
  const hasSecret = Boolean(nonempty(env.LANGFUSE_SECRET_KEY));
  if (hasPublic !== hasSecret) {
    return "Set both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. Tracing stays off until both are present.";
  }
  return null;
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

/**
 * Ask Langfuse which project these keys belong to. The secret never leaves
 * this function. A failure here does not affect tracing; the Settings page
 * just shows that the host could not be reached.
 */
export async function getLangfuseStatus(
  env: EnvLike = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LangfuseStatus> {
  const cfg = readLangfuseConfig(env);
  if (!cfg.enabled || !cfg.publicKey || !cfg.secretKey) {
    return statusBase(cfg, {
      state: "not_configured",
      configured: false,
      message: cfg.baseUrlError ?? missingKeyMessage(env),
    });
  }

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
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { ...fallback, message: `Langfuse answered HTTP ${res.status}. Check the keys and the host.` };
    }
    const body = (await res.json()) as LangfuseProjectsResponse;
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
