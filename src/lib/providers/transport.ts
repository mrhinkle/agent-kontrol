/** Bounded metadata transport. Never include response bodies or credentials in errors. */
export async function jsonRequest(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("Empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error("Response exceeds 20 MiB"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Metadata request failed (HTTP, timeout, redirect, size or JSON error)");
  } finally {
    clearTimeout(timer);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid report object");
  return value as Record<string, unknown>;
}

export function nonnegative(value: unknown, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) {
    throw new Error("Missing, negative or invalid report number");
  }
  return value;
}

export function modelName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,199}$/.test(value)) throw new Error("Invalid model identifier");
  return value;
}

export const DAY_MS = 86_400_000;
export function utcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function validatePeriod(since: Date, until: Date, now = new Date()): void {
  const start = since.getTime(), end = until.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start % DAY_MS || end % DAY_MS ||
      end <= start || end - start > 30 * DAY_MS || end > utcMidnight(now).getTime()) {
    throw new Error("Expected 1 to 30 complete UTC days");
  }
}

export function utcDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid report date");
  }
  return value;
}

export function usdSum(a: number, b: number): number {
  return nonnegative(Math.round((a + b) * 1e10) / 1e10);
}
