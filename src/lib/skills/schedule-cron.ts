/**
 * Due-time maths for the five-field cron that `isCron` validates.
 * Everything is UTC. A skill schedule has no time zone field.
 */
import { isCron } from "./cron";

const BOUNDS: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export interface CompiledCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function expand(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const stepped = part.match(/^(.+)\/([0-9]+)$/);
    const step = stepped ? Number(stepped[2]) : 1;
    const base = stepped ? stepped[1] : part;
    let start = min;
    let end = max;
    if (base !== "*") {
      const range = base.match(/^([0-9]+)-([0-9]+)$/);
      if (range) {
        start = Number(range[1]);
        end = Number(range[2]);
      } else {
        start = Number(base);
        end = stepped ? max : start;
      }
    }
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return out;
}

/** Null when the expression is not a valid five-field cron. */
export function compileCron(expr: string): CompiledCron | null {
  if (!isCron(expr)) return null;
  const fields = expr.trim().split(/[ \t]+/);
  const sets = fields.map((field, i) => expand(field, BOUNDS[i][0], BOUNDS[i][1]));
  const dow = new Set([...sets[4]].map((n) => (n === 7 ? 0 : n)));
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domRestricted: !fields[2].startsWith("*"),
    dowRestricted: !fields[4].startsWith("*"),
  };
}

/** True when the UTC minute containing `at` matches. Day-of-month and day-of-week are ORed when both are restricted. As in Vixie cron, a field that starts with `*` (including a stepped star) counts as unrestricted. */
export function cronMatches(cron: CompiledCron, at: Date): boolean {
  if (!cron.minute.has(at.getUTCMinutes()) || !cron.hour.has(at.getUTCHours())) return false;
  if (!cron.month.has(at.getUTCMonth() + 1)) return false;
  const domOk = cron.dom.has(at.getUTCDate());
  const dowOk = cron.dow.has(at.getUTCDay());
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

export const MINUTE_MS = 60_000;

export function floorToMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** `2026-10-27T12:00Z`: the slot id. A slot is one UTC minute. */
export function slotId(at: Date): string {
  return `${floorToMinute(at).toISOString().slice(0, 16)}Z`;
}

export function parseSlot(slot: string): Date | null {
  const m = slot.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z$/);
  if (!m) return null;
  const d = new Date(`${m[1]}:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Latest matching minute in (now - lookbackMinutes, now], or null. */
export function latestDueSlot(cron: CompiledCron, now: Date, lookbackMinutes: number): Date | null {
  const end = floorToMinute(now).getTime();
  for (let i = 0; i < lookbackMinutes; i += 1) {
    const at = new Date(end - i * MINUTE_MS);
    if (cronMatches(cron, at)) return at;
  }
  return null;
}

/** Matching minutes strictly between two slots, looking back at most `capMinutes` from `to`. */
export function countMatchesBetween(cron: CompiledCron, from: Date, to: Date, capMinutes = 7 * 24 * 60): number {
  const lo = Math.max(from.getTime() + MINUTE_MS, to.getTime() - capMinutes * MINUTE_MS);
  let n = 0;
  for (let t = lo; t < to.getTime(); t += MINUTE_MS) {
    if (cronMatches(cron, new Date(t))) n += 1;
  }
  return n;
}

/** First matching minute strictly after `now`. Walks days, then hours and minutes, so 0 0 29 2 * finds the next leap day up to 8 years out. Null when none (0 0 31 2 *). */
export function nextDueSlot(cron: CompiledCron, now: Date): Date | null {
  const start = floorToMinute(now).getTime() + MINUTE_MS;
  const firstDay = Math.floor(start / DAY_MS) * DAY_MS;
  for (let d = 0; d < 8 * 366; d += 1) {
    const day = firstDay + d * DAY_MS;
    if (!cronMatches({ ...cron, minute: ALL, hour: ALL }, new Date(day))) continue;
    for (let h = 0; h < 24; h += 1) {
      if (!cron.hour.has(h)) continue;
      for (let m = 0; m < 60; m += 1) {
        if (!cron.minute.has(m)) continue;
        const at = day + h * 3_600_000 + m * MINUTE_MS;
        if (at >= start) return new Date(at);
      }
    }
  }
  return null;
}

const DAY_MS = 86_400_000;
const ALL = new Set(Array.from({ length: 60 }, (_, i) => i));
