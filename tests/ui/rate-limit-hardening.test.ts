import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientIp, createLimiter } from "../../src/lib/rate-limit";

const WINDOW_MS = 10 * 60 * 1000;

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/login", { method: "POST", headers });
}

describe("eviction", () => {
  it("keeps a locked-out key while evicting low-count keys", () => {
    let t = 0;
    const limiter = createLimiter({ max: 5, windowMs: WINDOW_MS, now: () => t++ });

    // Lock out "victim": 5 failures reach the max.
    for (let i = 0; i < 5; i++) limiter.fail("victim");
    assert.equal(limiter.check("victim").allowed, false);

    // Overflow the tracked-key map: 10001 distinct keys that each fail once.
    for (let i = 0; i < 10001; i++) limiter.fail(`other-${i}`);

    // The locked-out key must survive eviction.
    assert.equal(limiter.check("victim").allowed, false);

    // The oldest low-count key ("other-0") was evicted instead: it now holds
    // only the 4 failures recorded below, so it is not locked out. Had it been
    // kept, it would have 5 failures and be locked out.
    for (let i = 0; i < 4; i++) limiter.fail("other-0");
    assert.equal(limiter.check("other-0").allowed, true);

    // The locked-out key is still locked out.
    assert.equal(limiter.check("victim").allowed, false);
  });
});

describe("clientIp", () => {
  it("prefers x-vercel-forwarded-for over x-real-ip and x-forwarded-for", () => {
    const req = requestWith({
      "x-vercel-forwarded-for": "1.2.3.4, 5.6.7.8",
      "x-real-ip": "9.9.9.9",
      "x-forwarded-for": "8.8.8.8",
    });
    assert.equal(clientIp(req), "1.2.3.4");
  });

  it("prefers x-real-ip over x-forwarded-for", () => {
    const req = requestWith({
      "x-real-ip": "9.9.9.9",
      "x-forwarded-for": "8.8.8.8",
    });
    assert.equal(clientIp(req), "9.9.9.9");
  });

  it("uses the first entry of x-forwarded-for", () => {
    const req = requestWith({ "x-forwarded-for": "8.8.8.8, 1.2.3.4" });
    assert.equal(clientIp(req), "8.8.8.8");
  });

  it("falls back to 'unknown' when no forwarding headers are present", () => {
    assert.equal(clientIp(requestWith({})), "unknown");
  });
});

describe("reservation pattern", () => {
  it("blocks the 6th check after 5 synchronous (check, fail) reservations", () => {
    let t = 0;
    const limiter = createLimiter({ max: 5, windowMs: WINDOW_MS, now: () => t++ });

    for (let i = 0; i < 5; i++) {
      assert.equal(limiter.check("203.0.113.7").allowed, true);
      // Reserve synchronously — no await between check and fail.
      limiter.fail("203.0.113.7");
    }

    const sixth = limiter.check("203.0.113.7");
    assert.equal(sixth.allowed, false);
    assert.ok(sixth.retryAfterSec >= 1);

    // A successful attempt releases the reservation.
    limiter.reset("203.0.113.7");
    assert.equal(limiter.check("203.0.113.7").allowed, true);
  });
});
