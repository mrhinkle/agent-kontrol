import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { toQuery } from "../../src/lib/sql-template";
import { readBeats, upsertBeat, WatchBeatError, unicodeCodePointLength } from "../../src/lib/watch";

/**
 * Store contract for mrhinkle/agent-kontrol#81. These cases try to break
 * validation and the SQL shape. Database constraints are in test:pg.
 */

const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  setSqlForTests(null);
});

function sqlText(strings: TemplateStringsArray): string {
  return strings.join(" ");
}

describe("watch beats store", () => {
  it("keeps the same watch_beats definition in schema.sql and the changelog migration", () => {
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    const migration = fs.readFileSync("supabase/migrations/20261027_watch_beats.sql", "utf8");
    const apply = fs.readFileSync("scripts/apply-schema.mjs", "utf8");
    for (const sql of [schema, migration]) {
      assert.match(sql, /create table if not exists watch_beats/i);
      assert.match(sql, /source text primary key check \(char_length\(source\) > 0\)/i);
      assert.match(sql, /status text not null check \(status in \('ok', 'held', 'paused', 'stale', 'failing', 'unknown'\)\)/i);
      assert.match(sql, /detail text not null check \(char_length\(detail\) <= 500\)/i);
      assert.match(sql, /beat_at timestamptz not null/i);
      assert.match(sql, /received_at timestamptz not null default now\(\)/i);
    }
    assert.match(apply, /schema\.sql/);
    assert.doesNotMatch(apply, /migrations/);
    assert.equal(upsertBeat.length, 4);
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    assert.equal(unicodeCodePointLength("😀".repeat(500)), 500);
    assert.equal("😀".repeat(500).length, 1000);
    assert.equal(unicodeCodePointLength("e\u0301".repeat(250)), 500);
  });

  it("rejects an invalid status before any query", async () => {
    setSqlForTests(async () => {
      throw new Error("SQL must not run");
    });
    for (const status of ["OK", "ok ", " held", "dead", "", "healthy", "fail"]) {
      await assert.rejects(
        () => upsertBeat("mini", status, "", "2026-10-28T12:00:00Z"),
        (err: unknown) => err instanceof WatchBeatError && /status/.test(err.message),
        status,
      );
    }
    for (const status of [null, undefined, 1, true]) {
      await assert.rejects(
        () => upsertBeat("mini", status as never, "", "2026-10-28T12:00:00Z"),
        (err: unknown) => err instanceof WatchBeatError,
      );
    }
  });

  it("rejects an empty source and a non-string detail before any query", async () => {
    setSqlForTests(async () => {
      throw new Error("SQL must not run");
    });
    await assert.rejects(() => upsertBeat("", "ok", "", "2026-10-28T12:00:00Z"), WatchBeatError);
    await assert.rejects(() => upsertBeat(null as never, "ok", "", "2026-10-28T12:00:00Z"), WatchBeatError);
    await assert.rejects(() => upsertBeat("mini", "ok", null as never, "2026-10-28T12:00:00Z"), WatchBeatError);
    await assert.rejects(() => upsertBeat("mini", "ok", undefined as never, "2026-10-28T12:00:00Z"), WatchBeatError);
  });

  it("rejects detail over 500 code points, including emoji that fit in a UTF-16 budget", async () => {
    setSqlForTests(async () => {
      throw new Error("SQL must not run");
    });
    await assert.rejects(
      () => upsertBeat("mini", "ok", "a".repeat(501), "2026-10-28T12:00:00Z"),
      (err: unknown) => err instanceof WatchBeatError && /500/.test(err.message),
    );
    await assert.rejects(
      () => upsertBeat("mini", "ok", "😀".repeat(501), "2026-10-28T12:00:00Z"),
      WatchBeatError,
    );
    await assert.rejects(
      () => upsertBeat("mini", "ok", "e\u0301".repeat(251), "2026-10-28T12:00:00Z"),
      WatchBeatError,
    );
  });

  it("rejects invalid instants, including dates Date.parse would roll or treat as local", async () => {
    setSqlForTests(async () => {
      throw new Error("SQL must not run");
    });
    const rejected = [
      "not-a-date",
      "",
      "   ",
      "2026-10-28",
      "2026-10-28T12:00:00",
      "2026-10-28 12:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-02-31T00:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-00-01T00:00:00Z",
      "2026-10-00T00:00:00Z",
      "2026-10-28T24:00:00Z",
      "2026-10-28T12:60:00Z",
      "2026-10-28T12:00:60Z",
      "2026-10-28T12:00:00+0000",
      "2026-10-28T12:00:00Z ",
      "2026-10-28T12:00:00.Z",
      "2026-10-28T00:00:00Z'; drop table watch_beats; --",
      "2026-10-28T12:00:00+24:00",
    ];
    for (const beatAt of rejected) {
      await assert.rejects(
        () => upsertBeat("mini", "ok", "", beatAt),
        (err: unknown) => err instanceof WatchBeatError && /beatAt/.test(err.message),
        beatAt,
      );
    }
    await assert.rejects(() => upsertBeat("mini", "ok", "", new Date(NaN)), WatchBeatError);
    await assert.rejects(() => upsertBeat("mini", "ok", "", new Date("nope")), WatchBeatError);
    await assert.rejects(() => upsertBeat("mini", "ok", "", null as never), WatchBeatError);
    await assert.rejects(() => upsertBeat("mini", "ok", "", undefined as never), WatchBeatError);
    await assert.rejects(() => upsertBeat("mini", "ok", "", 1_700_000_000_000 as never), WatchBeatError);
  });

  it("rejects a received_at argument and does not query", async () => {
    setSqlForTests(async () => {
      throw new Error("SQL must not run");
    });
    const call = upsertBeat as (...args: unknown[]) => Promise<void>;
    await assert.rejects(
      () => call("mini", "ok", "", "2026-10-28T12:00:00Z", "2026-10-28T12:00:01Z"),
      (err: unknown) => err instanceof WatchBeatError && /received_at/.test(err.message),
    );
  });

  it("stamps received_at from the database clock on insert and on conflict, as parameters otherwise", async () => {
    const captured: { text: string; values: unknown[] }[] = [];
    setSqlForTests(async (strings, ...values) => {
      const built = toQuery(strings, values);
      captured.push({ text: built.text, values: built.params });
      return [];
    });
    const hostile = "mini'); drop table watch_beats; --";
    await upsertBeat(hostile, "held", "😀".repeat(500), "2026-10-28T12:00:00.123456Z");
    assert.equal(captured.length, 1);
    const query = captured[0];
    assert.equal(query.values.length, 4);
    assert.deepEqual(query.values, [hostile, "held", "😀".repeat(500), "2026-10-28T12:00:00.123456Z"]);
    assert.equal(query.text.includes(hostile), false, "the source must be a bound parameter");
    assert.match(query.text, /insert into watch_beats\s*\(\s*source\s*,\s*status\s*,\s*detail\s*,\s*beat_at\s*,\s*received_at\s*\)/i);
    assert.match(query.text, /\$1,\s*\$2,\s*\$3,\s*\$4::timestamptz,\s*clock_timestamp\(\)/i);
    assert.match(query.text, /on conflict\s*\(\s*source\s*\)\s*do update set/i);
    assert.match(query.text, /received_at\s*=\s*clock_timestamp\(\)/i);
    assert.equal(query.text.includes("excluded.received_at"), false);

    captured.length = 0;
    await upsertBeat("mini", "ok", "", new Date("2026-10-28T07:00:00-05:00"));
    assert.equal(captured[0].values[3], "2026-10-28T12:00:00.000Z");
  });

  it("accepts an empty detail and every documented status without inventing received_at", async () => {
    const seen: unknown[][] = [];
    setSqlForTests(async (_strings, ...values) => {
      seen.push(values);
      return [];
    });
    for (const status of ["ok", "held", "paused", "stale", "failing", "unknown"]) {
      await upsertBeat("mini", status, "", "2026-10-28t12:00:00z");
    }
    await upsertBeat("mini", "ok", "", "2026-10-28T07:30:00+05:30");
    await upsertBeat("mini", "ok", "e\u0301".repeat(250), "2026-10-28T12:00:00.1Z");
    assert.equal(seen.length, 8);
    assert.deepEqual(seen.map((values) => values[1]), ["ok", "held", "paused", "stale", "failing", "unknown", "ok", "ok"]);
    assert.equal(seen[6][3], "2026-10-28T07:30:00+05:30");
    assert.equal(seen[7][2], "e\u0301".repeat(250));
  });

  it("returns the SQL age and UTC ISO timestamps, and nothing else", async () => {
    setSqlForTests(async () => [
      {
        source: "b",
        status: "failing",
        detail: "",
        beat_at: new Date("2026-10-26T12:00:00.000Z"),
        received_at: "2026-10-28T12:00:00.000Z",
        age_s: 17,
        extra: "nope",
      },
      {
        source: "a",
        status: "ok",
        detail: "held overnight",
        beat_at: new Date("2026-10-30T12:00:00.000Z"),
        received_at: new Date("2026-10-28T12:00:01.000Z"),
        age_s: "0",
      },
    ] as Row[]);
    const beats = await readBeats();
    assert.deepEqual(beats, [
      {
        source: "b",
        status: "failing",
        detail: "",
        beat_at: "2026-10-26T12:00:00.000Z",
        received_at: "2026-10-28T12:00:00.000Z",
        age_s: 17,
      },
      {
        source: "a",
        status: "ok",
        detail: "held overnight",
        beat_at: "2026-10-30T12:00:00.000Z",
        received_at: "2026-10-28T12:00:01.000Z",
        age_s: 0,
      },
    ]);
    assert.deepEqual(Object.keys(beats[0]), ["source", "status", "detail", "beat_at", "received_at", "age_s"]);
  });

  it("orders by source and computes age with floor against the database clock", async () => {
    let text = "";
    setSqlForTests(async (strings) => {
      text = sqlText(strings);
      return [];
    });
    assert.deepEqual(await readBeats(), []);
    assert.match(text, /order by source/i);
    assert.match(text, /greatest\(\s*0\s*,\s*floor\(\s*extract\(epoch from \(clock_timestamp\(\) - received_at\)\)\s*\)\s*\)::int/i);
    assert.doesNotMatch(text, /beat_at\s*-\s*|-\s*beat_at/i);
  });

  it("raises when the query fails and does not invent a healthy beat", async () => {
    setSqlForTests(async () => {
      throw Object.assign(new Error("relation watch_beats does not exist"), { code: "42P01" });
    });
    await assert.rejects(readBeats, (err: unknown) => {
      const record = err as { code?: string };
      return record.code === "42P01";
    });
  });

  it("raises when the database age is not an integer instead of coercing it", async () => {
    setSqlForTests(async () => [
      {
        source: "a",
        status: "ok",
        detail: "",
        beat_at: new Date("2026-10-28T12:00:00.000Z"),
        received_at: new Date("2026-10-28T12:00:00.000Z"),
        age_s: 1.5,
      },
    ]);
    await assert.rejects(readBeats, /age_s/);
  });

  it("raises when DATABASE_URL is missing and does not return beats", async () => {
    const previous = env.DATABASE_URL;
    delete env.DATABASE_URL;
    try {
      await assert.rejects(readBeats, /DATABASE_URL is not set/);
      await assert.rejects(
        () => upsertBeat("mini", "ok", "", new Date("2026-10-28T12:00:00Z")),
        /DATABASE_URL is not set/,
      );
    } finally {
      if (previous === undefined) delete env.DATABASE_URL;
      else env.DATABASE_URL = previous;
    }
  });
});
