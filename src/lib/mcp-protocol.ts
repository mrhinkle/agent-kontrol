import { AsyncLocalStorage } from "node:async_hooks";

import { errorBody } from "./api-error";

/**
 * App-owned wrapper around MCP HTTP responses. The SDK still authenticates,
 * validates, and executes. This module only adds teaching metadata, and it
 * turns one positively identified initial credential-store outage into the
 * existing 503 catalogue body.
 */

const FRAME_CAP = 1024 * 1024;
const TAIL = 4;
const CAUSE_CAP = 1000;

/**
 * Combined array elements and object members allowed in one `tools/call`
 * arguments object. The SDK counts those and stops before Zod. 4096 is
 * above a full watched-repo write (25 repos) and the owner cap (20), and a
 * schema rejection at this ceiling stays under the 1 MiB frame cap. Strings
 * do not count. The frame cap itself stays 1 MiB.
 */
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 4096;

const storage = new AsyncLocalStorage<{ initialCredentialStoreOutage: boolean }>();

export function runWithMcpRequest<T>(fn: () => T): T {
  return storage.run({ initialCredentialStoreOutage: false }, fn);
}

export function noteInitialCredentialStoreOutage(): void {
  const store = storage.getStore();
  if (store) store.initialCredentialStoreOutage = true;
}

function initialCredentialStoreOutage(): boolean {
  return storage.getStore()?.initialCredentialStoreOutage === true;
}

const TOOL_FIX = "Check the published schema and arguments. Contact the operator if they already match. Do not retry blindly.";
const PROTOCOL_FIX = "Read the protocol error and correct the request. Do not retry the same call blindly.";

const JSONRPC_TEACHING: Record<number, { code: string; fix: string; retryable: boolean }> = {
  [-32700]: { code: "mcp_parse_error", fix: "Send valid JSON. Do not retry this body.", retryable: false },
  [-32600]: { code: "mcp_invalid_request", fix: "Send a JSON-RPC 2.0 request. Do not retry this body.", retryable: false },
  [-32601]: { code: "mcp_method_not_found", fix: "Call a method this server publishes. Do not retry this method name.", retryable: false },
  [-32602]: { code: "mcp_invalid_params", fix: "Match the published parameter schema, then send corrected arguments.", retryable: false },
  [-32603]: { code: "mcp_internal_error", fix: "Retry a bounded number of times. The server failed while handling the request.", retryable: true },
  [-32001]: { code: "mcp_session_not_found", fix: "Start a new session with initialize. Do not retry the missing session id.", retryable: false },
  [-32000]: { code: "mcp_server_error", fix: PROTOCOL_FIX, retryable: false },
};

interface Teaching {
  code: string;
  cause: string;
  fix: string;
  retryable: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasTeaching(body: Record<string, unknown>): boolean {
  return typeof body.code === "string" && typeof body.fix === "string" && typeof body.retryable === "boolean";
}

function cap(value: string): string {
  return value.length > CAUSE_CAP ? value.slice(0, CAUSE_CAP) : value;
}

function authFix(description: string): string {
  if (description === "No authorization provided") {
    return "Send Authorization: Bearer with a current agent credential, legacy token, or OAuth access token.";
  }
  if (description === "Invalid token") {
    return "Send a current bearer token. This token is unknown or was rejected.";
  }
  if (description === "Token has expired") {
    return "Send a current bearer token. This token is expired.";
  }
  return "Send a current bearer token.";
}

function protocolTeaching(code: number, message: string): Teaching {
  const known = JSONRPC_TEACHING[code];
  if (!known) return { code: "mcp_protocol_error", cause: cap(message), fix: PROTOCOL_FIX, retryable: false };
  return { code: known.code, cause: cap(message), fix: known.fix, retryable: known.retryable };
}

function enrichAuthBody(body: Record<string, unknown>): unknown {
  if (hasTeaching(body)) return body;
  if (typeof body.error !== "string") return body;
  const description = typeof body.error_description === "string" ? body.error_description : body.error;
  return {
    ...body,
    code: typeof body.code === "string" ? body.code : "unauthorized",
    cause: typeof body.cause === "string" ? body.cause : description,
    fix: typeof body.fix === "string" ? body.fix : authFix(description),
    retryable: typeof body.retryable === "boolean" ? body.retryable : false,
  };
}

function enrichJsonRpc(rpc: Record<string, unknown>): unknown {
  const error = rpc.error as Record<string, unknown>;
  if (typeof error.code !== "number" || typeof error.message !== "string") return rpc;
  const teaching = protocolTeaching(error.code, error.message);
  if (!("data" in error)) return { ...rpc, error: { ...error, data: teaching } };
  if (!isPlainObject(error.data)) return rpc;
  const data = error.data;
  if (hasTeaching(data) && typeof data.cause === "string") return rpc;
  return { ...rpc, error: { ...error, data: { ...teaching, ...data } } };
}

function toolText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content) || !isPlainObject(content[0]) || typeof content[0].text !== "string") return "";
  return content[0].text;
}

