import { NextResponse } from "next/server";

/**
 * Machine-readable errors for REST and MCP.
 *
 * The `error` field stays a string. `code`, `fix`, and `retryable` are added
 * beside it. A 500 logs the exception and returns `internal_error` with a
 * generic message: the exception text is not a client field.
 *
 * `task_not_claimable` is part of the catalogue so a caller can handle it.
 * No route returns it. An empty claim is a successful empty result.
 */
export const API_ERRORS = {
  unauthorized: {
    status: 401,
    message: "unauthorized",
    fix: "Send Authorization: Bearer with a valid MC_TOKEN, or sign in to the dashboard.",
    retryable: false,
  },
  forbidden: {
    status: 403,
    message: "forbidden",
    fix: "This caller cannot perform that action. Use a resource that belongs to this agent.",
    retryable: false,
  },
  trusted_writer_required: {
    status: 403,
    message: "This write needs the MC_TOKEN bearer or the signed-in dashboard.",
    fix: "Send Authorization: Bearer <MC_TOKEN>, or sign in to the dashboard where that route allows it. Agent credentials, OAuth tokens, and an open dashboard cannot write sweeper evidence.",
    retryable: false,
  },
  identity_mismatch: {
    status: 403,
    message: "agent_id does not match the authenticated caller",
    fix: "Omit agent_id, or pass the authenticated id.",
    retryable: false,
  },
  not_found: {
    status: 404,
    message: "not found",
    fix: "Check the id. It may be wrong, or the record may have been removed.",
    retryable: false,
  },
  validation_failed: {
    status: 400,
    message: "validation failed",
    fix: "Correct the fields listed in fields and send the request again.",
    retryable: false,
  },
  invalid_json: {
    status: 400,
    message: "invalid JSON",
    fix: "Send a JSON object with Content-Type: application/json.",
    retryable: false,
  },
  missing_field: {
    status: 400,
    message: "a required field is missing",
    fix: "Add the fields listed in fields and send the request again.",
    retryable: false,
  },
  rate_limited: {
    status: 429,
    message: "too many attempts",
    fix: "Wait for the number of seconds in the Retry-After header, then try again.",
    retryable: true,
  },
  conflict: {
    status: 409,
    message: "conflict",
    fix: "Reload the current state and retry the change.",
    retryable: false,
  },
  idempotency_conflict: {
    status: 409,
    message: "idempotency conflict",
    fix: "Send the same arguments with this key, or use a new key.",
    retryable: false,
  },
  stale: {
    status: 409,
    message: "The list changed since you loaded it. Reload to see the latest, then make your change again.",
    fix: "GET the list again and send that version with your change.",
    retryable: false,
  },
  writeback_in_progress: {
    status: 409,
    message: "A write-back is in progress for this decision.",
    fix: "Wait for the write-back to finish, then reload. The claim expires after 180 seconds.",
    retryable: true,
  },
  stale_write: {
    status: 409,
    message: "stale_write",
    fix: "Preview the write again and send the expected_revision from that preview.",
    retryable: false,
  },
  task_not_found: {
    status: 404,
    message: "Task not found",
    fix: "Check the task id. The task may have been removed.",
    retryable: false,
  },
  task_not_claimable: {
    status: 409,
    message: "Task is not claimable.",
    fix: "Claim only a queued task routed to your platform. If the queue is empty, wait for new work.",
    retryable: false,
  },
  memory_key_invalid: {
    status: 400,
    message: "Memory key is invalid.",
    fix: "Use a key of 1 to 200 characters with no control characters, or omit the key.",
    retryable: false,
  },
  repo_list_invalid: {
    status: 400,
    message: "The repo list is invalid.",
    fix: "Fix the rows listed in errors and fields, then send the list again.",
    retryable: false,
  },
  payload_too_large: {
    status: 413,
    message: "request too large",
    fix: "Send a smaller body. Trace export accepts at most 2 MB.",
    retryable: false,
  },
  unsupported_media_type: {
    status: 415,
    message: "unsupported media type",
    fix: "Set Content-Type: application/json.",
    retryable: false,
  },
  setup_required: {
    status: 503,
    message: "This feature is not set up yet.",
    fix: "Finish the setup step named in error, then retry.",
    retryable: false,
  },
  not_configured: {
    status: 503,
    message: "not configured",
    fix: "Set MC_GITHUB_WEBHOOK_SECRET to the GitHub webhook secret, redeploy, then redeliver.",
    retryable: false,
  },
  internal_error: {
    status: 500,
    message: "Internal error.",
    fix: "Retry the request. If it keeps failing, check the server logs.",
    retryable: true,
  },
} as const;

export type ErrorCode = keyof typeof API_ERRORS;

export interface ApiErrorBody {
  error: string;
  code: ErrorCode;
  fix: string;
  retryable: boolean;
  fields?: Record<string, string>;
}

export interface ApiErrorOverrides {
  message?: string;
  status?: number;
  fix?: string;
  retryable?: boolean;
  fields?: Record<string, string>;
  headers?: HeadersInit;
  /** Extra keys already returned by a route. Cannot replace error, code, fix, retryable, or fields. */
  extra?: Record<string, unknown>;
}

const RESERVED = new Set(["error", "code", "fix", "retryable", "fields"]);

export function errorBody(code: ErrorCode, overrides?: ApiErrorOverrides): ApiErrorBody & Record<string, unknown> {
  const spec = API_ERRORS[code];
  const body: ApiErrorBody & Record<string, unknown> = {
    error: overrides?.message ?? spec.message,
    code,
    fix: overrides?.fix ?? spec.fix,
    retryable: overrides?.retryable ?? spec.retryable,
  };
  if (overrides?.fields && Object.keys(overrides.fields).length > 0) body.fields = overrides.fields;
  if (overrides?.extra) {
    for (const [key, value] of Object.entries(overrides.extra)) {
      if (RESERVED.has(key)) continue;
      body[key] = value;
    }
  }
  return body;
}

