import { apiError, type ErrorCode } from "./api-error";

const STREAM_FAILURES: Record<string, { code: ErrorCode; fix: string; retryable?: boolean }> = {
  unauthorized: {
    code: "unauthorized",
    fix: "Send Authorization: Bearer with an akc_ credential that has events:read. A query-string key is not accepted.",
  },
  consumer_forbidden: {
    code: "forbidden",
    fix: "Use the akc_ credential registered for this consumer. MC_TOKEN and the dashboard cannot read the inbox stream.",
  },
  stream_not_configured: {
    code: "setup_required",
    fix: "Set DATABASE_URL, apply the event stream schema, and retry.",
  },
  invalid_json: {
    code: "invalid_json",
    fix: "Send one JSON object as the body.",
  },
  too_large: {
    code: "payload_too_large",
    fix: "Send a registration body of at most 16 KiB.",
  },
  unreadable: {
    code: "invalid_json",
    fix: "Send a readable UTF-8 body and retry.",
  },
  invalid_consumer: {
    code: "validation_failed",
    fix: "Send one consumer id with repos and event_types that match the registration rules.",
  },
  invalid_cursor: {
    code: "validation_failed",
    fix: "Send a cursor for this consumer, or omit since and Last-Event-ID to start at the beginning.",
  },
  cursor_conflict: {
    code: "validation_failed",
    fix: "Send the same cursor in since and Last-Event-ID, or send only one of them.",
  },
  foreign_cursor: {
    code: "forbidden",
    fix: "Use a cursor that belongs to this consumer.",
  },
  credential_not_eligible: {
    code: "validation_failed",
    fix: "Register a credential that is active and has the events:read scope.",
  },
  credential_already_bound: {
    code: "conflict",
    fix: "Use the consumer already bound to that credential, or bind a different credential.",
  },
  superseded: {
    code: "conflict",
    fix: "Reconnect. A newer stream for this consumer replaced this one.",
    retryable: true,
  },
  event_too_large: {
    code: "payload_too_large",
    fix: "The next inbox event is larger than one stream frame. Reconcile that delivery outside this stream.",
  },
  stream_unavailable: {
    code: "internal_error",
    fix: "Retry the stream. The event store did not answer.",
    retryable: true,
  },
};

/** HTTP failure before a stream starts. `error` stays the stream token. */
export function streamFailure(error: string, status: number): Response {
  const known = STREAM_FAILURES[error];
  if (known) {
    return apiError(known.code, {
      message: error,
      status,
      fix: known.fix,
      retryable: known.retryable,
    });
  }
  return apiError(status >= 500 ? "internal_error" : "validation_failed", {
    message: error,
    status,
    retryable: status >= 500,
    fix: "Correct the stream request and send it again. Retry only when retryable is true.",
  });
}
