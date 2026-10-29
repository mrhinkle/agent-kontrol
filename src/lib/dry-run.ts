/**
 * Previews for the destructive writes: replacing the watched-repo list,
 * cancelling or updating a task, and overwriting a memory key.
 * Pure. Safe to import from a client component. Nothing here touches the database.
 */
import type { RepoInput } from "./repo-validation";
import type { MemoryItem, Task, TaskStatus } from "./types";

export type DryRunAction =
  | "replace_repos"
  | "cancel_task"
  | "update_task"
  | "requeue_task"
  | "overwrite_memory"
  | "insert_memory"
  | "delete_memory";

export interface DryRunChange {
  op: "add" | "remove" | "update" | "reorder" | "overwrite" | "insert";
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface DryRunResult {
  dry_run: true;
  applied: false;
  would_write: boolean;
  action: DryRunAction;
  changes: DryRunChange[];
  affected: Record<string, unknown>[];
  /**
   * Send this back as `expected_revision` to confirm. It is `md5` of the row,
   * or the literal `absent` when a memory key has no row. Omitted on previews
   * that have no row revision (a refused demo preview).
   */
  expected_revision?: string;
  note?: string;
}

/** Confirm tokens are short. A row hash or `absent` fits; a dump does not. */
export const EXPECTED_REVISION_MAX = 200;

/**
 * `undefined` means the caller omitted the guard and the write stays unconditional.
 * A present value must be a string of 1 to 200 characters with no control characters.
 */
export function readExpectedRevision(
  value: unknown,
): { ok: true; revision?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  if (value.length < 1 || value.length > EXPECTED_REVISION_MAX) return { ok: false };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false };
  return { ok: true, revision: value };
}

function withRevision(result: DryRunResult, expectedRevision?: string): DryRunResult {
  if (!expectedRevision) return result;
  return { ...result, expected_revision: expectedRevision };
}

export interface MemoryWriteInput {
  content: string;
  key?: string | null;
  tags?: string[];
  agent_id?: string | null;
}

export type StoredMemory = MemoryItem & {
  source?: string | null;
  facts_at?: string | null;
};

/** `true` previews. `false` or omitted applies. Any other value is rejected. */
export function readDryRun(value: unknown): { ok: true; dryRun: boolean } | { ok: false } {
  if (value === undefined || value === false) return { ok: true, dryRun: false };
  if (value === true) return { ok: true, dryRun: true };
  return { ok: false };
}

export function refusedDryRun(action: DryRunAction, note: string): DryRunResult {
  return {
    dry_run: true,
    applied: false,
    would_write: false,
    action,
    changes: [],
    affected: [],
    note,
  };
}

const REPO_FIELDS = ["label", "short", "color", "blockedLabel"] as const;

function repoRecord(repo: RepoInput, position: number): Record<string, unknown> {
  return {
    repo: repo.repo,
    label: repo.label,
    short: repo.short,
    color: repo.color,
    blockedLabel: repo.blockedLabel ?? null,
    position,
  };
}

/**
 * Diff two watched-repo lists the way `replaceWatchedRepos` matches rows:
 * the repo string is the primary key, so a case change is a remove plus an add.
 */
