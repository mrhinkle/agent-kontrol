/**
 * Tiny in-memory failed-attempt rate limiter with a sliding window.
 *
 * NOTE: this is per-serverless-instance, best-effort only. It is NOT a
 * distributed limiter — on platforms like Vercel/Lambda each instance
 * keeps its own counters, so effective limits may be looser than
 * configured. Good enough to blunt brute-force attempts; do not rely
 * on it for hard security guarantees.
 */

const MAX_TRACKED_KEYS = 10000;

export interface Limiter {
  check(key: string): { allowed: boolean; retryAfterSec: number };
  fail(key: string): void;
  reset(key: string): void;
}

export function createLimiter(opts: {
  max: number;
  windowMs: number;
  now?: () => number;
}): Limiter {
  const now = opts.now ?? (() => Date.now());
  const windowMs = opts.windowMs;
  const max = opts.max;
  const failures = new Map<string, number[]>(); // key -> timestamps of failures

  function prune(key: string, t: number): number[] {
    const list = failures.get(key);
    if (!list) return [];
    const cutoff = t - windowMs;
    let i = 0;
    while (i < list.length && list[i] <= cutoff) i++;
    if (i > 0) list.splice(0, i);
    if (list.length === 0) failures.delete(key);
    return list;
  }

  function evictIfNeeded(): void {
    if (failures.size <= MAX_TRACKED_KEYS) return;
    // Evict the key whose oldest failure is the oldest overall.
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [k, list] of failures) {
      const first = list[0];
      if (first !== undefined && first < oldest) {
        oldest = first;
        victim = k;
      }
    }
    if (victim !== null) failures.delete(victim);
  }

  return {
    check(key: string): { allowed: boolean; retryAfterSec: number } {
      const t = now();
      const list = prune(key, t);
      if (list.length < max) return { allowed: true, retryAfterSec: 0 };
      const oldest = list[0];
      const ms = oldest + windowMs - t;
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(ms / 1000)),
      };
    },
    fail(key: string): void {
      const t = now();
      prune(key, t);
      const list = failures.get(key) ?? [];
      list.push(t);
      failures.set(key, list);
      evictIfNeeded();
    },
    reset(key: string): void {
      failures.delete(key);
    },
  };
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  return "unknown";
}
