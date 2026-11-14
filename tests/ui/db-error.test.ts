import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NeonDbError } from "@neondatabase/serverless";
import { describeDbError, sanitizeErrorMessage } from "../../src/lib/db-error";
import { UnknownWriteOutcome } from "../../src/lib/write-outcome";

// Synthetic values only.
const NEON_PASSWORD = "npg_Synth3ticPw42";
const URL = `postgresql://ak_owner:${NEON_PASSWORD}@ep-synthetic-000000.us-east-2.aws.neon.tech/neondb?sslmode=require`;

describe("sanitizeErrorMessage", () => {
  it("replaces connection and other URLs", () => {
    for (const url of [URL, "postgres://u:p@localhost:5432/db", "https://ep-synthetic.neon.tech/sql", "wss://ep-synthetic.neon.tech/v2"]) {
      const out = sanitizeErrorMessage(`could not connect to ${url}, retrying`);
      assert.equal(out, "could not connect to [url], retrying");
    }
  });

  it("replaces Neon passwords, password pairs and user:password@ pairs", () => {
    assert.equal(sanitizeErrorMessage(`bad password ${NEON_PASSWORD}`), "bad password [redacted]");
    assert.equal(
      sanitizeErrorMessage("host=db user=ak password=hunter2 dbname=neondb"),
      "host=db user=ak password=[redacted] dbname=neondb",
    );
    assert.equal(sanitizeErrorMessage(`password: "two words"`), "password=[redacted]");
    assert.equal(sanitizeErrorMessage("login ak_owner:s3cret@db.example:5432 refused"), "login [redacted]@db.example:5432 refused");
  });

  it("replaces bearer tokens, agent credentials and known token shapes", () => {
    assert.equal(sanitizeErrorMessage("Authorization: Bearer short.tok"), "Authorization: Bearer [redacted]");
    assert.equal(sanitizeErrorMessage("token akc_AbC-123_xyz rejected"), "token [redacted] rejected");
    assert.equal(sanitizeErrorMessage("key ghp_abcdefghijklmnopqrstuvwxyz0123"), "key [redacted]");
  });

  it("keeps ordinary Postgres messages readable", () => {
    const msg = 'password authentication failed for user "ak_owner"';
    assert.equal(sanitizeErrorMessage(msg), msg);
    assert.equal(sanitizeErrorMessage('relation "agent_credentials" does not exist'), 'relation "agent_credentials" does not exist');
  });

  it("collapses to one line and caps the length", () => {
    assert.equal(sanitizeErrorMessage("first\n  second\tthird"), "first second third");
    const long = sanitizeErrorMessage("x".repeat(1000));
    assert.equal(long, `${"x".repeat(300)}…`);
    assert.equal(sanitizeErrorMessage("abcdef", 3), "abc…");
  });

  it("stays fast on a huge message with no spaces", () => {
    const huge = `a:${"b".repeat(200_000)}${NEON_PASSWORD}`;
    const started = Date.now();
    const out = sanitizeErrorMessage(huge);
    assert.ok(Date.now() - started < 500, "sanitizing took too long");
    assert.equal(out.length, 301);
  });
});

describe("describeDbError", () => {
  it("logs the name, the SQLSTATE and the redacted message, never the detail", () => {
    const err = new NeonDbError(`relation "agent_credentials" does not exist at ${URL}`);
    err.code = "42P01";
    err.detail = "Key (token_hash)=(0123abcd) already exists.";
    err.hint = "secret hint";
    const line = describeDbError(err);
    assert.equal(line, 'NeonDbError code=42P01 message="relation \\"agent_credentials\\" does not exist at [url]"');
    assert.equal(line.includes("npg_"), false);
    assert.equal(line.includes("token_hash"), false);
    assert.equal(line.includes("secret hint"), false);
  });

  it("follows cause and sourceError and skips a repeated message", () => {
    const neon = new NeonDbError("terminating connection due to administrator command");
    neon.code = "57P01";
    const wrapped = new UnknownWriteOutcome(neon);
    assert.equal(
      describeDbError(wrapped),
      'UnknownWriteOutcome message="terminating connection due to administrator command" caused by NeonDbError code=57P01',
    );

    const source = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const viaSource = new NeonDbError("Error connecting to database: fetch failed");
    viaSource.sourceError = source;
    assert.match(describeDbError(viaSource), /caused by Error code=ECONNREFUSED message="connect ECONNREFUSED"$/);
  });

  it("stops at three errors and on a cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    const c = new Error("c", { cause: b });
    const d = new Error("d", { cause: c });
    assert.equal(describeDbError(d), 'Error message="d" caused by Error message="c" caused by Error message="b"');
    const loop = new Error("loop");
    (loop as { cause?: unknown }).cause = loop;
    assert.equal(describeDbError(loop), 'Error message="loop"');
  });

  it("drops a code that is not a plain identifier or that looks like a secret", () => {
    for (const code of ["has space", NEON_PASSWORD, "x".repeat(41)]) {
      const err = Object.assign(new Error("boom"), { code });
      assert.equal(describeDbError(err), 'Error message="boom"');
    }
    assert.equal(describeDbError(Object.assign(new Error("boom"), { code: 23505 })), 'Error code=23505 message="boom"');
  });

  it("handles values that are not errors", () => {
    assert.equal(describeDbError(undefined), "error");
    assert.equal(describeDbError(null), "error");
    assert.equal(describeDbError(`failed at ${URL}`), 'error message="failed at [url]"');
    assert.equal(describeDbError({ code: "08006", message: "connection failure" }), 'error code=08006 message="connection failure"');
  });
});
