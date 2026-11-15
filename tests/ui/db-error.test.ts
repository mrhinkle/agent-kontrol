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

  // Review findings on PR #157 (CodeRabbit and Codex at 425da1e).
  it("replaces URL credentials that hold parentheses, quotes or a slash", () => {
    assert.equal(sanitizeErrorMessage("connect postgres://u:pw(S3cret)@db.example/db failed"), "connect [url] failed");
    assert.equal(sanitizeErrorMessage(`connect postgres://u:pa"ss@db.example/db failed`), "connect [url] failed");
    assert.equal(sanitizeErrorMessage("(see postgres://db.example/db)"), "(see [url])");
    assert.equal(sanitizeErrorMessage("login user:pa/ss@db failed"), "login [redacted]@db failed");
    assert.equal(sanitizeErrorMessage(`login user:pa"ss@db failed`), "login [redacted]@db failed");
  });

  it("replaces passwords under quoted and prefixed keys", () => {
    assert.equal(sanitizeErrorMessage('bad config {"password":"hunter2"}'), 'bad config {"password"=[redacted]}');
    assert.equal(sanitizeErrorMessage("bad config {'pwd': 'hunter2'}"), "bad config {'pwd'=[redacted]}");
    assert.equal(
      sanitizeErrorMessage("PGPASSWORD=hunter2 db_password=hunter3"),
      "PGPASSWORD=[redacted] db_password=[redacted]",
    );
  });

  // CodeRabbit re-review of PR #157 at 36aea54 (backslash before a line break),
  // plus a sweep of other encodings run before pushing the fix.
  it("leaves no part of a secret in any of these encodings", () => {
    // Every input hides the pieces SECa and RETb (or their base64); none may survive.
    const cases: Record<string, string> = {
      plain: "password=SECaRETb",
      colon: "password: SECaRETb",
      "spaced, quoted": 'password = "SECa RETb"',
      json: JSON.stringify({ password: "SECa RETb" }),
      "json, space after colon": '{"password": "SECa RETb"}',
      "json, escaped quote": JSON.stringify({ password: 'SECa"RETb' }),
      "single quotes, escaped quote": "{'password': 'SECa\\'RETb'}",
      "backslash then LF": 'password="SECa\\\nRETb"',
      "backslash then CRLF": 'password="SECa\\\r\nRETb"',
      "json inside json": JSON.stringify({ msg: JSON.stringify({ password: "SECa RETb" }) }),
      "json inside json, escaped quote": JSON.stringify({ msg: JSON.stringify({ password: 'SECa"RETb' }) }),
      PGPASSWORD: "PGPASSWORD=SECaRETb",
      sslpassword: "sslpassword=SECaRETb",
      "pwd key": '{"pwd":"SECa RETb"}',
      "url, parenthesis": "postgres://u:SECa(RETb@h/db",
      "url, quote": 'postgres://u:SECa"RETb@h/db',
      "url, query": "postgres://h/db?password=SECaRETb",
      // Codex round 4 at 6af4be5: the URL replacement ate the key and stopped at "(".
      "url, query, parentheses": "postgres://db.example/db?password=(SECaRETb)",
      "url, query, quotes": 'postgres://db.example/db?password="SECaRETb"',
      "url, query, brackets": "postgres://db.example/db?password=[SECa]{RETb}",
      // Codex round 5 at 960ec19, and the same "stopped at a character" class.
      "userinfo, @ in password": "u:SECa@RETb@db",
      "password, comma": "password=SECa,RETb",
      "password, ampersand": "password=SECa&RETb",
      "password, parentheses": "password=(SECa)RETb",
      "bearer, comma": "Bearer SECa,RETb",
      "authorization, basic, comma": "Authorization: Basic SECa,RETb",
      "url in json inside json": JSON.stringify({ msg: JSON.stringify({ url: "postgres://u:SECa@h/db?x=RETb" }) }),
      "userinfo, slash": "u:SECa/RETb@h",
      "authorization, bearer": "Authorization: Bearer SECaRETb",
      "authorization, basic": "Authorization: Basic U0VDYVJFVGI6eA==",
      "authorization, json": JSON.stringify({ authorization: "Basic U0VDYVJFVGI6eA==" }),
    };
    for (const [name, input] of Object.entries(cases)) {
      const out = sanitizeErrorMessage(`before ${input} after`);
      assert.equal(/SECa|RETb|U0VDYVJFVGI6eA/.test(out), false, `${name}: ${out}`);
      assert.match(out, /^before /, `${name}: ${out}`);
    }
  });

  // CodeRabbit re-review of PR #157 at 91df6c6.
  it("replaces quoted passwords that hold escaped quotes", () => {
    const json = JSON.stringify({ password: 'alpha"bravoSecret', user: "ak" });
    assert.equal(sanitizeErrorMessage(`bad config ${json}`), 'bad config {"password"=[redacted],"user":"ak"}');
    assert.equal(sanitizeErrorMessage("bad config {'password': 'it\\'sSecret'}"), "bad config {'password'=[redacted]}");

    const cut = sanitizeErrorMessage(`https://db.example/${"x".repeat(1940)} password="alpha\\"bravo charlieSecretDelta"`);
    assert.equal(/alpha|bravo|charlie|Secret/.test(cut), false, cut);
  });

  it("leaves no fragment of a secret that the input bound cuts in half", () => {
    const quoted = sanitizeErrorMessage(`https://db.example/${"x".repeat(1940)} password="alpha bravoCharlieDeltaEchoFoxtrotGolf"`);
    assert.equal(quoted.includes("alpha"), false);
    assert.equal(quoted.includes("bravo"), false);
    assert.equal(quoted, "[url] password=[redacted]");

    for (let pad = 1940; pad < 1990; pad += 1) {
      const out = sanitizeErrorMessage(`https://db.example/${"x".repeat(pad)} ak_owner:s3cretpassword@db.example`);
      assert.equal(/s3c|cret|pass|word/.test(out), false, `pad ${pad}: ${out}`);
    }
  });

  it("replaces bearer tokens, agent credentials and known token shapes", () => {
    assert.equal(sanitizeErrorMessage("Authorization: Bearer short.tok"), "Authorization=[redacted]");
    assert.equal(sanitizeErrorMessage("sent Bearer short.tok upstream"), "sent Bearer [redacted] upstream");
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
    // Bounded, this takes milliseconds; unbounded, the userinfo pattern alone takes minutes.
    assert.ok(Date.now() - started < 2000, "sanitizing took too long");
    // One 200,000-character token: the cut drops it whole rather than log half of it.
    assert.equal(out, "…");

    const words = sanitizeErrorMessage(`${"word ".repeat(1000)}${NEON_PASSWORD}`);
    assert.equal(words.length, 301);
    assert.equal(words.includes("npg_"), false);
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

  it("drops a name that looks like a secret", () => {
    for (const name of ["akc_liveSecret", NEON_PASSWORD, "has space"]) {
      const err = new Error("boom");
      err.name = name;
      assert.equal(describeDbError(err), 'error message="boom"');
    }
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
