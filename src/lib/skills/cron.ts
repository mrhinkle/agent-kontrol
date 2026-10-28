/**
 * Five-field cron: minute hour day-of-month month day-of-week.
 * Names (MON) and a sixth seconds field are rejected.
 */

const BOUNDS: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function pieceOk(piece: string, min: number, max: number): boolean {
  const stepped = piece.match(/^(.+)\/([0-9]+)$/);
  const step = stepped ? Number(stepped[2]) : null;
  const base = stepped ? stepped[1] : piece;
  if (step !== null && (step < 1 || step > max)) return false;
  if (base === "*") return true;
  const range = base.match(/^([0-9]+)-([0-9]+)$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return start >= min && end <= max && start <= end;
  }
  if (/^[0-9]+$/.test(base)) {
    const n = Number(base);
    return n >= min && n <= max;
  }
  return false;
}

function fieldOk(field: string, min: number, max: number): boolean {
  if (field.length === 0 || field.length > 80) return false;
  return field.split(",").every((part) => pieceOk(part, min, max));
}

/** True when `value` is a five-field cron expression. */
export function isCron(value: string): boolean {
  const fields = value.trim().split(/[ \t]+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => fieldOk(field, BOUNDS[i][0], BOUNDS[i][1]));
}

export const isFiveFieldCron = isCron;
