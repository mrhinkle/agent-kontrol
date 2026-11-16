import { API_ERRORS, apiError, type ErrorCode } from "./api-error";

export interface StreamControlBody {
  code: string;
  cause: string;
  fix: string;
  retryable: boolean;
}

const STREAM_FAILURES: Record<string, { code: ErrorCode; cause: string; fix: string; retryable?: boolean }> = {
  unauthorized: {
    code: "unauthorized",
    cause: "The stream request had no usable bearer credential.",
    fix: "Send Authorization: Bearer with an akc_ credential that has events:read. A query-string key is not accepted.",
  },
  consumer_forbidden: {
    code: "forbidden",
    cause: "This caller is not the agent credential bound to the consumer.",
    fix: "Use the akc_ credential registered for this consumer. MC_TOKEN and the dashboard cannot read the inbox stream.",
  },
  stream_not_configured: {
    code: "setup_required",
    cause: "The event stream store is not set up.",
    fix: "Set DATABASE_URL, apply the event stream schema, and retry.",
  },
  invalid_json: {
    code: "invalid_json",
    cause: "The registration body was not one JSON object.",
    fix: "Send one JSON object as the body.",
  },
  too_large: {
    code: "payload_too_large",
    cause: "The registration body is larger than 16 KiB.",
    fix: "Send a registration body of at most 16 KiB.",
  },
  unreadable: {
    code: "invalid_json",
    cause: "The request body could not be read as UTF-8.",
    fix: "Send a readable UTF-8 body and retry.",
  },
  invalid_consumer: {
    code: "validation_failed",
    cause: "The consumer registration did not match the registration rules.",
    fix: "Send one consumer id with repos and event_types that match the registration rules.",
  },
  invalid_cursor: {
    code: "validation_failed",
    cause: "The cursor is not a readable position for this consumer.",
    fix: "Send a cursor for this consumer, or omit since and Last-Event-ID to start at the beginning.",
  },
  cursor_conflict: {
    code: "validation_failed",
    cause: "since and Last-Event-ID named different cursors.",
    fix: "Send the same cursor in since and Last-Event-ID, or send only one of them.",
  },
  foreign_cursor: {
    code: "forbidden",
    cause: "The cursor belongs to another consumer.",
    fix: "Use a cursor that belongs to this consumer.",
  },
  credential_not_eligible: {
    code: "validation_failed",
    cause: "The credential is not an active events:read credential.",
    fix: "Register a credential that is active and has the events:read scope.",
  },
  credential_already_bound: {
    code: "conflict",
    cause: "That credential is already bound to a consumer.",
    fix: "Use the consumer already bound to that credential, or bind a different credential.",
  },
  superseded: {
    code: "conflict",
    cause: "A newer stream for this consumer replaced this connection.",
    fix: "Reconcile from your last cursor. Reconnect only after the newer stream is gone. Reconnecting immediately makes the two consumers replace each other.",
    retryable: true,
  },
  event_too_large: {
    code: "payload_too_large",
    cause: "The next inbox event is larger than one stream frame.",
    fix: "The next inbox event is larger than one stream frame. Reconcile that delivery outside this stream.",
  },
  stream_unavailable: {
    code: "internal_error",
    cause: "The event store did not answer.",
    fix: "Retry the stream a bounded number of times. The event store did not answer.",
    retryable: true,
  },
};

const CURSOR_EXPIRED: StreamControlBody = {
  code: "cursor_expired",
  cause: "The cursor is older than the retained inbox.",
  fix: "Reconcile from the retained inbox. Reconnect with a retained cursor, or omit the cursor to start from the retained beginning. The same cursor will expire again.",
  retryable: false,
};

const FALLBACK_FIX = "Correct the stream request and send it again. Retry only when retryable is true.";

/** Teaching fields shared by an HTTP stream failure and a terminal SSE control frame. */
export function streamControlBody(token: string, status = 500): StreamControlBody {
  if (token === "cursor_expired") return CURSOR_EXPIRED;
  const known = STREAM_FAILURES[token];
  if (known) {
    return {
      code: known.code,
      cause: known.cause,
      fix: known.fix,
      retryable: known.retryable ?? API_ERRORS[known.code].retryable,
    };
  }
  const retryable = status >= 500;
  return {
    code: retryable ? "internal_error" : "validation_failed",
    cause: "The stream request could not be completed.",
    fix: FALLBACK_FIX,
    retryable,
  };
}

/** HTTP failure before a stream starts. `error` stays the stream token. */
export function streamFailure(error: string, status: number): Response {
  const teaching = streamControlBody(error, status);
  const code = (teaching.code === "cursor_expired" ? "validation_failed" : teaching.code) as ErrorCode;
  return apiError(code, {
    message: error,
    status,
    fix: teaching.fix,
    retryable: teaching.retryable,
    extra: { cause: teaching.cause },
  });
}
