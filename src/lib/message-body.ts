/**
 * Shared cap for an inbound message body.
 * POST /api/messages and the send_message tool both call this so the limit
 * cannot drift. The reply route is unchanged.
 * Empty is rejected here. The REST route still reports a missing body as
 * missing_field before it asks about length. Whitespace is kept.
 */
export const MESSAGE_BODY_MAX = 8000;

/** Null when the body can be stored. */
export function messageBodyProblem(body: unknown): string | null {
  if (typeof body !== "string" || body.length < 1) return "body is required";
  if (body.length > MESSAGE_BODY_MAX) {
    return `body must be at most ${MESSAGE_BODY_MAX} characters.`;
  }
  return null;
}
