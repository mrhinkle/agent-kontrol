/**
 * Synthetic unit tests for two-way messaging helpers (no DB, no secrets).
 */
import assert from "node:assert/strict";
import {
  deliveryStateFor,
  isUnreadOutbound,
  normalizeDirection,
  resolveThreadId,
  type MessageLike,
} from "../src/lib/message-helpers";
import {
  isMessagesSetupError,
  isUndefinedColumnError,
  isUndefinedTableError,
} from "../src/lib/message-errors";

function msg(partial: Partial<MessageLike> & { id: number }): MessageLike {
  return {
    direction: "inbound",
    delivered_at: null,
    acked_at: null,
    in_reply_to: null,
    thread_id: String(partial.id),
    created_at: `2026-10-05T12:00:${String(partial.id).padStart(2, "0")}Z`,
    ...partial,
  };
}

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    throw e;
  }
}

check("normalizeDirection defaults inbound", () => {
  assert.equal(normalizeDirection(undefined), "inbound");
  assert.equal(normalizeDirection("outbound"), "outbound");
  assert.equal(normalizeDirection("nope"), "inbound");
});

check("queued → delivered → replied", () => {
  const inbound = msg({ id: 1, direction: "inbound" });
  assert.equal(deliveryStateFor(inbound, [inbound]), "queued");

  const delivered = msg({
    id: 1,
    direction: "inbound",
    delivered_at: "2026-10-05T12:01:00Z",
    acked_at: "2026-10-05T12:01:00Z",
  });
  assert.equal(deliveryStateFor(delivered, [delivered]), "delivered");

  const reply = msg({
    id: 2,
    direction: "outbound",
    in_reply_to: 1,
    thread_id: "1",
    created_at: "2026-10-05T12:02:00Z",
  });
  assert.equal(deliveryStateFor(delivered, [delivered, reply]), "replied");
  assert.equal(deliveryStateFor(reply, [delivered, reply]), "delivered");
});

check("resolveThreadId", () => {
  assert.equal(resolveThreadId(null), null);
  assert.equal(resolveThreadId({ id: 9, thread_id: "1" }), "1");
  assert.equal(resolveThreadId({ id: 9, thread_id: null }), "9");
});

check("isUnreadOutbound", () => {
  assert.equal(isUnreadOutbound({ direction: "outbound", read_by_dashboard_at: null }), true);
  assert.equal(
    isUnreadOutbound({ direction: "outbound", read_by_dashboard_at: "2026-10-05T12:00:00Z" }),
    false
  );
  assert.equal(isUnreadOutbound({ direction: "inbound", read_by_dashboard_at: null }), false);
});

check("setup error detectors", () => {
  assert.equal(isUndefinedTableError({ code: "42P01" }), true);
  assert.equal(isUndefinedColumnError({ code: "42703" }), true);
  assert.equal(isMessagesSetupError({ code: "42703" }), true);
  assert.equal(
    isUndefinedColumnError({ message: 'column "direction" does not exist' }),
    true
  );
  assert.equal(isMessagesSetupError({ code: "23505" }), false);
});

console.log(`\n${passed} message helper tests passed`);