function isApplicationEnvelope(result: Record<string, unknown>): boolean {
  const text = toolText(result);
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) && typeof parsed.error === "string" && hasTeaching(parsed);
  } catch {
    return false;
  }
}

function enrichToolResult(rpc: Record<string, unknown>): unknown {
  const result = rpc.result as Record<string, unknown>;
  if (isApplicationEnvelope(result)) return rpc;
  const teaching: Teaching = {
    code: "mcp_tool_error",
    cause: cap(toolText(result)),
    fix: TOOL_FIX,
    retryable: false,
  };
  if ("structuredContent" in result) {
    if (!isPlainObject(result.structuredContent)) return rpc;
    const existing = result.structuredContent;
    if (hasTeaching(existing) && typeof existing.cause === "string") return rpc;
    return { ...rpc, result: { ...result, structuredContent: { ...teaching, ...existing } } };
  }
  return { ...rpc, result: { ...result, structuredContent: teaching } };
}

function enrichPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const enriched = enrichPayload(item);
      if (enriched !== item) changed = true;
      return enriched;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) return value;
  if (isPlainObject(value.error) && typeof value.error.code === "number") return enrichJsonRpc(value);
  if (isPlainObject(value.result) && value.result.isError === true) return enrichToolResult(value);
  if (typeof value.error === "string" && !("jsonrpc" in value)) return enrichAuthBody(value);
  return value;
}

function outageResponse(): Response {
  return new Response(JSON.stringify(errorBody("credential_store_unavailable")), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

function replaceJson(response: Response, text: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-md5");
  headers.delete("digest");
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}

async function enrichJsonResponse(response: Response): Promise<Response> {
  if (!response.body) return response;
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return response;
  }
  if (!text) return response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return response;
  }
  const enriched = enrichPayload(parsed);
  if (enriched === parsed) return response;
  const next = JSON.stringify(enriched);
  if (next === text) return response;
  return replaceJson(response, next);
}

function frameEnd(bytes: Uint8Array): number {
  const limit = bytes.length;
  for (let i = 0; i < limit; i++) {
    const byte = bytes[i];
    if (byte === 10 && i + 1 < limit && bytes[i + 1] === 10) return i + 2;
    if (byte === 13 && i + 1 < limit && bytes[i + 1] === 13) return i + 2;
    if (
      byte === 13
      && i + 3 < limit
      && bytes[i + 1] === 10
      && bytes[i + 2] === 13
      && bytes[i + 3] === 10
    ) return i + 4;
  }
  return -1;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function rewriteFrame(frame: Uint8Array): { bytes: Uint8Array; mutated: boolean } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    return { bytes: frame, mutated: false };
  }
  let delim = "";
  if (text.endsWith("\r\n\r\n")) delim = "\r\n\r\n";
  else if (text.endsWith("\n\n")) delim = "\n\n";
  else if (text.endsWith("\r\r")) delim = "\r\r";
  else return { bytes: frame, mutated: false };
  const body = text.slice(0, -delim.length);
  const nl = delim === "\r\n\r\n" ? "\r\n" : delim === "\n\n" ? "\n" : "\r";
  const lines = body.split(nl);
  let eventName: string | null = null;
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataParts.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataParts.length === 0) return { bytes: frame, mutated: false };
  if (eventName && eventName !== "message") return { bytes: frame, mutated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataParts.join("\n"));
  } catch {
    return { bytes: frame, mutated: false };
  }
  const enriched = enrichPayload(parsed);
  if (enriched === parsed) return { bytes: frame, mutated: false };
  const next = JSON.stringify(enriched);
  if (next === dataParts.join("\n")) return { bytes: frame, mutated: false };
  let wroteData = false;
  const rebuilt: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      if (!wroteData) rebuilt.push(`data: ${next}`);
      wroteData = true;
      continue;
    }
    rebuilt.push(line);
  }
  return { bytes: new TextEncoder().encode(rebuilt.join(nl) + delim), mutated: true };
}

