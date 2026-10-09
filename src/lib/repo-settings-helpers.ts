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

export function fromRepos(repos: RepoInput[]): Row[] {
  return repos.map((r) => ({ ...r, id: nextId() }));
}

export function toPayload(rows: Row[]): RepoInput[] {
  return rows.map(({ repo, label, short, color, blockedLabel }) => ({ repo, label, short, color, blockedLabel }));
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

export function isDirty(initial: RepoInput[], rows: Row[]): boolean {
  if (initial.length !== rows.length) return true;
  return rows.some((r, i) => {
    const a = initial[i];
    return a.repo !== r.repo || a.label !== r.label || a.short !== r.short || a.color !== r.color || a.blockedLabel !== r.blockedLabel;
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
