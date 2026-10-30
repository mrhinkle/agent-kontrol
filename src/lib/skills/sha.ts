import { createHash } from "node:crypto";

/**
 * SHA-256 hex of the SKILL.md bytes.
 * Collectors hash the file as stored, UTF-8, with no newline normalisation.
 */
export function skillSha(bytes: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
  return hash.digest("hex");
}

/** Same hash. Callers that say "content sha" mean the SKILL.md bytes. */
export const skillContentSha = skillSha;

/** Seven hex characters, the same length git uses for an abbreviated commit. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function traceIdForRun(runId: string): string {
  return runId.replace(/-/g, "").toLowerCase();
}

export function spanIdForRun(runId: string): string {
  return traceIdForRun(runId).slice(0, 16);
}
