/**
 * Setup / migration errors for Usage and Costs (Neon tables may be missing
 * until the operator runs supabase/schema.sql). Keep this scoped to /usage routes.
 */

export const USAGE_SETUP_MESSAGE =
  "Usage and Costs isn't set up yet: run supabase/schema.sql, then install the collector";

/** Postgres undefined_table — NeonDbError.code === "42P01". */
export function isUndefinedTableError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string; cause?: unknown };
  if (err.code === "42P01") return true;
  const msg = String(err.message ?? "");
  if (msg.includes("42P01")) return true;
  if (/relation ["'].*["'] does not exist/i.test(msg)) return true;
  if (/undefined_table/i.test(msg)) return true;
  if (err.cause) return isUndefinedTableError(err.cause);
  return false;
}