/** REST error. `error` is always a string. Status comes from the catalogue unless overridden. */
export function apiError(code: ErrorCode, overrides?: ApiErrorOverrides): NextResponse {
  const status = overrides?.status ?? API_ERRORS[code].status;
  return NextResponse.json(errorBody(code, overrides), {
    status,
    headers: overrides?.headers,
  });
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
  [key: string]: unknown;
}

/** MCP tool failure. `isError` text is the JSON of the same keys as a REST error body. */
export function mcpToolError(code: ErrorCode, overrides?: ApiErrorOverrides): McpToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(errorBody(code, overrides)) }],
  };
}

const MEMORY_KEY_MAX = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Reject an empty key, a key over 200 characters, or a key with control
 * characters. `undefined` means "no key" and is valid. A bad key must not
 * look like a successful empty recall.
 */
export function memoryKeyError(key: string | undefined): McpToolResult | null {
  if (key === undefined) return null;
  if (key.length >= 1 && key.length <= MEMORY_KEY_MAX && !CONTROL_CHARS.test(key)) return null;
  return mcpToolError("memory_key_invalid", {
    fields: { key: "Use 1 to 200 characters and no control characters, or omit the key." },
  });
}

interface SafeCaught {
  code: ErrorCode;
  message: string;
  fields?: Record<string, string>;
  retryable?: boolean;
  fix?: string;
  headers?: HeadersInit;
  extra?: Record<string, unknown>;
}

/**
 * Only messages this server authored, matched in full. A database error that
 * happens to contain one of these phrases must fall through to internal_error
 * so the original text is not returned.
 */
/**
 * Match by name. api-error is imported by middleware, which cannot load
 * node:crypto, so this file does not import the idempotency module.
 */
function namedError(err: unknown, name: string): (Error & {
  fields?: Record<string, string>;
  retryable?: boolean;
  retryAfterSec?: number | null;
}) | null {
  if (!(err instanceof Error) || err.name !== name) return null;
  return err as Error & {
    fields?: Record<string, string>;
    retryable?: boolean;
    retryAfterSec?: number | null;
  };
}

function safeCaught(err: unknown): SafeCaught | null {
  const unknownOutcome = namedError(err, "IdempotencyUnknownOutcome");
  if (unknownOutcome) {
    return {
      code: "idempotency_conflict",
      message: unknownOutcome.message,
      fields: unknownOutcome.fields ?? { idempotency_key: unknownOutcome.message },
      retryable: true,
      fix: "Retry the same idempotency key and the same arguments. Within 24 hours of the claim, that retry does not insert another row. The key is scoped to the actor and the route.",
    };
  }
  const conflict = namedError(err, "IdempotencyConflict");
  if (conflict) {
    const retryable = conflict.retryable === true;
    const retryAfter = typeof conflict.retryAfterSec === "number" && conflict.retryAfterSec >= 1
      ? Math.ceil(conflict.retryAfterSec)
      : null;
    return {
      code: "idempotency_conflict",
      message: conflict.message,
      fields: conflict.fields ?? { idempotency_key: conflict.message },
      retryable,
      ...(retryable
        ? {
            fix: "Wait the number of seconds in Retry-After, then send the same key and the same arguments. The key is scoped to the actor and the route.",
            headers: retryAfter != null ? { "Retry-After": String(retryAfter) } : undefined,
            extra: retryAfter != null ? { retry_after: retryAfter } : undefined,
          }
        : {}),
    };
  }
  const invalidKey = namedError(err, "IdempotencyKeyInvalid");
  if (invalidKey) {
    return {
      code: "validation_failed",
      message: invalidKey.message,
      fields: invalidKey.fields ?? { idempotency_key: invalidKey.message },
    };
  }
  if (err instanceof Error && err.name === "StaleWrite") {
    const current = (err as Error & { currentRevision?: unknown }).currentRevision;
    return {
      code: "stale_write",
      message: "stale_write",
      extra: { current_revision: typeof current === "string" ? current : "" },
    };
  }
  const msg = err instanceof Error ? err.message : "";
  if (msg === "Task not found") return { code: "task_not_found", message: msg };
  if (msg === "Memory not found") return { code: "not_found", message: "not found" };
  if (msg === "in_reply_to belongs to a different agent") {
    return { code: "forbidden", message: msg, fields: { in_reply_to: msg } };
  }
  if (/^in_reply_to \d+ not found$/.test(msg)) {
    return { code: "not_found", message: msg, fields: { in_reply_to: msg } };
  }
  if (msg.startsWith("privacy: refusing ")) {
    return { code: "validation_failed", message: msg, fields: { detail: msg } };
  }
  return null;
}

export function publicError(logLabel: string, err: unknown, fallbackMessage?: string): NextResponse {
  console.error(logLabel, err);
  const safe = safeCaught(err);
  if (safe) {
    return apiError(safe.code, {
      message: safe.message,
      fields: safe.fields,
      retryable: safe.retryable,
      fix: safe.fix,
      headers: safe.headers,
      extra: safe.extra,
    });
  }
  return apiError("internal_error", fallbackMessage ? { message: fallbackMessage } : undefined);
}

export function toolResultFromCaught(logLabel: string, err: unknown): McpToolResult {
  console.error(logLabel, err);
  const safe = safeCaught(err);
  if (safe) {
    return mcpToolError(safe.code, {
      message: safe.message,
      fields: safe.fields,
      retryable: safe.retryable,
      fix: safe.fix,
      extra: safe.extra,
    });
  }
  return mcpToolError("internal_error");
}