export function diffRepoList(current: RepoInput[], next: RepoInput[], wouldWrite = true): DryRunResult {
  const currentAt = new Map(current.map((repo, index) => [repo.repo, index]));
  const nextAt = new Map(next.map((repo, index) => [repo.repo, index]));
  const changes: DryRunChange[] = [];
  const affected: Record<string, unknown>[] = [];

  current.forEach((repo, index) => {
    if (nextAt.has(repo.repo)) return;
    const before = repoRecord(repo, index);
    changes.push({
      op: "remove",
      summary: `Remove ${repo.repo} (${repo.label}).`,
      before,
      after: null,
    });
    affected.push(before);
  });

  next.forEach((repo, index) => {
    const from = currentAt.get(repo.repo);
    if (from === undefined) {
      const after = repoRecord(repo, index);
      changes.push({
        op: "add",
        summary: `Add ${repo.repo} (${repo.label}).`,
        before: null,
        after,
      });
      affected.push(after);
      return;
    }
    const previous = current[from];
    const fields = REPO_FIELDS.filter((field) => (previous[field] ?? null) !== (repo[field] ?? null));
    const moved = from !== index;
    if (fields.length === 0 && !moved) return;
    const before = repoRecord(previous, from);
    const after = repoRecord(repo, index);
    const move = `Move from position ${from + 1} to position ${index + 1}.`;
    const summary = fields.length
      ? `Update ${repo.repo}: ${fields.join(", ")}.${moved ? ` ${move}` : ""}`
      : `Move ${repo.repo} from position ${from + 1} to position ${index + 1}.`;
    changes.push({
      op: fields.length ? "update" : "reorder",
      summary,
      before,
      after,
    });
    affected.push(before);
  });

  let note: string | undefined;
  if (!wouldWrite) {
    note = "No database is connected, so a save would be refused and nothing would be written.";
  } else if (changes.length === 0) {
    note = "Nothing in the list differs. Saving would still run the replace and refresh timestamps.";
  }

  return {
    dry_run: true,
    applied: false,
    would_write: wouldWrite,
    action: "replace_repos",
    changes,
    affected,
    note,
  };
}

export interface TaskPatch {
  status?: TaskStatus;
  result?: string;
  cost_usd?: number;
  session_id?: string;
  assigned_agent?: string;
  agent_id?: string;
}

const COMPLETES = new Set<TaskStatus>(["done", "failed", "cancelled"]);

/** Field diff for the update `updateTask` would run. Does not invent a timestamp. */
export function diffTaskUpdate(task: Task, patch: TaskPatch, expectedRevision?: string): DryRunResult {
  const before: Record<string, unknown> = { updated_at: task.updated_at };
  const after: Record<string, unknown> = { updated_at: "(set when the write runs)" };
  const bits: string[] = [];

  if (patch.status !== undefined) {
    before.status = task.status;
    after.status = patch.status;
    bits.push(
      patch.status === task.status
        ? `status stays ${task.status}`
        : `status ${task.status} → ${patch.status}`,
    );
  }
  if (patch.result !== undefined) {
    before.result = task.result;
    after.result = patch.result;
    bits.push("result would be replaced");
  }
  if (patch.cost_usd !== undefined) {
    before.cost_usd = task.cost_usd;
    after.cost_usd = patch.cost_usd;
    bits.push("cost_usd would be replaced");
  }
  if (patch.session_id !== undefined) {
    before.session_id = task.session_id;
    after.session_id = patch.session_id;
    bits.push("session_id would be replaced");
  }
  if (patch.assigned_agent !== undefined) {
    before.assigned_agent = task.assigned_agent;
    after.assigned_agent = patch.assigned_agent;
    bits.push("assigned_agent would be replaced");
  }
  if (patch.status !== undefined && COMPLETES.has(patch.status)) {
    before.completed_at = task.completed_at;
    after.completed_at = "(set when the write runs)";
    bits.push("completed_at would be set");
  }

  const changes: DryRunChange[] = [
    {
      op: "update",
      summary: `Task #${task.id} "${task.title}": ${bits.length ? bits.join("; ") : "updated_at would be refreshed"}.`,
      before,
      after,
    },
  ];
  if (patch.status && patch.agent_id) {
    changes.push({
      op: "insert",
      summary: `Would record a ${patch.status === "failed" ? "error" : "status"} event for ${patch.agent_id}.`,
      before: null,
      after: { agent_id: patch.agent_id, task_id: task.id, status: patch.status },
    });
  }

  return withRevision(
    {
      dry_run: true,
      applied: false,
      would_write: true,
      action: patch.status === "cancelled" ? "cancel_task" : "update_task",
      changes,
      affected: [{ ...task }],
    },
    expectedRevision,
  );
}

