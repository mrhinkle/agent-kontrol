import { THRESHOLDS } from "../progress-config";

/** Tests move the skills clock. Production uses Date. */

let nowFn = (): Date => new Date();

export function skillNow(): Date {
  return nowFn();
}

export function setSkillNowForTests(fn: (() => Date) | null): void {
  nowFn = fn ?? (() => new Date());
}

/** Minutes after which a run with no end is stalled. Non-integers and values outside 1..10080 fall back to THRESHOLDS.skillStallMinutes. */
export function stallMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const fallback = THRESHOLDS.skillStallMinutes;
  const raw = env.AK_SKILL_STALL_MINUTES;
  if (raw == null || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 10080) return fallback;
  return n;
}

export const SYNC_LEASE_MS = 10 * 60 * 1000;
