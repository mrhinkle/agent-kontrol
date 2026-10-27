/**
 * A database call can commit and still fail in the client: the server
 * commits, then the connection dies before RETURNING arrives. The caller
 * cannot tell a rolled-back statement from one that landed. Releasing an
 * idempotency claim on that error lets the same key insert a second row.
 */

export class UnknownWriteOutcome extends Error {
  constructor(cause?: unknown) {
    const message = cause instanceof Error
      ? cause.message
      : "The database connection failed after the statement may have committed.";
    super(message);
    this.name = "UnknownWriteOutcome";
    if (cause !== undefined) this.cause = cause;
  }
}

const CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
]);

export function isUnknownWriteOutcome(err: unknown): boolean {
  return err instanceof UnknownWriteOutcome
    || (err instanceof Error && err.name === "UnknownWriteOutcome");
}

/** Connection loss after a statement was sent. A SQLSTATE from the server is a definite rejection. */
export function looksLikeConnectionLoss(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof record.code === "string" && CONNECTION_CODES.has(record.code)) return true;
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  if (
    message.includes("connection terminated")
    || message.includes("connection timeout")
    || message.includes("timeout exceeded when trying to connect")
    || message.includes("socket hang up")
    || message.includes("fetch failed")
    || message.includes("client has encountered a connection error")
    || message.includes("the operation was aborted")
    || message.includes("connection closed")
  ) {
    return true;
  }
  if (record.cause && record.cause !== err) return looksLikeConnectionLoss(record.cause);
  return false;
}

/** The same error when it is already classified, or a new one when the cause is a connection loss. */
export function asUnknownWriteOutcome(err: unknown): UnknownWriteOutcome | null {
  if (err instanceof UnknownWriteOutcome) return err;
  if (isUnknownWriteOutcome(err)) return new UnknownWriteOutcome(err);
  if (looksLikeConnectionLoss(err)) return new UnknownWriteOutcome(err);
  return null;
}
