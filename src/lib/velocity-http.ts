import { VELOCITY_MAX_BYTES } from "./velocity";

export function velocityJSON(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
export function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export class VelocityBodyError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
/** Bound actual streamed bytes; Content-Length alone is not a limit. */
export async function readVelocityJSON(req: Request): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new VelocityBodyError("Upload a JSON benchmark capture.", 415);
  if (Number(req.headers.get("content-length")) > VELOCITY_MAX_BYTES) throw new VelocityBodyError("Capture exceeds the 2 MB limit.", 413);
  if (!req.body) throw new VelocityBodyError("Capture body is missing.", 400);
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > VELOCITY_MAX_BYTES) { await reader.cancel(); throw new VelocityBodyError("Capture exceeds the 2 MB limit.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new VelocityBodyError("Capture is not valid UTF-8 JSON.", 400); }
}
