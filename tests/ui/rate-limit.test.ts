import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientIp, createLimiter } from "../../src/lib/rate-limit";

describe("createLimiter", () => {
  it("blocks after max failures and reports retryAfterSec >= 1", () => {
    let t = 0;
    const limiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000, now: () => t });
    for (let i = 0; i < 5; i++) {
      limiter.fail("ip1");
      t += 1000;
    }
    const r = limiter.check("ip1");
    assert.equal(r.allowed, false);
    assert.ok(r.retryAfterSec >= 1);
  });

  it("allows again after the window expires", () => {
    let t = 0;
    const limiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000, now: () => t });
    for (let i = 0; i < 5; i++) limiter.fail("ip1");
    t = 10 * 60 * 1000 + 1;
    assert.equal(limiter.check("ip1").allowed, true);
  });

  it("reset clears failures", () => {
    const limiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000, now: () => 0 });
    for (let i = 0; i < 5; i++) limiter.fail("ip1");
    assert.equal(limiter.check("ip1").allowed, false);
    limiter.reset("ip1");
    assert.equal(limiter.check("ip1").allowed, true);
  });

  it("keys are independent", () => {
    const limiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000, now: () => 0 });
    for (let i = 0; i < 5; i++) limiter.fail("ip1");
    assert.equal(limiter.check("ip1").allowed, false);
    assert.equal(limiter.check("ip2").allowed, true);
  });

  it("retryAfterSec counts down as time passes", () => {
    let t = 0;
    const limiter = createLimiter({ max: 5, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 5; i++) limiter.fail("ip1");
    const a = limiter.check("ip1").retryAfterSec;
    t += 30_000;
    const b = limiter.check("ip1").retryAfterSec;
    assert.ok(b < a);
    assert.ok(b >= 1);
  });
});

describe("clientIp", () => {
  it("uses first x-forwarded-for entry, trimmed", () => {
    const req = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" },
    });
    assert.equal(clientIp(req), "1.2.3.4");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("http://localhost/x", { headers: { "x-real-ip": "9.9.9.9" } });
    assert.equal(clientIp(req), "9.9.9.9");
  });

  it("returns 'unknown' when no headers", () => {
    assert.equal(clientIp(new Request("http://localhost/x")), "unknown");
  });
});
