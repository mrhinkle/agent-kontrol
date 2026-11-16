/**
 * Internal queue-episode marker and optional task-ready notice (#78).
 *
 * The episode is the server audit receipt written when a task enters queued.
 * Callers cannot supply the marker. The notice is inserted in that same
 * statement only when AK_TASK_NOTICE_PRODUCER is exactly "1". Unset is off.
 * This module does not register a consumer, provision a credential, or turn
 * the producer on.
 *
 * A claim can see only a bounded recent slice of `events` (events_created_idx
 * on created_at). Missing history is unknown_history, not an older episode.
 * A found episode with no exact gh_events row is unnotified_or_expired.
 * There is no coverage percentage and no permanent-loss claim.
 */

export const TASK_READY_EVENT = "task-ready";
export const TASK_QUEUE_REPO = "agent-kontrol/task-queue";
export const TASK_QUEUE_MARKER = "_ak_task_queue_v1";
export const TASK_NOTICE_VERSION = 1;
export const TASK_NOTICE_PRODUCER_ENV = "AK_TASK_NOTICE_PRODUCER";

/** Newest audit rows read for one claim. Uses events_created_idx. */
export const QUEUE_EPISODE_SCAN_LIMIT = 500;
/** Matches gh_events retention. An older episode is not guessed. */
export const QUEUE_EPISODE_WINDOW_DAYS = 30;

const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;

export class ReservedQueueMarkerError extends Error {
  readonly fields = { detail: "The reserved queue marker cannot be supplied by a caller." };

  constructor() {
    super("The reserved queue marker cannot be supplied by a caller.");
    this.name = "ReservedQueueMarkerError";
  }
}

/** Default off. Only the exact value "1" enables the producer. */
export function taskNoticeProducerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TASK_NOTICE_PRODUCER_ENV] === "1";
}

export function isReservedTaskEvent(event: string): boolean {
  return event === TASK_READY_EVENT;
}

export function isReservedTaskDeliveryId(deliveryId: string): boolean {
  return deliveryId.startsWith("task:ready:");
}

/** Decimal task id and receipt id. The receipt id is events.id for the episode. */
export function taskReadyDeliveryId(taskId: string, receiptId: string): string {
  if (!DECIMAL_ID.test(taskId) || !DECIMAL_ID.test(receiptId)) {
    throw new Error("task and receipt ids must be decimal");
  }
  return `task:ready:${taskId}:${receiptId}`;
}

/** True when a caller-supplied JSON value contains the reserved marker or episode id. */
export function containsReservedQueueMarker(value: unknown): boolean {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === TASK_QUEUE_MARKER || key === "queue_receipt_id") return true;
      stack.push(child);
    }
  }
  return false;
}

export type QueueEvidenceStatus = "notified" | "unnotified_or_expired" | "unknown_history";

export interface QueueEvidence {
  evidence: QueueEvidenceStatus;
  queue_episode: string | null;
  notice_id: string | null;
  notice_at: string | null;
  reason: string;
}

/**
 * Latest scanned episode only. A truncated scan with no match is unknown.
 * A match whose exact notice is absent is not replaced by an older episode.
 */
export function decideQueueEvidence(input: {
  scanned: number;
  scanLimit: number;
  episodeId: string | null;
  noticeId: string | null;
  noticeAt: string | null;
}): QueueEvidence {
  if (input.episodeId) {
    if (!input.noticeId) {
      return {
        evidence: "unnotified_or_expired",
        queue_episode: input.episodeId,
        notice_id: null,
        notice_at: null,
        reason: "notice_absent",
      };
    }
    return {
      evidence: "notified",
      queue_episode: input.episodeId,
      notice_id: input.noticeId,
      notice_at: input.noticeAt,
      reason: "exact_notice",
    };
  }
  if (input.scanned >= input.scanLimit) {
    return {
      evidence: "unknown_history",
      queue_episode: null,
      notice_id: null,
      notice_at: null,
      reason: "audit_window_truncated",
    };
  }
  return {
    evidence: "unknown_history",
    queue_episode: null,
    notice_id: null,
    notice_at: null,
    reason: "no_episode_in_window",
  };
}
