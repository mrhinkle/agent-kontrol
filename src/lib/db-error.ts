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

// One rule for every unquoted secret: it runs to the next whitespace, whatever
// characters it holds (parentheses, quotes, commas, `@`, `/`, a final `!`).
// Stopping at, or giving back, any other character can leave part of the
// secret behind. The price is cosmetic: "…/db, retrying" loses its comma.
const TO_WHITESPACE = String.raw`\S+`;
// A URL. A `?password=…` key inside it goes with it, so it is never cut off
// from its value.
const URL_LIKE = new RegExp(String.raw`\b[a-z][a-z0-9+.-]*:\/\/\S*`, "gi");
// `user:password@host` without a scheme. The password runs to the last `@`
// of its token, so it may hold `@`, `/` and quotes, whatever follows it.
const USERINFO = /[^\s:/@"'=]+:\S*@/g;
// A quoted value: `"…"` or `'…'`, opened by a bare or backslash-escaped quote
// (JSON inside JSON), with any backslash escape inside it (`\"`, `\\`, a
// backslash before a line break). With no closing quote (cut off by MAX_INPUT)
// it runs to the end. The two branches inside cannot match the same
// character, so matching stays linear.
const QUOTED_VALUE = String.raw`\\?"(?:[^"\\]|\\[\s\S])*"?|\\?'(?:[^'\\]|\\[\s\S])*'?`;
// A key, optionally quoted (`"password":`, `\"password\":`), then `=` or `:`.
const KEY_TAIL = String.raw`(\\?["']?)\s*[=:]\s*`;
// `password=…`, `PGPASSWORD=…`, `db_password: …`, `{"password":"…"}`.
const PASSWORD_PAIR = new RegExp(String.raw`(password|passwd|pwd)${KEY_TAIL}(${QUOTED_VALUE}|${TO_WHITESPACE})`, "gi");
// `Authorization: Basic …`, `Bearer …` or any other scheme, quoted or not.
const AUTHORIZATION_PAIR = new RegExp(
  String.raw`(authorization)${KEY_TAIL}(${QUOTED_VALUE}|[A-Za-z]+\s+${TO_WHITESPACE}|${TO_WHITESPACE})`,
  "gi",
);
const NEON_PASSWORD = /npg_\S*/g;
const BEARER = new RegExp(String.raw`\bBearer\s+${TO_WHITESPACE}`, "gi");
const AGENT_CREDENTIAL = /akc_\S*/g;
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
    .replace(AUTHORIZATION_PAIR, "$1$2=[redacted]")
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
