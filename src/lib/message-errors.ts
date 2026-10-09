/**
 * Setup / migration errors for two-way messaging.
 * Neon may be missing the new messages columns until the operator runs the migration.
 */

export const MESSAGES_SETUP_MESSAGE =
  "Two-way messaging isn't set up yet: run supabase/migrations/20261005_messages_two_way.sql (or supabase/schema.sql)";

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

/** Postgres undefined_column — NeonDbError.code === "42703". */
export function isUndefinedColumnError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string; cause?: unknown };
  if (err.code === "42703") return true;
  const msg = String(err.message ?? "");
  if (msg.includes("42703")) return true;
  if (/column ["'].*["'] does not exist/i.test(msg)) return true;
  if (/undefined_column/i.test(msg)) return true;
  if (err.cause) return isUndefinedColumnError(err.cause);
  return false;
}

export function isMessagesSetupError(e: unknown): boolean {
  return isUndefinedTableError(e) || isUndefinedColumnError(e);
}
