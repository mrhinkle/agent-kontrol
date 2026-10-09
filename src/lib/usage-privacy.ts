/** Shared privacy allow/deny for Usage and Costs ingest. */

export const CONTENT_FORBIDDEN = [
  "prompt",
  "completion",
  "message",
  "messages",
  "system_prompt",
  "tool_args",
  "arguments",
  "content",
  "body",
  "text",
] as const;

export function assertNoContent(detail: unknown, path = "detail"): void {
  if (detail == null) return;
  if (Array.isArray(detail)) {
    detail.forEach((v, i) => assertNoContent(v, `${path}[${i}]`));
    return;
  }
  if (typeof detail !== "object") return;
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if ((CONTENT_FORBIDDEN as readonly string[]).includes(k.toLowerCase())) {
      throw new Error(`privacy: refusing content-like field ${path}.${k}`);
    }
    assertNoContent(v, `${path}.${k}`);
  }
}