class FrameParser {
  pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  passthrough = false;
  queue: Uint8Array<ArrayBufferLike>[] = [];
  mutated = false;

  push(chunk: Uint8Array): void {
    let buf = concatBytes(this.pending, chunk);
    this.pending = new Uint8Array(0);
    if (this.passthrough) {
      const end = frameEnd(buf);
      if (end < 0) {
        if (buf.length > TAIL) {
          this.queue.push(buf.subarray(0, buf.length - TAIL));
          buf = buf.subarray(buf.length - TAIL);
        }
        this.pending = buf;
        return;
      }
      this.queue.push(buf.subarray(0, end));
      buf = buf.subarray(end);
      this.passthrough = false;
    }
    while (buf.length > 0) {
      const end = frameEnd(buf);
      if (end < 0) {
        if (buf.length > FRAME_CAP) {
          this.queue.push(buf.subarray(0, buf.length - TAIL));
          this.pending = buf.subarray(buf.length - TAIL);
          this.passthrough = true;
          return;
        }
        this.pending = buf;
        return;
      }
      const frame = buf.subarray(0, end);
      buf = buf.subarray(end);
      // A complete frame over the cap is passed through. Decoding it would
      // hold another copy, and the original protocol frame stays valid.
      if (frame.byteLength > FRAME_CAP) {
        this.queue.push(frame);
        continue;
      }
      const rewritten = rewriteFrame(frame);
      if (rewritten.mutated) this.mutated = true;
      this.queue.push(rewritten.bytes);
    }
  }

  flush(): void {
    if (this.pending.length === 0) return;
    this.queue.push(this.pending);
    this.pending = new Uint8Array(0);
    this.passthrough = false;
  }
}

function stripStaleLength(headers: Headers): void {
  headers.delete("content-length");
  headers.delete("content-md5");
  headers.delete("digest");
}

async function enrichSseResponse(response: Response): Promise<Response> {
  const body = response.body;
  if (!body) return response;
  const reader = body.getReader();
  const parser = new FrameParser();
  const first = reader.read();
  const winner = await Promise.race([
    first.then((result) => ({ kind: "read" as const, result })),
    new Promise<{ kind: "sleep" }>((resolve) => setTimeout(() => resolve({ kind: "sleep" }), 0)),
  ]);
  let consumedFirst = false;
  if (winner.kind === "read") {
    consumedFirst = true;
    if (winner.result.done) parser.flush();
    else if (winner.result.value) parser.push(winner.result.value);
  }
  const headers = new Headers(response.headers);
  // Drop length metadata before streaming. A later frame may grow, and the
  // adapter does not buffer the rest of the stream to find out.
  stripStaleLength(headers);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (parser.queue.length === 0) {
        const next = consumedFirst ? await reader.read() : await first;
        consumedFirst = true;
        if (next.done) {
          parser.flush();
          if (parser.queue.length === 0) {
            controller.close();
            return;
          }
          break;
        }
        if (next.value) parser.push(next.value);
      }
      const chunk = parser.queue.shift();
      if (chunk) controller.enqueue(chunk);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  }, { highWaterMark: 1 });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}

export async function enrichMcpResponse(response: Response): Promise<Response> {
  if (initialCredentialStoreOutage() && response.status === 401) return outageResponse();
  if (response.status === 202 || response.body === null) return response;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return enrichJsonResponse(response);
  if (type.includes("text/event-stream")) return enrichSseResponse(response);
  return response;
}
