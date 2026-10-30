import { createHmac, timingSafeEqual } from "node:crypto";
import { sql, type SqlTag } from "./db";

/**
 * GitHub webhook inbox (#77).
 *
 * The signature is the credential. A delivery is checked in this order:
 * secret configured, signature header shape, bounded body read, HMAC over
 * the raw bytes, delivery headers, JSON, then the event metadata. Nothing
 * here follows a URL or calls GitHub. Payload values reach SQL only as bound
 * parameters.
 *
 * insertGhEvent is the shared write. The sweeper (#79) calls it inside its own
 * transaction with a synthetic `sweep:` delivery id.
 */

/** Largest body the route reads: 1 MiB, counted from the stream. */
export const GH_WEBHOOK_BODY_MAX_BYTES = 1_048_576;

export const GH_ACCEPTED_EVENTS = [
  "pull_request",
  "check_suite",
  "status",
  "issue_comment",
  "issues",
  "push",
  "pull_request_review",
  "workflow_run",
] as const;

export type GhAcceptedEvent = (typeof GH_ACCEPTED_EVENTS)[number];

/** Delivery ids with this prefix are synthetic (#79). A webhook may not use it. */
export const SYNTHETIC_DELIVERY_PREFIX = "sweep:";

export const DELIVERY_ID_MAX = 200;
export const EVENT_NAME_MAX = 64;
/** Nesting deeper than this is not a GitHub payload. */
export const PAYLOAD_DEPTH_MAX = 100;

const WEBHOOK_DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/;
const EVENT_HEADER = /^[a-z][a-z_]{0,63}$/;
const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/;
const ACTION = /^[a-z_]{1,64}$/;
const REPO_FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
// Postgres jsonb cannot hold U+0000 or an unpaired surrogate.
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The configured secret, or null when unset or blank. The value is used as set. */
export function webhookSecret(): string | null {
  const secret = process.env.MC_GITHUB_WEBHOOK_SECRET;
  if (typeof secret !== "string" || secret.trim().length === 0) return null;
  return secret;
}

/** The 32 digest bytes from `sha256=<64 lowercase hex>`, or null for any other shape. */
export function parseSignatureHeader(header: string | null): Buffer | null {
  if (typeof header !== "string") return null;
  const match = SIGNATURE_HEADER.exec(header);
  return match ? Buffer.from(match[1], "hex") : null;
}

/** HMAC SHA-256 of the raw body under `secret`, compared in constant time. */
export function verifySignature(secret: string, body: Uint8Array, digest: Buffer): boolean {
  const expected = createHmac("sha256", secret).update(body).digest();
  return expected.length === digest.length && timingSafeEqual(expected, digest);
}

/** `sha256=<hex>` for a body. Tests and local tooling sign fixtures with it. */
export function signBody(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export type BoundedRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "unreadable" };

/**
 * Read at most `max` bytes from the stream. Content-Length is not consulted.
 * Past the cap the stream is cancelled without waiting, and a cancel that
 * rejects does not change the answer: the result is still too_large.
 */
export async function readBoundedBody(req: Request, max: number): Promise<BoundedRead> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        try {
          reader.cancel().catch(() => {});
        } catch {
          // The size decision stands.
        }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** A GitHub delivery id: 1 to 128 letters, digits, and hyphens. Excludes the `sweep:` namespace. */
export function isWebhookDeliveryId(value: string | null): value is string {
  return typeof value === "string"
    && WEBHOOK_DELIVERY_ID.test(value)
    && !value.startsWith(SYNTHETIC_DELIVERY_PREFIX);
}

/** A webhook event header: lowercase letters and underscores, at most 64. */
export function isEventHeader(value: string | null): value is string {
  return typeof value === "string" && EVENT_HEADER.test(value);
}

