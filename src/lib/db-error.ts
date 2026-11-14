import { redactText } from "./traces";

/**
 * One log line for a database error, safe to send to the platform's logs.
 *
 * Logged: the error name, the Postgres SQLSTATE or driver error code (`code`),
 * and the message with connection URLs, `user:password@` pairs, `password=`
 * pairs, Neon passwords (`npg_…`), bearer tokens, agent credentials (`akc_…`)
 * and other obvious secrets replaced, collapsed to one line and capped. The
 * `cause` and the Neon driver's `sourceError` are followed a few levels, so a
 * wrapped connection failure still shows the driver's code.
 *
 * Not logged: `detail`, `hint`, `where`, the query, its parameters, the
 * request, or `DATABASE_URL`. Postgres puts row values in `detail`.
 */

const MAX_MESSAGE = 300;
/** The patterns below run on at most this much text, so a huge message cannot make them slow. */
const MAX_INPUT = 2000;
const MAX_DEPTH = 3;

// A URL with optional `user:password@`. The credentials may hold any character
// but whitespace and `@` (parentheses, quotes, `/`). The rest ends on a
// character that is not sentence punctuation, so "…/db, retrying" keeps its comma.
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s@]*@)?[^\s"'<>()[\]{}]*[^\s"'<>()[\]{}.,;:!?]/gi;
// `user:password@host` without a scheme. The password may hold `/` and quotes.
const USERINFO = /[^\s:/@"'=]+:[^\s@]+@(?=[A-Za-z0-9[])/g;
// `password=…`, `PGPASSWORD=…`, `db_password: …`, `"password":"…"`. A quoted
// value with no closing quote (cut off by MAX_INPUT) is redacted to the end.
const PASSWORD_PAIR = /(password|passwd|pwd)(["']?)\s*[=:]\s*("[^"]*"?|'[^']*'?|[^\s,;&]+)/gi;
const NEON_PASSWORD = /npg_[A-Za-z0-9]+/g;
const BEARER = /\bBearer\s+[^\s"',;]+/gi;
const AGENT_CREDENTIAL = /akc_[A-Za-z0-9_-]+/g;
const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

/** Removes secrets and URLs from an error message and caps its length. */
export function sanitizeErrorMessage(message: string, max: number = MAX_MESSAGE): string {
  // A cut can leave half a secret that no pattern recognizes, so a cut message
  // also loses its last, partial token.
  const bounded = message.length > MAX_INPUT ? `${message.slice(0, MAX_INPUT).replace(/\S*$/, "")}…` : message;
  const cleaned = bounded
    .replace(URL_LIKE, "[url]")
    .replace(USERINFO, "[redacted]@")
    .replace(PASSWORD_PAIR, "$1$2=[redacted]")
    .replace(NEON_PASSWORD, "[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(AGENT_CREDENTIAL, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  const scrubbed = redactText(cleaned, Number.MAX_SAFE_INTEGER);
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}

/** A name or code is logged only when it is a short identifier that no secret pattern touches. */
function isSafeIdentifier(value: string): boolean {
  return SAFE_CODE.test(value) && sanitizeErrorMessage(value) === value;
}

function describeOne(err: unknown, previousMessage: string | null): { text: string; message: string | null } {
  if (!err || typeof err !== "object") {
    const message = err === undefined || err === null ? null : sanitizeErrorMessage(String(err));
    return { text: message ? `error message=${JSON.stringify(message)}` : "error", message };
  }
  const record = err as { name?: unknown; code?: unknown; message?: unknown };
  const name = err instanceof Error && isSafeIdentifier(err.name) ? err.name : "error";
  const rawCode = typeof record.code === "string" || typeof record.code === "number" ? String(record.code) : "";
  const code = isSafeIdentifier(rawCode) ? rawCode : null;
  const message = typeof record.message === "string" && record.message ? sanitizeErrorMessage(record.message) : null;
  let text = name;
  if (code) text += ` code=${code}`;
  if (message && message !== previousMessage) text += ` message=${JSON.stringify(message)}`;
  return { text, message };
}

function nextInChain(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  const record = err as { cause?: unknown; sourceError?: unknown };
  return record.cause ?? record.sourceError;
}

/** `Name code=SQLSTATE message="…"`, then ` caused by …` for each wrapped error. */
export function describeDbError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  let previousMessage: string | null = null;
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current);
    const one = describeOne(current, previousMessage);
    parts.push(one.text);
    previousMessage = one.message;
    current = nextInChain(current);
  }
  return parts.length > 0 ? parts.join(" caused by ") : "error";
}
