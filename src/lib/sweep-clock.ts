import type { SqlTag } from "./db";

/**
 * The sweeper's clock is the database's (#79 F4). One instant is read after
 * the caller has taken its lock, from clock_timestamp() so a wait on that lock
 * is not hidden behind the transaction's start time. The host clock and any
 * caller-supplied "now" are never used for a decision.
 *
 * Tests shift the database clock by a fixed offset. Production never calls
 * the setter, so the offset is zero.
 */

let offsetMs = 0;

export function setSweepClockOffsetForTests(value: number): void {
  offsetMs = value;
}

export class SweepClockError extends Error {
  constructor() {
    super("The database clock could not be read.");
    this.name = "SweepClockError";
  }
}

/** ISO instant with microseconds, in UTC. Throws SweepClockError: no instant, no write. */
export async function dbInstant(db: SqlTag): Promise<string> {
  const rows = await db`
    select to_char(
      (clock_timestamp() + ${offsetMs}::double precision * interval '1 millisecond') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) as now
  `;
  const now = rows[0]?.now;
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) throw new SweepClockError();
  return now;
}
