/**
 * Exact task lane. Same characters as LANE_RE in
 * src/app/api/skills/pointers/route.ts and agents/dispatcher/mc_dispatcher.py.
 *
 * JavaScript `$` also matches before a final newline. The match has to
 * consume every character, which is what Python `fullmatch` already does.
 */
const TASK_LANE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export function isTaskLane(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TASK_LANE_RE.exec(value);
  return match !== null && match[0].length === value.length;
}
