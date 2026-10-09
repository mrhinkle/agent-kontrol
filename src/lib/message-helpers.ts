/**
 * Pure helpers for two-way messaging (unit-tested, no DB).
 */

export type MessageDirection = "inbound" | "outbound";

export type DeliveryState = "queued" | "delivered" | "replied";

export interface MessageLike {
  id: number;
  direction: MessageDirection | string | null;
  delivered_at: string | null;
  acked_at: string | null;
  in_reply_to: number | null;
  thread_id: string | null;
  created_at: string;
}

/** Normalize / validate direction. Default inbound (operator → agent). */
export function normalizeDirection(raw: unknown): MessageDirection {
  if (raw === "outbound") return "outbound";
  return "inbound";
}

/**
 * Delivery state for an inbound (operator→agent) message, given the full thread.
 * - queued: not yet acked/delivered
 * - delivered: agent fetched it, no reply yet
 * - replied: an outbound message references it (in_reply_to) or follows in-thread
 */
export function deliveryStateFor(
  msg: MessageLike,
  thread: MessageLike[]
): DeliveryState {
  const dir = normalizeDirection(msg.direction);
  if (dir === "outbound") {
    // Agent replies are "delivered" to the dashboard once created.
    return "delivered";
  }
  const replied = thread.some(
    (m) =>
      normalizeDirection(m.direction) === "outbound" &&
      (m.in_reply_to === msg.id ||
        (msg.thread_id != null &&
          m.thread_id === msg.thread_id &&
          m.created_at > msg.created_at))
  );
  if (replied) return "replied";
  if (msg.acked_at || msg.delivered_at) return "delivered";
  return "queued";
}

/** Pick thread_id for a new reply given an optional parent. */
export function resolveThreadId(parent: {
  id: number;
  thread_id: string | null;
} | null): string | null {
  if (!parent) return null; // caller sets to own id after insert
  return parent.thread_id ?? String(parent.id);
}

export function isUnreadOutbound(msg: {
  direction: string | null;
  read_by_dashboard_at: string | null;
}): boolean {
  return normalizeDirection(msg.direction) === "outbound" && !msg.read_by_dashboard_at;
}
