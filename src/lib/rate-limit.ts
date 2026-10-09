/**
 * In-memory, sliding window rate limiter. Per-serverless-instance best effort;
 * not a distributed limiter — each instance keeps its own counters, so the
 * effective limit scales with the number of running instances.
 *
 * To avoid a concurrency bypass, login throttling must use the "reservation"
 * pattern: call check(key) and, if allowed, call fail(key) immediately —
 * synchronously, with no await in between — to reserve the attempt, and call
 * reset(key) only once the attempt is known to be successful. Without the
 * synchronous reservation, a burst of concurrent requests can all pass the
 * check before any failure is recorded.
 *
 * clientIp() prefers headers the platform sets itself, in this order:
 * "x-vercel-forwarded-for", then "x-real-ip", then the first entry of
 * "x-forwarded-for", else "unknown". If the deployment is behind a proxy that
 * does not overwrite client-supplied forwarding headers, the limiter can be
 * evaded by rotating that header; such deployments must configure the proxy
 * to overwrite it.
 */

const MAX_TRACKED_KEYS = 10000;

export interface Limiter {
  check(key: string): { allowed: boolean; retryAfterSec: number };
  fail(key: string): void;
  reset(key: string): void;
}

export function createLimiter(opts: { max: number; windowMs: number; now?: () => number }): Limiter {
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

  // When over MAX_TRACKED_KEYS, evict the key with the fewest recorded
  // failures, breaking ties by the oldest first failure, so keys that are
  // locked out (at or above `max` failures) are evicted last. Single pass.
  function evictIfNeeded(): void {
    if (failures.size <= MAX_TRACKED_KEYS) return;
    let victim: string | null = null;
    let victimCount = Infinity;
    let victimOldest = Infinity;
    for (const [k, list] of failures) {
      const first = list[0];
      if (first === undefined) continue;
      if (list.length < victimCount || (list.length === victimCount && first < victimOldest)) {
        victim = k;
        victimCount = list.length;
        victimOldest = first;
      }
    }
    if (victim !== null) failures.delete(victim);
  }

  return {
    check(key) {
      const t = now();
      const list = prune(key, t);
      if (list.length < max) return { allowed: true, retryAfterSec: 0 };
      const ms = list[0] + windowMs - t;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(ms / 1000)) };
    },
    fail(key) {
      const t = now();
      prune(key, t);
      const list = failures.get(key) ?? [];
      list.push(t);
      failures.set(key, list);
      evictIfNeeded();
    },
    reset(key) { failures.delete(key); },
  };
}

export function clientIp(req: Request): string {
  const vff = req.headers.get("x-vercel-forwarded-for");
  if (vff) {
    const first = vff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}
