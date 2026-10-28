import type { DecisionStore, ListStatus, PatchInput, UpsertInput } from "../../src/lib/decisions";

/** In-memory queue with the same hold, stale, and terminal rules as the SQL. */
export function createMemoryDecisionStore(): DecisionStore & {
  rows: Record<string, unknown>[];
  upserts: UpsertInput[];
} {
  const rows: Record<string, unknown>[] = [];
  const upserts: UpsertInput[] = [];
  let next = 1;
  let clock = 0;

  // Each write moves updated_at by at least 1ms so a same-millisecond
  // decide-then-resolve still has a revision the stale guard can reject.
  function stamp(previous?: unknown): string {
    const prev = typeof previous === "string" ? Date.parse(previous) : Number.NaN;
    const ms = Math.max(Date.now(), clock + 1, Number.isNaN(prev) ? 0 : prev + 1);
    clock = ms;
    return new Date(ms).toISOString();
  }

  function copy(row: Record<string, unknown>): Record<string, unknown> {
    return { ...row };
  }

  return {
    rows,
    upserts,
    async get(id) {
      const row = rows.find((item) => item.id === id);
      return row ? copy(row) : null;
    },
    async list(query) {
      const now = Date.now();
      const matched = rows.filter((row) => {
        if (query.shape === "brief") {
          return row.source === "github-label" && row.status !== "withdrawn" && row.github_present !== false && row.number != null;
        }
        if (query.status === "all") return true;
        if (query.status === "open") {
          if (row.status === "open") return true;
          if (row.status === "deferred" && row.defer_until != null && Date.parse(String(row.defer_until)) <= now) return true;
          return false;
        }
        return row.status === query.status;
      }).filter((row) => {
        if (query.repo && row.repo !== query.repo) return false;
        if (query.shape !== "brief" && query.source && row.source !== query.source) return false;
        if (query.shape !== "brief" && query.writeback && row.writeback !== query.writeback) return false;
        return true;
      });
      matched.sort((a, b) => String(a.first_seen_at).localeCompare(String(b.first_seen_at)) || Number(a.id) - Number(b.id));
      return matched.slice(0, query.limit).map(copy);
    },
    async upsert(input) {
      upserts.push(input);
      const existing = rows.find((row) => row.key === input.key);
      const now = stamp(existing?.updated_at);
      if (!existing) {
        const row: Record<string, unknown> = {
          id: next,
          key: input.key,
          source: input.source,
          repo: input.repo,
          repo_short: input.repo_short,
          number: input.number,
          url: input.url,
          title: input.title,
          why: input.why,
          options: input.options,
          recommended: input.recommended,
          requested_by: input.requested_by,
          status: "open",
          decision: null,
          decided_by: null,
          decided_at: null,
          defer_until: null,
          kind: input.kind,
          labels: input.labels,
          opened_at: input.opened_at,
          github_present: input.github_present,
          actor_type: null,
          actor_id: null,
          chosen_option: null,
          writeback: null,
          first_seen_at: input.first_seen_at ?? input.opened_at ?? now,
          last_seen_at: now,
          created_at: now,
          updated_at: now,
        };
        next += 1;
        rows.push(row);
        return { row: copy(row), previous_status: null };
      }
      const previous = String(existing.status);
      let clearAnswer = false;
      let clearDefer = false;
      let clearActor = false;
      if (input.force && (previous === "decided" || previous === "deferred")) {
        existing.status = "open";
        clearAnswer = true;
        clearDefer = previous === "deferred";
        clearActor = true;
      } else if (previous === "withdrawn") {
        existing.status = "open";
        clearDefer = true;
        clearActor = true;
      }
      existing.title = input.title;
      existing.last_seen_at = now;
      existing.updated_at = now;
      if (input.why != null) existing.why = input.why;
      if (input.options != null) existing.options = input.options;
      if (input.recommended != null) existing.recommended = input.recommended;
      if (existing.requested_by == null) existing.requested_by = input.requested_by;
      if (input.repo != null && existing.repo == null) existing.repo = input.repo;
      if (clearAnswer) {
        existing.decision = null;
        existing.decided_by = null;
        existing.decided_at = null;
      }
      if (clearDefer) existing.defer_until = null;
      if (clearActor) {
        existing.actor_type = null;
        existing.actor_id = null;
        existing.chosen_option = null;
        existing.writeback = null;
      }
      return { row: copy(existing), previous_status: previous };
    },
    async patch(id, input) {
      const row = rows.find((item) => item.id === id);
      if (!row) return null;
      if (input.expectedUpdatedAt && Date.parse(String(row.updated_at)) !== Date.parse(input.expectedUpdatedAt)) return null;
      if (
        input.guardTerminal
        && input.status !== "open"
        && (row.status === "decided" || row.status === "withdrawn")
      ) return null;
      const status = input.status ?? (row.status as PatchInput["status"]);
      const now = stamp(row.updated_at);
      if (input.status) row.status = input.status;
      if (status === "open") {
        row.decision = null;
        row.decided_by = null;
        row.decided_at = null;
        row.defer_until = null;
        row.actor_type = null;
        row.actor_id = null;
        row.chosen_option = null;
        row.writeback = null;
      } else {
        if (input.setDecision) row.decision = input.decision ?? null;
        if (input.setDecidedBy) row.decided_by = input.decided_by ?? null;
        if (status === "decided") row.decided_at = now;
        if (status === "deferred") row.defer_until = input.defer_until ?? null;
        if (status === "withdrawn" || status === "decided") row.defer_until = null;
        if (status === "withdrawn") row.github_present = false;
        if (input.setActor) {
          row.actor_type = input.actor_type ?? null;
          row.actor_id = input.actor_id ?? null;
        }
        if (input.setChosen) row.chosen_option = input.chosen_option ?? null;
        if (status === "decided" || status === "deferred" || status === "withdrawn") row.writeback = null;
      }
      row.updated_at = now;
      return copy(row);
    },
    async setWriteback(id, writeback) {
      const row = rows.find((item) => item.id === id);
      if (!row) return null;
      row.writeback = writeback;
      row.updated_at = stamp(row.updated_at);
      return copy(row);
    },
  };
}

export type { ListStatus };
