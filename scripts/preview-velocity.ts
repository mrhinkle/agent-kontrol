/** Local no-write preview of a development-velocity capture.
 *  pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json
 *
 *  Reads one local JSON file of at most 2 MB, validates it with parseVelocity,
 *  and prints that snapshot plus summarizeVelocity. No import, upload, network,
 *  config, or credential read.
 */
import { realpathSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseVelocity, summarizeVelocity, VELOCITY_MAX_BYTES } from "../src/lib/velocity";

const USAGE = "Usage: pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json";

class PreviewReject extends Error {
  constructor(message: string) {
    super(message.slice(0, 240));
    this.name = "PreviewReject";
  }
}

/** Read at most VELOCITY_MAX_BYTES + 1, then stop. Never writes the path. */
async function readBounded(file: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch {
    throw new PreviewReject("Capture file could not be read.");
  }
  try {
    const limit = VELOCITY_MAX_BYTES;
    const buf = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const { bytesRead } = await handle.read(buf, offset, limit + 1 - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new PreviewReject("Capture exceeds the 2 MB limit.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, offset));
    } catch {
      throw new PreviewReject("Capture is not valid UTF-8 JSON.");
    }
  } finally {
    await handle.close();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PreviewReject("Capture is not valid UTF-8 JSON.");
  }
}

async function previewFile(file: string) {
  let preview;
  try {
    preview = parseVelocity(parseJson(await readBounded(file)));
  } catch (error) {
    if (error instanceof PreviewReject) throw error;
    throw new PreviewReject(error instanceof Error ? error.message : "Invalid benchmark capture.");
  }
  return { preview, summary: summarizeVelocity(preview) };
}

function fail(error: unknown): void {
  const message = error instanceof PreviewReject ? error.message : "Capture file could not be read.";
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
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
  if (args.length !== 1 || args[0].length === 0) fail(new PreviewReject(USAGE));
  else void previewFile(args[0]).then((body) => process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)).catch(fail);
}
