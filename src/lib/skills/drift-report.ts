import { skillNow } from "./clock";
import { compareDrift, driftDirs, type DriftDiff } from "./drift";
import { listSkillRows, upsertDrift } from "./store";
import type { DriftEntry } from "./types";

const SHA_RE = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type DriftParse =
  | { ok: true; host: string; dir: string; skills: DriftEntry[] }
  | { ok: false; message: string; fields: Record<string, string> };

export function parseDriftBody(body: unknown): DriftParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Send a JSON object.", fields: { body: "Send a JSON object." } };
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !["host", "dir", "skills"].includes(key));
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown fields: ${unknown.join(", ")}`, fields: { body: `Unknown fields: ${unknown.join(", ")}` } };
  }
  if (typeof record.host !== "string" || !record.host.trim() || record.host.length > 200 || CONTROL.test(record.host)) {
    return { ok: false, message: "host is required.", fields: { host: "Use 1-200 characters and no control characters." } };
  }
  if (typeof record.dir !== "string" || !record.dir.trim() || record.dir.length > 500 || CONTROL.test(record.dir)) {
    return { ok: false, message: "dir is required.", fields: { dir: "Use 1-500 characters and no control characters." } };
  }
  const dir = record.dir.trim();
  const allowed = driftDirs();
  if (!allowed.includes(dir)) {
    return {
      ok: false,
      message: "dir is not a drift directory.",
      fields: { dir: `dir must be one of: ${allowed.join(", ")}` },
    };
  }
  if (!Array.isArray(record.skills)) {
    return { ok: false, message: "skills must be an array.", fields: { skills: "skills must be an array." } };
  }
  if (record.skills.length > 5000) {
    return { ok: false, message: "skills is too long.", fields: { skills: "Send at most 5000 skills." } };
  }
  const skills: DriftEntry[] = [];
  const seen = new Set<string>();
  for (const item of record.skills) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, message: "each skill needs name and sha.", fields: { skills: "each skill needs name and sha." } };
    }
    const name = (item as { name?: unknown }).name;
    const sha = (item as { sha?: unknown }).sha;
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
      return { ok: false, message: "skill name is invalid.", fields: { skills: "name must be a skill id." } };
    }
    if (typeof sha !== "string" || !SHA_RE.test(sha.toLowerCase())) {
      return { ok: false, message: "skill sha must be 64 hex characters.", fields: { skills: "sha must be SHA-256 hex of the SKILL.md bytes." } };
    }
    if (seen.has(name)) {
      return { ok: false, message: "duplicate skill name.", fields: { skills: `duplicate name ${name}` } };
    }
    seen.add(name);
    skills.push({ name, sha: sha.toLowerCase() });
  }
  return { ok: true, host: record.host.trim(), dir, skills };
}

export async function recordDrift(input: {
  host: string;
  dir: string;
  skills: DriftEntry[];
}): Promise<DriftDiff & { host: string; dir: string; driftCount: number }> {
  await upsertDrift({
    host: input.host,
    dir: input.dir,
    reported_at: skillNow().toISOString(),
    entries: input.skills,
  });
  const rows = await listSkillRows();
  const mirror = rows.filter((skill) => !skill.removed_at).map((skill) => ({ name: skill.id, sha: skill.sha }));
  const mine = compareDrift(mirror, input.skills);
  return {
    host: input.host,
    dir: input.dir,
    ...mine,
    driftCount: mine.missing.length + mine.extra.length + mine.differs.length,
  };
}
