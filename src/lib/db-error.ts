import { redactText } from "./traces";

/**
 * One log line for a database error, safe to send to the platform's logs.
 *
 * Logged: the error name, the Postgres SQLSTATE or driver error code (`code`),
 * and the message with connection URLs, `user:password@` pairs, `password=`
 * pairs, Neon passwords (`npg_…`), bearer tokens, agent credentials (`akc_…`)
 * and other obvious secrets replaced (a key spelled with JSON `\uXXXX` escapes
 * counts as its plain spelling), collapsed to one line and capped. The
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
// A URL, credentials and query included, through the next whitespace.
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
// `password=…`, `PGPASSWORD=…`, `db_password: …`, `{"password":"…"}`, and the
// other secret-looking keys that `SECRET_KEY` in ./traces.ts already drops
// from span attributes (token, secret, api key, credential, private key).
const SECRET_KEYS = String.raw`password|passwd|pwd|secret|token|api[._-]?key|credential|private[._-]?key`;
// `Authorization: …` (any scheme, including Digest's comma-separated
// parameters) and `Cookie: …` (`a=1; b=2`).
const HEADER_KEYS = String.raw`authorization|cookie`;
// Any of those keys with a quoted value.
const QUOTED_PAIR = new RegExp(String.raw`(${SECRET_KEYS}|${HEADER_KEYS})${KEY_TAIL}(${QUOTED_VALUE})`, "gi");
// Stands in for a value already redacted, so the later passes leave it (and
// the `}` or `,` after it) alone. Removed from the input first, so no message
// can forge it.
const DONE = "\uE000";
const NOT_DONE = String.raw`(?!\uE000)`;
// Under a quoted key (JSON, a Python dict) any text value is quoted, so a bare
// value is a literal: `null`, `true`, `None`, a number. It ends early only
// where the next real field (`,"message":`, or `,"password"=` once an earlier
// pass has redacted it) or the closing `}` or `]` follows,
// which keeps the fields after it readable
// (`{"token":null,"message":"password authentication failed"}`).
const LITERAL = String.raw`(?:null|true|false|none|-?\d[\d.e+-]*)(?=\s*(?:[}\]]|$|,\s*\\?["'][^"'\\\s]*\\?["']\s*[:=]))`;
const LITERAL_PAIR = new RegExp(String.raw`(${SECRET_KEYS}|${HEADER_KEYS})(\\?["'])\s*[=:]\s*${LITERAL}`, "gi");
// A literal under a quoted key that runs straight on into more text, or into a
// comma that does not start a real next field (`{"password":123,abc def}`,
// `{'pwd': None, abc}`), is not valid JSON or Python, so where the value ends
// is unknown: it is redacted to the end of its line. Any other bare value
// (`near "token": unexpected character`) is left to SECRET_WORD.
const LITERAL_START = String.raw`(?:(?:null|true|false|none)\b|-?\d[\d.e+-]*(?![\d.e+-]))(?=\s*,|[^\s,}\]])`;
const MALFORMED_LITERAL = new RegExp(
  String.raw`(${SECRET_KEYS}|${HEADER_KEYS})(\\?["'])\s*[=:]\s*${LITERAL_START}[^\r\n]*`,
  "gi",
);
// An object or array under a secret or header key (`{"token":{"access":"…"}}`,
// `{ token: [ '…' ] }`, pretty-printed over several lines) has no end a pattern
// can find without parsing, so it is redacted to the end of the message.
const NESTED_PAIR = new RegExp(String.raw`(${SECRET_KEYS}|${HEADER_KEYS})${KEY_TAIL}[{[][\s\S]*`, "gi");
// A header value holds spaces and commas, so an unquoted one runs to the end of its line.
const HEADER_LINE = new RegExp(String.raw`(${HEADER_KEYS})${KEY_TAIL}${NOT_DONE}([^\r\n]+)`, "gi");
// A secret key with any other unquoted value, which runs to the next whitespace.
const SECRET_WORD = new RegExp(String.raw`(${SECRET_KEYS})${KEY_TAIL}${NOT_DONE}(${TO_WHITESPACE})`, "gi");
const NEON_PASSWORD = /npg_\S*/g;
const BEARER = new RegExp(String.raw`\bBearer\s+${TO_WHITESPACE}`, "gi");
const AGENT_CREDENTIAL = /akc_\S*/g;
const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;
// A JSON `\uXXXX` escape is decoded first, anywhere in the message, so a key
// spelled with one (`pass\u0077ord`, or `pass\\u0077ord` in JSON inside JSON)
// is redacted as if it had been written without it. In other text the decode
// only changes how the log line reads. Only a character that can sit in a key or a token
// prefix (a letter, a digit, `_`, `.`, `-`) is decoded. Decoding a quote, a
// backslash or a space would move where a value ends, valid JSON never escapes
// its structural `:` `,` `}` `]`, and the marker U+E000 stays unforgeable. The
// backslashes before the `u` go with it; the lookbehind starts a match only at
// the first of them, so matching stays linear.
const KEY_ESCAPE = /(?<!\\)\\+u([0-9a-fA-F]{4})/g;
const KEY_CHAR = /^[A-Za-z0-9_.-]$/;

function decodeKeyEscapes(text: string): string {
  return text.replace(KEY_ESCAPE, (escape: string, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return KEY_CHAR.test(char) ? char : escape;
  });
}

/** Removes secrets and URLs from an error message and caps its length. */
export function sanitizeErrorMessage(message: string, max: number = MAX_MESSAGE): string {
  // A cut can leave half a secret that no pattern recognizes, so a cut message
  // also loses its last, partial token.
  const unmarked = message.replaceAll(DONE, "");
  const bounded = unmarked.length > MAX_INPUT ? `${unmarked.slice(0, MAX_INPUT).replace(/\S*$/, "")}…` : unmarked;
  // The order matters. A pattern that runs to the next whitespace (SECRET_WORD,
  // URL_LIKE, USERINFO) would, in compact JSON such as
  // `{"dsn":"postgres://h/db","password":"alpha bravo"}`, swallow the next key
  // and the start of its value and leave the rest. So every pattern that knows
  // where its own secret ends (quoted values, literals under a quoted key,
  // nested values, malformed literals under a quoted key, header lines) runs first, then BEARER and SECRET_WORD, and
  // only then URL_LIKE and USERINFO.
  const cleaned = decodeKeyEscapes(bounded)
    .replace(QUOTED_PAIR, `$1$2=${DONE}`)
    .replace(LITERAL_PAIR, `$1$2=${DONE}`)
    .replace(NESTED_PAIR, `$1$2=${DONE}`)
    .replace(MALFORMED_LITERAL, `$1$2=${DONE}`)
    .replace(HEADER_LINE, `$1$2=${DONE}`)
    .replace(BEARER, "Bearer [redacted]")
    .replace(SECRET_WORD, `$1$2=${DONE}`)
    .replace(URL_LIKE, "[url]")
    .replace(USERINFO, "[redacted]@")
    .replace(NEON_PASSWORD, "[redacted]")
    .replace(AGENT_CREDENTIAL, "[redacted]")
    .replaceAll(DONE, "[redacted]")
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
