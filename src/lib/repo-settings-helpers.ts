import type { RepoError, RepoField, RepoInput } from "./repo-validation";

/** A row in the editor: the saved fields plus a client-only id for stable React keys. */
export interface Row extends RepoInput {
  id: string;
}

export const PALETTE = ["#2563eb", "#f44800", "#19d2ff", "#2ee6a6", "#a855f7", "#f59e0b"];

let counter = 0;
const nextId = () => `row-${++counter}`;

export function newRow(index: number): Row {
  return { id: nextId(), repo: "", label: "", short: "", color: PALETTE[index % PALETTE.length], blockedLabel: null };
}

/** Hand-added rows, plus auto rows whose label, short, color, or blocked label was overridden. */
export function splitWatchedRepos<T extends { origin?: "manual" | "auto"; fieldsOverridden?: boolean | null }>(
  repos: T[],
): { editable: T[]; discovered: T[] } {
  return {
    editable: repos.filter((repo) => repo.origin !== "auto" || repo.fieldsOverridden === true),
    discovered: repos.filter((repo) => repo.origin === "auto" && repo.fieldsOverridden !== true),
  };
}

export function fromRepos(repos: RepoInput[]): Row[] {
  return repos.map((r) => ({ ...r, id: nextId() }));
}

export function toPayload(rows: Row[]): RepoInput[] {
  return rows.map(({ repo, label, short, color, blockedLabel, pinned, hidden, origin }) => {
    const out: RepoInput = { repo, label, short, color, blockedLabel };
    if (pinned !== undefined) out.pinned = pinned;
    if (hidden !== undefined) out.hidden = hidden;
    if (origin !== undefined) out.origin = origin;
    return out;
  });
}

/** Returns a new array with one row moved. Out-of-range or same-index moves keep the order. */
export function moveRow(rows: Row[], from: number, to: number): Row[] {
  const out = rows.slice();
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < rows.length;
  if (!inRange(from) || !inRange(to) || from === to) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/**
 * Same identity as `repoIdentity` in owner-discovery. Kept here so this
 * module does not import the planner (that file imports PALETTE from here).
 */
function repoKey(repo: string): string {
  const slash = repo.indexOf("/");
  const owner = (slash === -1 ? repo : repo.slice(0, slash)).toLowerCase();
  const name = slash === -1 ? "" : repo.slice(slash + 1).toLowerCase();
  return `${owner}/${name}`;
}

/**
 * After a pin or hide reload, keep the hand-added draft: text, order, and
 * ids stay. Pin, hide, and origin refresh from the server for the matching
 * identity. A row the server does not know stays. Server rows the draft
 * omitted stay omitted.
 */
export function preserveDirtyRows(rows: Row[], serverEditable: RepoInput[]): Row[] {
  const byKey = new Map<string, RepoInput>();
  for (const repo of serverEditable) {
    const key = repoKey(repo.repo);
    if (!byKey.has(key)) byKey.set(key, repo);
  }
  return rows.map((row) => {
    const server = byKey.get(repoKey(row.repo));
    if (!server) return row;
    return {
      ...row,
      pinned: server.pinned,
      hidden: server.hidden,
      origin: server.origin,
    };
  });
}

export function isDirty(initial: RepoInput[], rows: Row[]): boolean {
  if (initial.length !== rows.length) return true;
  return rows.some((r, i) => {
    const a = initial[i];
    return (
      a.repo !== r.repo ||
      a.label !== r.label ||
      a.short !== r.short ||
      a.color !== r.color ||
      a.blockedLabel !== r.blockedLabel ||
      (a.pinned === true) !== (r.pinned === true) ||
      (a.hidden === true) !== (r.hidden === true)
    );
  });
}

export function groupErrors(errors: RepoError[]): { list: string[]; rows: Record<number, Partial<Record<RepoField, string>>> } {
  const list: string[] = [];
  const rows: Record<number, Partial<Record<RepoField, string>>> = {};
  for (const e of errors) {
    if (e.index < 0) {
      list.push(e.message);
      continue;
    }
    const row = (rows[e.index] ??= {});
    if (row[e.field] === undefined) row[e.field] = e.message;
  }
  return { list, rows };
}