export function isAcceptedEvent(event: string): event is GhAcceptedEvent {
  return (GH_ACCEPTED_EVENTS as readonly string[]).includes(event);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Null when Postgres jsonb can store the value as parsed. Otherwise a reason:
 * nesting deeper than PAYLOAD_DEPTH_MAX, or a key or string holding U+0000 or
 * an unpaired surrogate. Iterative, so a deep body cannot overflow the stack.
 */
export function unstorableReason(value: unknown): string | null {
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (typeof node === "string") {
      if (UNSTORABLE.test(node)) return "The payload holds U+0000 or an unpaired surrogate, which jsonb cannot store.";
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    if (depth >= PAYLOAD_DEPTH_MAX) return `The payload is nested deeper than ${PAYLOAD_DEPTH_MAX} levels.`;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    for (const [key, item] of Object.entries(node)) {
      if (UNSTORABLE.test(key)) return "The payload holds U+0000 or an unpaired surrogate, which jsonb cannot store.";
      stack.push({ node: item, depth: depth + 1 });
    }
  }
  return null;
}

export interface GhEventMeta {
  action: string | null;
  repo: string;
  number: number | null;
  head_sha: string | null;
}

export type MetaResult =
  | { ok: true; meta: GhEventMeta }
  | { ok: false; field: string; message: string };

function objectAt(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  return isPlainObject(value) ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function shaOf(value: unknown): string | null {
  return typeof value === "string" && SHA.test(value) ? value : null;
}

/**
 * One number only when every listed pull request names the same one.
 * An empty, missing, or mixed list is null: the event is not tied to one PR.
 */
function singlePullNumber(list: unknown): number | null {
  if (!Array.isArray(list)) return null;
  const numbers = new Set<number>();
  for (const item of list) {
    const n = isPlainObject(item) ? positiveInt(item.number) : null;
    if (n === null) return null;
    numbers.add(n);
  }
  return numbers.size === 1 ? [...numbers][0] : null;
}

/**
 * The indexed columns for one accepted event, read from the payload.
 * Fields GitHub always sends for that event are required; a payload without
 * them is rejected, not stored with guesses.
 */
export function extractMetadata(event: GhAcceptedEvent, payload: Record<string, unknown>): MetaResult {
  const repository = objectAt(payload, "repository");
  const fullName = repository?.full_name;
  if (typeof fullName !== "string" || !REPO_FULL_NAME.test(fullName)) {
    return { ok: false, field: "repository.full_name", message: "repository.full_name must be owner/name." };
  }

  let action: string | null = null;
  if (event !== "push" && event !== "status") {
    if (typeof payload.action !== "string" || !ACTION.test(payload.action)) {
      return { ok: false, field: "action", message: `${event} needs an action of lowercase letters and underscores.` };
    }
    action = payload.action;
  }

  let number: number | null = null;
  let headSha: string | null = null;
  const fail = (field: string, message: string): MetaResult => ({ ok: false, field, message });

  switch (event) {
    case "pull_request":
    case "pull_request_review": {
      const pr = objectAt(payload, "pull_request");
      number = positiveInt(pr?.number);
      if (number === null) return fail("pull_request.number", "pull_request.number must be a positive integer.");
      const head = pr ? objectAt(pr, "head") : null;
      headSha = shaOf(head?.sha);
      if (headSha === null) return fail("pull_request.head.sha", "pull_request.head.sha must be a hex commit id.");
      break;
    }
    case "issues":
    case "issue_comment": {
      const issue = objectAt(payload, "issue");
      number = positiveInt(issue?.number);
      if (number === null) return fail("issue.number", "issue.number must be a positive integer.");
      break;
    }
    case "check_suite":
    case "workflow_run": {
      const run = objectAt(payload, event);
      if (!run) return fail(event, `${event} must be an object.`);
      headSha = shaOf(run.head_sha);
      if (headSha === null) return fail(`${event}.head_sha`, `${event}.head_sha must be a hex commit id.`);
      number = singlePullNumber(run.pull_requests);
      break;
    }
    case "status": {
      headSha = shaOf(payload.sha);
      if (headSha === null) return fail("sha", "sha must be a hex commit id.");
      break;
    }
    case "push": {
      headSha = shaOf(payload.after);
      if (headSha === null) return fail("after", "after must be a hex commit id.");
      break;
    }
  }

  return { ok: true, meta: { action, repo: fullName, number, head_sha: headSha } };
}

export interface GhEventInsert {
  delivery_id: string;
  event: string;
  action?: string | null;
  repo?: string | null;
  number?: number | null;
  head_sha?: string | null;
  payload: Record<string, unknown>;
}

export type GhEventInsertResult =
  | { stored: true; duplicate: false; id: string }
  | { stored: false; duplicate: true };

export class GhEventInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhEventInputError";
  }
}

function checkInput(input: GhEventInsert): void {
  const { delivery_id: deliveryId, event, payload } = input;
  if (typeof deliveryId !== "string" || deliveryId.length === 0 || deliveryId.length > DELIVERY_ID_MAX || CONTROL.test(deliveryId)) {
    throw new GhEventInputError(`delivery_id must be 1 to ${DELIVERY_ID_MAX} characters with no control characters.`);
  }
  if (typeof event !== "string" || event.length === 0 || event.length > EVENT_NAME_MAX || CONTROL.test(event)) {
    throw new GhEventInputError(`event must be 1 to ${EVENT_NAME_MAX} characters with no control characters.`);
  }
  if (!isPlainObject(payload)) throw new GhEventInputError("payload must be a JSON object.");
  if (input.number != null && positiveInt(input.number) === null) {
    throw new GhEventInputError("number must be a positive integer or null.");
  }
}

/**
 * Insert one row unless delivery_id already exists. One statement:
 * `insert ... on conflict (delivery_id) do nothing returning id`.
 * A duplicate changes nothing, not even received_at.
 *
 * Pass `db` to run inside a caller's transaction (withTransaction's tag).
 * This function never begins or commits. Without `db` it uses sql().
 * The id is returned as a decimal string because it is a bigint.
 */
export async function insertGhEvent(input: GhEventInsert, db?: SqlTag): Promise<GhEventInsertResult> {
  checkInput(input);
  const q = db ?? sql();
  const rows = await q`
    insert into gh_events (delivery_id, event, action, repo, number, head_sha, payload)
    values (
      ${input.delivery_id},
      ${input.event},
      ${input.action ?? null},
      ${input.repo ?? null},
      ${input.number ?? null},
      ${input.head_sha ?? null},
      ${JSON.stringify(input.payload)}::jsonb
    )
    on conflict (delivery_id) do nothing
    returning id::text as id
  `;
  if (rows.length === 0) return { stored: false, duplicate: true };
  return { stored: true, duplicate: false, id: String(rows[0].id) };
}
