/**
 * Request-limit bounds shared by the credential store and the Settings form.
 * No server imports, so a client component can use it.
 */

export const DEFAULT_REQUESTS_PER_MINUTE = 60;
export const DEFAULT_REQUESTS_PER_DAY = 10_000;
export const RATE_LIMIT_MIN = 1;
export const RATE_LIMIT_MAX = 1_000_000;

/** A limit is a whole number from 1 to 1,000,000. There is no unlimited value. */
export function isValidRateLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RATE_LIMIT_MIN &&
    value <= RATE_LIMIT_MAX
  );
}