/** Insert when the key is new or omitted. Overwrite when a row already uses the key. */
export function diffMemoryWrite(
  existing: StoredMemory | null,
  input: MemoryWriteInput,
  expectedRevision?: string,
): DryRunResult {
  const key = input.key ?? null;
  const tags = input.tags ?? [];
  const agentId = input.agent_id ?? null;
  const after: Record<string, unknown> = {
    key,
    content: input.content,
    tags,
    agent_id: agentId,
    source: null,
    facts_at: null,
  };

  if (!existing) {
    const summary = key
      ? `Insert a note at key "${key}". No row uses that key.`
      : "Insert a new note with no key.";
    return withRevision(
      {
        dry_run: true,
        applied: false,
        would_write: true,
        action: "insert_memory",
        changes: [{ op: "insert", summary, before: null, after }],
        affected: [],
      },
      expectedRevision,
    );
  }

  const before: Record<string, unknown> = {
    id: existing.id,
    key: existing.key,
    content: existing.content,
    tags: Array.isArray(existing.tags) ? existing.tags : [],
    agent_id: existing.agent_id,
    source: existing.source ?? null,
    facts_at: existing.facts_at ?? null,
  };
  const parts: string[] = [];
  if (existing.content !== input.content) parts.push("content");
  if (JSON.stringify(before.tags) !== JSON.stringify(tags)) parts.push("tags");
  if ((existing.agent_id ?? null) !== agentId) parts.push("agent_id");
  if (existing.source) parts.push("source (cleared)");
  if (existing.facts_at) parts.push("facts_at (cleared)");
  const fieldText = parts.length
    ? parts.join(", ")
    : "updated_at (content, tags, and agent_id already match)";

  return withRevision(
    {
      dry_run: true,
      applied: false,
      would_write: true,
      action: "overwrite_memory",
      changes: [
        {
          op: "overwrite",
          summary: `Overwrite memory #${existing.id} key "${existing.key}". Would replace ${fieldText}.`,
          before,
          after,
        },
      ],
      affected: [before],
    },
    expectedRevision,
  );
}

/**
 * Preview of requeue_task. Status becomes queued. assigned_agent and
 * completed_at stay. updated_at is filled in when the write runs.
 * Actor columns change only when the confirm has an authenticated actor.
 */
export function diffTaskRequeue(
  task: Task,
  expectedRevision: string,
  actor?: { actor_type: string; actor_id: string } | null,
): DryRunResult {
  const before: Record<string, unknown> = {
    status: task.status,
    assigned_agent: task.assigned_agent,
    updated_at: task.updated_at,
  };
  const after: Record<string, unknown> = {
    status: "queued",
    assigned_agent: task.assigned_agent,
    updated_at: "(set when the write runs)",
  };
  if (actor) {
    before.actor_type = task.actor_type;
    before.actor_id = task.actor_id;
    after.actor_type = actor.actor_type;
    after.actor_id = actor.actor_id;
  }
  return withRevision(
    {
      dry_run: true,
      applied: false,
      would_write: true,
      action: "requeue_task",
      changes: [
        {
          op: "update",
          summary: `Task #${task.id} "${task.title}": status ${task.status} → queued.`,
          before,
          after,
        },
      ],
      affected: [{ ...task }],
    },
    expectedRevision,
  );
}

/** Preview of delete_note. The row is removed. Nothing is written on preview. */
export function diffMemoryDelete(item: MemoryItem, expectedRevision: string): DryRunResult {
  const before: Record<string, unknown> = {
    id: item.id,
    key: item.key,
    content: item.content,
    tags: Array.isArray(item.tags) ? item.tags : [],
    agent_id: item.agent_id,
  };
  return withRevision(
    {
      dry_run: true,
      applied: false,
      would_write: true,
      action: "delete_memory",
      changes: [
        {
          op: "remove",
          summary: `Delete memory #${item.id} key "${item.key ?? ""}".`,
          before,
          after: null,
        },
      ],
      affected: [before],
    },
    expectedRevision,
  );
}

function formatDetail(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  return String(value);
}

/**
 * Lines the confirm dialog shows. They come from the preview, not a second diff.
 * Every key on the record is shown, including nulls. An allowlist dropped
 * `color`, `short`, `blockedLabel`, and `position`, so a one-field repo edit
 * named the field and then hid the values.
 */
export function changeDetails(change: DryRunChange): string[] {
  const lines = [change.summary];
  const side = (label: string, value: Record<string, unknown> | null) => {
    if (!value) return;
    const parts: string[] = [];
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      parts.push(`${key}: ${formatDetail(value[key])}`);
    }
    if (parts.length) lines.push(`${label}: ${parts.join("; ")}`);
  };
  side("Before", change.before);
  side("After", change.after);
  return lines;
}
