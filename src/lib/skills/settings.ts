import { isCron } from "./cron";
import {
  DEFAULT_SCOPE,
  DEFAULT_TRIGGER,
  isTrigger,
  type SettingsRecord,
  type SkillScope,
  type Trigger,
} from "./types";

export type SettingsFail = {
  ok: false;
  code: "validation_failed" | "missing_field";
  message: string;
  fields: Record<string, string>;
};

export type SettingsPatch = {
  trigger: Trigger;
  scope: SkillScope;
  schedule: string | null;
};

const ALLOWED = new Set(["trigger", "scope", "schedule"]);
const SCOPE_KEYS = new Set(["mode", "lanes"]);
const LANE_MAX = 32;
const LANE_LEN = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Merge a PATCH body onto the current settings.
 * Unknown keys are rejected. `scheduled` requires a 5-field cron. Any other
 * trigger stores a null schedule. `all` forces lanes to []. `selected`
 * requires at least one lane string.
 */
export function parseSettingsPatch(
  body: unknown,
  current: Pick<SettingsRecord, "trigger" | "scope" | "schedule"> | null,
): { ok: true; value: SettingsPatch } | SettingsFail {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("validation_failed", { body: "Send a JSON object." });
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ALLOWED.has(key));
  if (unknown.length > 0) {
    return fail("validation_failed", { body: `Unknown fields: ${unknown.join(", ")}` });
  }
  if (!("trigger" in record) && !("scope" in record) && !("schedule" in record)) {
    return fail("missing_field", { body: "Send trigger, scope, or schedule." });
  }

  const base = current ?? { trigger: DEFAULT_TRIGGER, scope: DEFAULT_SCOPE, schedule: null };
  let trigger = base.trigger;
  if ("trigger" in record) {
    if (typeof record.trigger !== "string" || !isTrigger(record.trigger)) {
      return fail("validation_failed", { trigger: "trigger must be off, on_request, auto_inject, or scheduled." });
    }
    trigger = record.trigger;
  }

  let scope = base.scope;
  if ("scope" in record) {
    const parsed = parseScope(record.scope);
    if (!parsed.ok) return parsed;
    scope = parsed.value;
  }

  let schedule = base.schedule;
  if ("schedule" in record) {
    if (record.schedule == null) schedule = null;
    else if (typeof record.schedule !== "string" || !isCron(record.schedule)) {
      return fail("validation_failed", { schedule: "schedule must be a 5-field cron." });
    } else schedule = record.schedule.trim();
  }

  if (trigger === "scheduled") {
    if (!schedule || !isCron(schedule)) {
      return fail("validation_failed", { schedule: "scheduled requires a 5-field cron." });
    }
  } else {
    schedule = null;
  }

  return { ok: true, value: { trigger, scope, schedule } };
}

function parseScope(value: unknown): { ok: true; value: SkillScope } | SettingsFail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("validation_failed", { scope: "scope must be an object with mode and lanes." });
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !SCOPE_KEYS.has(key));
  if (unknown.length > 0) {
    return fail("validation_failed", { scope: `Unknown scope fields: ${unknown.join(", ")}` });
  }
  if (record.mode !== "all" && record.mode !== "selected") {
    return fail("validation_failed", { scope: "scope.mode must be all or selected." });
  }
  if (!Array.isArray(record.lanes) || record.lanes.some((lane) => typeof lane !== "string")) {
    return fail("validation_failed", { scope: "scope.lanes must be an array of strings." });
  }
  if (record.lanes.length > LANE_MAX) {
    return fail("validation_failed", { scope: `scope.lanes accepts at most ${LANE_MAX} lanes.` });
  }
  const lanes: string[] = [];
  for (const lane of record.lanes) {
    const trimmed = lane.trim();
    if (!trimmed || trimmed.length > LANE_LEN || CONTROL.test(trimmed)) {
      return fail("validation_failed", { scope: "each lane must be 1-200 characters with no control characters." });
    }
    if (!lanes.includes(trimmed)) lanes.push(trimmed);
  }
  if (record.mode === "all") return { ok: true, value: { mode: "all", lanes: [] } };
  if (lanes.length < 1) {
    return fail("validation_failed", { scope: "selected requires at least one lane." });
  }
  return { ok: true, value: { mode: "selected", lanes } };
}

function fail(code: SettingsFail["code"], fields: Record<string, string>): SettingsFail {
  const message = Object.values(fields)[0] ?? "validation failed";
  return { ok: false, code, message, fields };
}

export function parseSyncBody(
  body: unknown,
): { ok: true; trigger: "manual" | "scheduled" } | SettingsFail {
  if (body == null) return { ok: true, trigger: "manual" };
  if (typeof body !== "object" || Array.isArray(body)) {
    return fail("validation_failed", { body: "Send a JSON object." });
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "trigger");
  if (unknown.length > 0) return fail("validation_failed", { body: `Unknown fields: ${unknown.join(", ")}` });
  if (!("trigger" in record)) return { ok: true, trigger: "manual" };
  if (record.trigger !== "manual" && record.trigger !== "scheduled") {
    return fail("validation_failed", { trigger: "trigger must be manual or scheduled." });
  }
  return { ok: true, trigger: record.trigger };
}

export function scopeAdmits(scope: SkillScope, lane: string | null | undefined): boolean {
  if (scope.mode === "all") return true;
  if (!lane) return false;
  return scope.lanes.includes(lane);
}

/**
 * The list_skills visibility check for trigger and lane.
 * Callers still apply runtime, category, and query.
 * Trigger off is hidden. A trigger outside off, on_request, auto_inject, and
 * scheduled is hidden the same way. A selected scope with no lane is hidden.
 * The lane has to be in scope.
 */
export function isListSkillVisible(
  skill: { trigger: string; scope: SkillScope },
  lane: string | null | undefined,
): boolean {
  if (!isTrigger(skill.trigger) || skill.trigger === "off") return false;
  if (skill.scope.mode === "selected" && !lane) return false;
  return scopeAdmits(skill.scope, lane);
}
