/** Local no-write preview of a development-velocity capture.
 *  pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json
 *
 *  Reads one local JSON file of at most 2 MB, validates it with parseVelocity,
 *  and prints that snapshot plus summarizeVelocity. No import, upload, network,
 *  config, or credential read. Failures keep `error` and add `code`, `cause`,
 *  `fix`, and `retryable`.
 */
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseVelocity, summarizeVelocity, VELOCITY_MAX_BYTES } from "../src/lib/velocity";

const USAGE = "Usage: pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json";
const VALIDATION_FIX = "Correct the capture so it matches the shared velocity contract, then run the command again.";

const FAILURES = {
  usage: {
    error: USAGE,
    cause: "The command needs exactly one capture path.",
    fix: "Run pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json with one local JSON file.",
    retryable: false,
  },
  read: {
    error: "Capture file could not be read.",
    cause: "The path could not be opened, read, or closed as a file.",
    fix: "Pass a readable regular file and run the command again.",
    retryable: false,
  },
  oversize: {
    error: "Capture exceeds the 2 MB limit.",
    cause: "The file is larger than 2 MB.",
    fix: "Pass a capture of at most 2 MB and run the command again.",
    retryable: false,
  },
  utf8: {
    error: "Capture is not valid UTF-8 JSON.",
    cause: "The file is not valid UTF-8.",
    fix: "Save the capture as UTF-8 JSON and run the command again.",
    retryable: false,
  },
  json: {
    error: "Capture is not valid UTF-8 JSON.",
    cause: "The file is valid UTF-8 but is not JSON.",
    fix: "Correct the JSON syntax and run the command again.",
    retryable: false,
  },
} as const;

type PreviewCode = keyof typeof FAILURES | "validation";

export class PreviewReject extends Error {
  readonly code: PreviewCode;
  readonly reason: string;
  readonly fix: string;
  readonly retryable: boolean;

  constructor(code: PreviewCode, message: string, reason: string, fix: string, retryable: boolean) {
    super(message.slice(0, 240));
    this.name = "PreviewReject";
    this.code = code;
    this.reason = reason.slice(0, 240);
    this.fix = fix;
    this.retryable = retryable;
  }
}

interface CaptureFile {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

function previewReject(code: keyof typeof FAILURES): PreviewReject {
  const item = FAILURES[code];
  return new PreviewReject(code, item.error, item.cause, item.fix, item.retryable);
}

function rejectValidation(message: string): PreviewReject {
  const safe = message.slice(0, 240);
  return new PreviewReject("validation", safe, safe, VALIDATION_FIX, false);
}

async function openReadOnly(file: string): Promise<CaptureFile> {
  const handle = await open(file, "r");
  return {
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    close: () => handle.close(),
  };
}

/** Read at most VELOCITY_MAX_BYTES + 1, then stop. Never writes the path. */
async function readBounded(file: string, openCapture: (file: string) => Promise<CaptureFile> = openReadOnly): Promise<{ text: string; closeFailed: boolean }> {
  let handle: CaptureFile;
  try {
    handle = await openCapture(file);
  } catch {
    throw previewReject("read");
  }
  let outcome: { ok: true; text: string } | { ok: false; error: unknown };
  try {
    const limit = VELOCITY_MAX_BYTES;
    const buf = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const { bytesRead } = await handle.read(buf, offset, limit + 1 - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw previewReject("oversize");
    try {
      outcome = { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, offset)) };
    } catch {
      throw previewReject("utf8");
    }
  } catch (error) {
    outcome = { ok: false, error };
  }
  let closeFailed = false;
  try {
    await handle.close();
  } catch {
    closeFailed = true;
  }
  if (!outcome.ok) {
    if (outcome.error instanceof PreviewReject) throw outcome.error;
    throw previewReject("read");
  }
  return { text: outcome.text, closeFailed };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw previewReject("json");
  }
}

export async function previewFile(file: string, openCapture?: (file: string) => Promise<CaptureFile>) {
  const read = await readBounded(file, openCapture);
  let preview;
  try {
    preview = parseVelocity(parseJson(read.text));
  } catch (error) {
    if (error instanceof PreviewReject) throw error;
    throw rejectValidation(error instanceof Error ? error.message : "Invalid benchmark capture.");
  }
  // Close is a filesystem failure. It must not replace size, UTF-8, JSON, or validator errors.
  if (read.closeFailed) throw previewReject("read");
  return { preview, summary: summarizeVelocity(preview) };
}

function fail(error: unknown): void {
  const body = error instanceof PreviewReject
    ? { error: error.message, code: error.code, cause: error.reason, fix: error.fix, retryable: error.retryable }
    : { error: FAILURES.read.error, code: "read" as const, cause: FAILURES.read.cause, fix: FAILURES.read.fix, retryable: FAILURES.read.retryable };
  process.stderr.write(`${JSON.stringify(body)}\n`);
  process.exitCode = 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    try {
      return import.meta.url === pathToFileURL(entry).href;
    } catch {
      return false;
    }
  }
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].length === 0) fail(previewReject("usage"));
  else void previewFile(args[0]).then((body) => process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)).catch(fail);
}
