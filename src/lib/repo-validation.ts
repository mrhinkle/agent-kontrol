/**
 * Validation for the watched-repos list. Pure and browser-safe: the settings
 * page runs it as you type, and the API runs it again before saving, so the two
 * can never disagree about what is valid.
 */

export const MAX_REPOS = 25;

export interface RepoInput {
  /** owner/name as GitHub knows it */
  repo: string;
  label: string;
  short: string;
  color: string;
  /** the label this repo uses for blocked work, or null if it does not track any */
  blockedLabel: string | null;
}

export type RepoField = "repo" | "label" | "short" | "color" | "blockedLabel" | "repos";

export interface RepoError {
  /** row index, or -1 for an error about the whole list */
  index: number;
  field: RepoField;
  message: string;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHORT_RE = /^[\w-]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SEPARATOR_MESSAGE = 'Do not use "|". The collector uses it as a field separator.';
// Control characters (a newline would split the collector's one-line-per-repo format).
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CONTROL_MESSAGE = "Do not use line breaks or control characters.";
// The blocked label is placed inside a quoted GitHub search qualifier.
const QUOTE_MESSAGE = 'Do not use " or \\ in the blocked label. It is used in a GitHub search.';

export type RepoValidation = { ok: true; repos: RepoInput[] } | { ok: false; errors: RepoError[] };

export function validateRepoList(input: unknown): RepoValidation {
  const errors: RepoError[] = [];

  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ index: -1, field: "repos", message: "Expected a list of repos." }] };
  }
  if (input.length === 0) {
    errors.push({ index: -1, field: "repos", message: "Add at least one repo." });
  }
  if (input.length > MAX_REPOS) {
    errors.push({ index: -1, field: "repos", message: `At most ${MAX_REPOS} repos.` });
  }

  const repos: RepoInput[] = [];
  const seenRepos = new Set<string>();
  const seenShorts = new Set<string>();

  input.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ index, field: "repo", message: "Each row must be an object." });
      return;
    }
    const e = raw as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

    const repo = str(e.repo);
    if (!REPO_RE.test(repo) || repo.length > 100) {
      errors.push({ index, field: "repo", message: "Use owner/name, for example acme/docs." });
    } else if (seenRepos.has(repo.toLowerCase())) {
      errors.push({ index, field: "repo", message: "This repo is already in the list." });
    }
    seenRepos.add(repo.toLowerCase());

    const label = str(e.label);
    if (label.length < 1 || label.length > 40) {
      errors.push({ index, field: "label", message: "Label must be 1 to 40 characters." });
    } else if (CONTROL_RE.test(label)) {
      errors.push({ index, field: "label", message: CONTROL_MESSAGE });
    } else if (label.includes("|")) {
      errors.push({ index, field: "label", message: SEPARATOR_MESSAGE });
    }

    const short = str(e.short);
    if (short.length < 1 || short.length > 12 || !SHORT_RE.test(short)) {
      errors.push({ index, field: "short", message: "Short name: 1 to 12 letters, digits, - or _." });
    } else if (seenShorts.has(short.toLowerCase())) {
      errors.push({ index, field: "short", message: "This short name is already used." });
    }
    seenShorts.add(short.toLowerCase());

    const color = typeof e.color === "string" ? e.color.trim() : "";
    if (!COLOR_RE.test(color)) {
      errors.push({ index, field: "color", message: "Use a color like #2563eb." });
    }

    let blockedLabel: string | null = null;
    if (e.blockedLabel !== undefined && e.blockedLabel !== null) {
      if (typeof e.blockedLabel !== "string") {
        errors.push({ index, field: "blockedLabel", message: "Blocked label must be text, or empty." });
      } else {
        const b = e.blockedLabel.trim();
        if (b.length > 50) {
          errors.push({ index, field: "blockedLabel", message: "Blocked label must be 50 characters or fewer." });
        } else if (CONTROL_RE.test(b)) {
          errors.push({ index, field: "blockedLabel", message: CONTROL_MESSAGE });
        } else if (b.includes("|")) {
          errors.push({ index, field: "blockedLabel", message: SEPARATOR_MESSAGE });
        } else if (b.includes('"') || b.includes("\\")) {
          errors.push({ index, field: "blockedLabel", message: QUOTE_MESSAGE });
        } else {
          blockedLabel = b === "" ? null : b;
        }
      }
    }

    repos.push({ repo, label, short, color: color.toLowerCase(), blockedLabel });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, repos };
}
