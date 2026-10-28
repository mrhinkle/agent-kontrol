/**
 * Validation for watched owners. Pure and browser-safe: Settings runs it
 * before save, and the API runs it again, so the two agree.
 *
 * A GitHub owner is a user or organization login, never `owner/name` and
 * never a path. Stored lowercase because GitHub compares logins that way.
 */

export const MAX_OWNERS = 20;
export const OWNER_NAME_MAX = 39;
export const ACTIVITY_DAYS_DEFAULT = 30;
export const ACTIVITY_DAYS_MAX = 3650;

export interface OwnerInput {
  owner: string;
  activityDays: number;
  includeForks: boolean;
  includeArchived: boolean;
}

export type OwnerField = "owner" | "activity_days" | "include_forks" | "include_archived" | "owners";

export interface OwnerError {
  index: number;
  field: OwnerField;
  message: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export type OwnerNameResult = { ok: true; owner: string } | { ok: false; message: string };

/** One owner string. Does not trim a value into acceptance. */
export function validateOwnerName(raw: unknown): OwnerNameResult {
  if (typeof raw !== "string") {
    return { ok: false, message: "Owner must be a GitHub user or organization name." };
  }
  if (raw.length === 0 || raw.trim().length === 0) {
    return { ok: false, message: "Owner is required." };
  }
  if (raw !== raw.trim() || /\s/.test(raw)) {
    return { ok: false, message: "Owner must not contain whitespace." };
  }
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..") || /%2e/i.test(raw)) {
    return { ok: false, message: "Owner must be a GitHub name, not a path." };
  }
  if (raw.length > OWNER_NAME_MAX) {
    return { ok: false, message: `Owner must be ${OWNER_NAME_MAX} characters or fewer.` };
  }
  if (raw.includes("--") || !OWNER_RE.test(raw)) {
    return { ok: false, message: "Use a GitHub owner: letters, digits, and single hyphens, 1 to 39 characters." };
  }
  return { ok: true, owner: raw.toLowerCase() };
}

export type OwnerListResult = { ok: true; owners: OwnerInput[] } | { ok: false; errors: OwnerError[] };

export function validateOwnerList(input: unknown): OwnerListResult {
  const errors: OwnerError[] = [];
  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ index: -1, field: "owners", message: "Expected a list of owners." }] };
  }
  if (input.length > MAX_OWNERS) {
    errors.push({ index: -1, field: "owners", message: `At most ${MAX_OWNERS} owners.` });
  }

  const owners: OwnerInput[] = [];
  const seen = new Set<string>();

  input.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ index, field: "owner", message: "Each row must be an object." });
      return;
    }
    const row = raw as Record<string, unknown>;
    const name = validateOwnerName(row.owner);
    let owner = "";
    if (!name.ok) {
      errors.push({ index, field: "owner", message: name.message });
    } else if (seen.has(name.owner)) {
      errors.push({ index, field: "owner", message: "This owner is already in the list." });
      owner = name.owner;
    } else {
      owner = name.owner;
      seen.add(owner);
    }

    let activityDays = ACTIVITY_DAYS_DEFAULT;
    if (row.activity_days !== undefined && row.activityDays !== undefined) {
      errors.push({ index, field: "activity_days", message: "Send activity_days once." });
    }
    const activity = row.activity_days !== undefined ? row.activity_days : row.activityDays;
    if (activity !== undefined) {
      if (typeof activity !== "number" || !Number.isInteger(activity) || activity < 1 || activity > ACTIVITY_DAYS_MAX) {
        errors.push({
          index,
          field: "activity_days",
          message: `activity_days must be a whole number from 1 to ${ACTIVITY_DAYS_MAX}.`,
        });
      } else {
        activityDays = activity;
      }
    }

    const flag = (value: unknown, field: "include_forks" | "include_archived", fallback: boolean): boolean => {
      if (value === undefined) return fallback;
      if (typeof value !== "boolean") {
        errors.push({ index, field, message: `${field} must be true or false.` });
        return fallback;
      }
      return value;
    };
    const includeForks = flag(
      row.include_forks !== undefined ? row.include_forks : row.includeForks,
      "include_forks",
      false,
    );
    const includeArchived = flag(
      row.include_archived !== undefined ? row.include_archived : row.includeArchived,
      "include_archived",
      false,
    );

    if (owner) owners.push({ owner, activityDays, includeForks, includeArchived });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, owners };
}
