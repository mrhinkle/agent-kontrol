import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
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
      // The whole token goes, trailing comma included: giving punctuation back can leak a secret's last character.
      assert.equal(out, "could not connect to [url] retrying");
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
    assert.equal(sanitizeErrorMessage("(see postgres://db.example/db)"), "(see [url]");
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
      // Codex round 6 at 84baae6: trailing punctuation that belongs to the secret.
      "password, trailing bang": "password=SECaRETb!",
      "url, trailing bang": "postgres://db/db?password=SECaRETb!",
      "bearer, trailing bang": "Bearer SECaRETb!",
      "npg_, punctuation inside": "npg_SECa!RETb",
      "akc_, punctuation inside": "akc_SECa.RETb",
      "userinfo, odd host": "u:SECaRETb@-db",
      "userinfo, no host": "u:SECaRETb@ next",
      // CodeRabbit re-review at bdf454e: pass order, and Digest parameters.
      "quoted password holding @ and a space": 'password:"SECa@db RETb"',
      "authorization, digest": 'Authorization: Digest username="SECa", nonce="RETb", response="RETb0123"',
      // Other keys from SECRET_KEY in ./traces.ts.
      "token key": "token=SECaRETb",
      "secret key": "secret: SECaRETb",
      "api_key key": "api_key=SECaRETb",
      "x-api-key header": "X-Api-Key: SECaRETb",
      "private_key json": JSON.stringify({ private_key: "SECa RETb" }),
      "credential key": "credential=SECaRETb",
      "cookie header": "Cookie: session=SECa; other=RETb",
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

  // CodeRabbit re-review of PR #157 at 6e27b5a: in compact JSON an unquoted
  // value (`"token":null`) ran on into the next key and left the rest of that
  // key's value. Swept here across keys, first values, second fields and encodings.
  it("leaves no part of a secret in the field after an unquoted value", () => {
    const seconds: Array<[string, string]> = [
      ["password", "SECa RETb"],
      ["authorization", "Basic SECa RETb"],
      ["authorization", 'Digest username="u", response="SECa RETb"'],
      ["cookie", "a=SECa; b=RETb"],
      ["note", "Bearer SECaRETb"],
      ["note", "via npg_SECaRETb"],
      ["note", "via akc_SECaRETb"],
      ["dsn", "postgresql://u:SECaRETb@h/db"],
      ["dsn", "u:SECaRETb@h"],
    ];
    let checked = 0;
    for (const firstKey of ["token", "password", "api_key", "secret"]) {
      for (const firstValue of [null, 123, true]) {
        for (const [key, value] of seconds) {
          const fields = { [firstKey]: firstValue, [key]: value };
          const encodings: Record<string, string> = {
            json: JSON.stringify(fields),
            "json, spaced": JSON.stringify(fields, null, 1).replace(/\n/g, ""),
            "json inside json": JSON.stringify({ msg: JSON.stringify(fields) }),
            python: `{'${firstKey}': ${firstValue === null ? "None" : String(firstValue)}, '${key}': '${value.replace(/'/g, "\\'")}'}`,
            "key=value": `${firstKey}=${String(firstValue)},${key}="${value.replace(/"/g, '\\"')}"`,
          };
          for (const [name, input] of Object.entries(encodings)) {
            const out = sanitizeErrorMessage(input);
            assert.equal(/SECa|RETb/.test(out), false, `${name}: ${input} -> ${out}`);
            checked += 1;
          }
        }
      }
    }
    assert.equal(checked, 540);
  });

  it("redacts a field once and keeps what follows it", () => {
    assert.equal(
      sanitizeErrorMessage(JSON.stringify({ authorization: "Basic SECa RETb", user: "ak" })),
      '{"authorization"=[redacted],"user":"ak"}',
    );
    assert.equal(sanitizeErrorMessage(JSON.stringify({ password: "SECa RETb", user: "ak" })), '{"password"=[redacted],"user":"ak"}');
    assert.equal(
      sanitizeErrorMessage(JSON.stringify({ token: null, password: "SECa RETb" })),
      '{"token"=[redacted],"password"=[redacted]}',
    );
    // The internal stand-in for a redacted value cannot be forged by the message.
    assert.equal(sanitizeErrorMessage("password=SECaRETb"), "password=[redacted]");
    assert.equal(sanitizeErrorMessage("Authorization: SECa RETb"), "Authorization=[redacted]");
    assert.equal(sanitizeErrorMessage('token=[url]{"a":"SECa RETb"}'), "token=[redacted]");
  });

  // Codex review of PR #157 at 1030f65: a bare value under a secret key in
  // compact JSON swallowed the next field, so the diagnosis was lost.
  it("keeps the next field readable after a literal under a secret key", () => {
    assert.equal(
      sanitizeErrorMessage(JSON.stringify({ token: null, message: 'password authentication failed for user "ak"' })),
      '{"token"=[redacted],"message":"password authentication failed for user \\"ak\\""}',
    );
    const diagnosis = 'password authentication failed for user "ak"';
    let checked = 0;
    for (const key of ["token", "password", "api_key", "secret", "credential", "authorization", "cookie"]) {
      for (const literal of [null, 123, -1.5, true, false]) {
        const fields = { [key]: literal, message: diagnosis };
        const python = literal === null ? "None" : literal === true ? "True" : literal === false ? "False" : String(literal);
        const encodings: Record<string, string> = {
          json: JSON.stringify(fields),
          "json, spaced": JSON.stringify(fields, null, 1).replace(/\n/g, ""),
          "json inside json": JSON.stringify({ msg: JSON.stringify(fields) }),
          python: `{'${key}': ${python}, 'message': '${diagnosis}'}`,
        };
        for (const [name, input] of Object.entries(encodings)) {
          const out = sanitizeErrorMessage(input);
          assert.ok(out.includes("authentication failed for user"), `${name}: ${input} -> ${out}`);
          checked += 1;
        }
      }
    }
    assert.equal(checked, 140);
  });

  // Codex review of PR #157 at 8ae1d22: a literal under a quoted key ended at
  // any comma, so malformed text such as `{"password":123,SECa RETb}` kept the
  // rest. A literal now ends early only before a real next field or `}`/`]`,
  // and any other bare value under a quoted key is redacted to the end of its line.
  it("redacts a malformed bare value under a quoted key to the end of its line", () => {
    for (const input of [
      '{"password":123,SECa RETb}',
      '{"password":123,SECaRETb}',
      '{"token":null,SECa}',
      '{"password":true,"SECa"}',
      "{'pwd': None, SECaRETb}",
      '{"password":-1.5e3,SECaRETb}',
      '"password":123,SECaRETb',
      '{"secret":false , SECa RETb}',
      '{\\"token\\":null,SECa RETb}',
      '{"authorization":null,SECa RETb}',
    ]) {
      const out = sanitizeErrorMessage(`${input}\nnext line`);
      assert.equal(/SECa|RETb/.test(out), false, `${input} -> ${out}`);
      assert.match(out, /next line$/, `${input} -> ${out}`);
    }
    assert.equal(sanitizeErrorMessage('{"token":5,\n  "message": "ok"}'), '{"token"=[redacted], "message": "ok"}');
    assert.equal(sanitizeErrorMessage('column "token" does not exist'), 'column "token" does not exist');
  });

  // Codex reviews of PR #157 at 929bab6 and dff78ba: the rule above also
  // caught a quoted key in prose and hid the rest of the diagnosis. It now
  // applies only to a literal glued to more text; in prose the next word goes,
  // as for any bare value.
  it("keeps prose that quotes a secret key readable", () => {
    assert.equal(
      sanitizeErrorMessage('invalid JSON near "token": unexpected character at position 12'),
      'invalid JSON near "token"=[redacted] character at position 12',
    );
    assert.equal(
      sanitizeErrorMessage('invalid JSON, "token": unexpected character at position 12'),
      'invalid JSON, "token"=[redacted] character at position 12',
    );
    assert.equal(sanitizeErrorMessage('"token": 12 characters too long'), '"token"=[redacted] characters too long');
    assert.equal(sanitizeErrorMessage('bad "token": nonexistent key'), 'bad "token"=[redacted] key');
    assert.equal(
      sanitizeErrorMessage('Unexpected token "password": expected string at 4'),
      'Unexpected token "password"=[redacted] string at 4',
    );
    // A literal followed by a well-formed field is two fields, as in valid JSON:
    // the same shape as `{"token":null,"message":"password authentication failed"}`,
    // which must stay readable.
    assert.equal(
      sanitizeErrorMessage('{"password":123,"message":"connection reset"}'),
      '{"password"=[redacted],"message":"connection reset"}',
    );
  });

  // Found while fixing the Codex finding at 1030f65: an object or array under a secret
  // key holds quoted text with spaces, so it is redacted to the end of the message.
  it("leaves no part of a secret in an object or array under a secret key", () => {
    let checked = 0;
    for (const key of ["token", "password", "secret", "api_key", "authorization"]) {
      for (const nested of [{ access: "SECa RETb" }, ["SECa RETb"], { a: { b: "SECa RETb" } }, [{ v: "SECa RETb" }]]) {
        const fields = { [key]: nested, user: "ak" };
        const encodings: Record<string, string> = {
          json: JSON.stringify(fields),
          "json, spaced": JSON.stringify(fields, null, 1).replace(/\n/g, ""),
          "json inside json": JSON.stringify({ msg: JSON.stringify(fields) }),
          inspect: inspect(fields, { breakLength: Infinity, depth: 5 }),
        };
        for (const [name, input] of Object.entries(encodings)) {
          const out = sanitizeErrorMessage(input);
          assert.equal(/SECa|RETb/.test(out), false, `${name}: ${input} -> ${out}`);
          checked += 1;
        }
      }
    }
    assert.equal(checked, 80);
  });

  // CodeRabbit re-review of PR #157 at 10a0848: a URL ran on into the next
  // field (`{"dsn":"postgresql://h/db","password":"a b"}`), and a nested value
  // pretty-printed over several lines kept its inner lines. Swept here across
  // first fields, secret fields and layouts, multi-line ones included.
  it("leaves no part of a secret after a URL, a bearer token or a literal, in any layout", () => {
    assert.equal(
      sanitizeErrorMessage(JSON.stringify({ dsn: "postgresql://h/db", password: "SECa RETb" })),
      '{"dsn":"[url]',
    );
    assert.equal(sanitizeErrorMessage(JSON.stringify({ token: { access: "SECa RETb" } }, null, 2)), '{ "token"=[redacted]');
    const firsts: Array<[string, unknown]> = [
      ["token", null],
      ["password", 123],
      ["secret", true],
      ["dsn", "postgresql://h/db"],
      ["dsn", "postgresql://u:pw@h/db?sslmode=require"],
      ["message", "failed at postgres://h/db"],
      ["note", "Bearer abc"],
      ["authorization", null],
    ];
    const seconds: Array<[string, unknown]> = [
      ["password", "SECa RETb"],
      ["authorization", "Basic SECa RETb"],
      ["authorization", 'Digest username="u", response="SECa RETb"'],
      ["cookie", "a=SECa; b=RETb"],
      ["note", "Bearer SECaRETb"],
      ["note", "via npg_SECaRETb"],
      ["note", "via akc_SECaRETb"],
      ["dsn", "postgresql://u:SECaRETb@h/db"],
      ["dsn", "u:SECaRETb@h"],
      ["token", { access: "SECa RETb" }],
      ["secret", ["SECa RETb"]],
      ["api_key", { a: { b: "SECa RETb" } }],
      ["authorization", { scheme: "Basic", value: "SECa RETb" }],
    ];
    const python = (value: unknown): string => {
      if (value === null) return "None";
      if (typeof value === "boolean") return value ? "True" : "False";
      if (typeof value === "number") return String(value);
      if (typeof value === "string") return `'${value.replace(/'/g, "\\'")}'`;
      if (Array.isArray(value)) return `[${value.map(python).join(", ")}]`;
      return `{${Object.entries(value as object).map(([k, v]) => `'${k}': ${python(v)}`).join(", ")}}`;
    };
    let checked = 0;
    for (const [firstKey, firstValue] of firsts) {
      for (const [key, value] of seconds) {
        if (firstKey === key) continue;
        const fields = { [firstKey]: firstValue, [key]: value };
        const encodings: Record<string, string> = {
          json: JSON.stringify(fields),
          "json, spaced": JSON.stringify(fields, null, 1).replace(/\n/g, ""),
          "json, pretty": JSON.stringify(fields, null, 2),
          "json inside json": JSON.stringify({ msg: JSON.stringify(fields) }),
          python: python(fields),
          "inspect, one line": inspect(fields, { breakLength: Infinity, depth: 5 }),
          "inspect, multiline": inspect(fields, { breakLength: 1, depth: 5 }),
        };
        for (const [name, input] of Object.entries(encodings)) {
          const out = sanitizeErrorMessage(input);
          assert.equal(/SECa|RETb/.test(out), false, `${name}: ${JSON.stringify(input)} -> ${out}`);
          checked += 1;
        }
      }
    }
    assert.equal(checked, 637);
  });

  it("redacts the whole token, trailing punctuation included", () => {
    assert.equal(sanitizeErrorMessage("password=Secret! then"), "password=[redacted] then");
    assert.equal(sanitizeErrorMessage("postgres://db/db?password=Secret! then"), "[url] then");
    assert.equal(sanitizeErrorMessage("Bearer Secret! then"), "Bearer [redacted] then");
    // A header value runs to the end of its line (Digest parameters hold spaces and commas).
    assert.equal(sanitizeErrorMessage("Authorization: Basic Secret! then\nnext line"), "Authorization=[redacted] next line");
    assert.equal(sanitizeErrorMessage("npg_Sec!ret) then"), "[redacted] then");
    assert.equal(sanitizeErrorMessage("u:Secret!@-db then"), "[redacted]@-db then");
  });

  it("leaves ordinary Postgres and driver messages as they are", () => {
    for (const msg of [
      "Unexpected token } in JSON at position 5",
      'duplicate key value violates unique constraint "agent_credentials_token_hash_key"',
      "Key (token_hash)=(0123abcd) already exists.",
      'password authentication failed for user "ak_owner"',
      'column "token_prefix" of relation "agent_credentials" does not exist',
      "credential_store_unavailable",
      "Error connecting to database: TypeError: fetch failed",
    ]) {
      assert.equal(sanitizeErrorMessage(msg), msg);
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

  // CodeRabbit re-review of PR #157 at dffdab6 (outside-diff comment).
  it("redacts a key spelled with JSON unicode escapes as its plain spelling", () => {
    assert.equal(
      sanitizeErrorMessage('{"pass\\u0077ord":"SECa RETb","message":"after"}'),
      '{"password"=[redacted],"message":"after"}',
    );
    assert.equal(
      sanitizeErrorMessage('{"tok\\u0065n":null,"message":"password authentication failed"}'),
      '{"token"=[redacted],"message":"password authentication failed"}',
    );
    assert.equal(sanitizeErrorMessage("via npg\\u005fSECaRETb then"), "via [redacted] then");
    assert.equal(sanitizeErrorMessage("sent \\u0042earer SECaRETb upstream"), "sent Bearer [redacted] upstream");
    // Only key characters are decoded. An escaped quote, backslash, space or
    // marker stays as written, so it cannot end a quoted value early.
    const others = "caf\\u00e9 \\u0022quoted\\u0022 \\uE000 \\u005c tab\\u0009";
    assert.equal(sanitizeErrorMessage(others), others);
    assert.equal(
      sanitizeErrorMessage('{"password":"a\\u0022b c","message":"after"}'),
      '{"password"=[redacted],"message":"after"}',
    );

    const keys = [
      "password", "PGPASSWORD", "db_password", "passwd", "pwd", "secret", "token",
      "api_key", "apikey", "credential", "private_key", "authorization", "cookie",
    ];
    const values: unknown[] = ["SECa RETb", null, 123, { access: "SECa RETb" }, ["SECa RETb"]];
    const escape = (char: string, upper: boolean): string => {
      const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${upper ? hex.toUpperCase() : hex}`;
    };
    let checked = 0;
    for (const key of keys) {
      // Each character escaped on its own (lower- and upper-case hex), then all of them.
      const spellings = [...key].map((char, i) => key.slice(0, i) + escape(char, i % 2 === 1) + key.slice(i + 1));
      spellings.push([...key].map((char) => escape(char, false)).join(""));
      for (const spelled of spellings) {
        const inputs: Array<[string, string]> = [];
        for (const value of values) {
          const fields = { [key]: value, message: "after" };
          const json = JSON.stringify(fields);
          const pretty = JSON.stringify(fields, null, 2);
          inputs.push([json, json], [pretty, pretty], [JSON.stringify({ msg: json }), json]);
        }
        const kv = JSON.stringify({ msg: `${key}=SECaRETb next` });
        inputs.push([kv, kv]);
        for (const [plain, source] of inputs) {
          const escaped = plain === source
            ? plain.split(`"${key}"`).join(`"${spelled}"`).split(`${key}=`).join(`${spelled}=`)
            : JSON.stringify({ msg: source.split(`"${key}"`).join(`"${spelled}"`) });
          assert.notEqual(escaped, plain);
          const out = sanitizeErrorMessage(escaped);
          assert.equal(/SECa|RETb/.test(out), false, `${JSON.stringify(escaped)} -> ${out}`);
          assert.equal(out, sanitizeErrorMessage(plain), JSON.stringify(escaped));
          checked += 1;
        }
      }
    }
    assert.equal(checked, 1840);
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
