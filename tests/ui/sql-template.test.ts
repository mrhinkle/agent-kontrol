import { describe, it } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";

import { toQuery } from "../../src/lib/sql-template";

const tag = (strings: TemplateStringsArray, ...values: unknown[]) =>
  toQuery(strings, values);

describe("toQuery", () => {
  it("returns the text unchanged when there are no values", () => {
    const { text, params } = tag`select * from t`;
    equal(text, "select * from t");
    deepEqual(params, []);
  });

  it("uses $1 for a single value", () => {
    const { text, params } = tag`select * from t where a = ${42}`;
    equal(text, "select * from t where a = $1");
    deepEqual(params, [42]);
  });

  it("numbers placeholders $1..$n in order and keeps values out of the text", () => {
    const nasty = "'; drop table t; --";
    const { text, params } = tag`select * from t where a = ${nasty} and b = ${7} limit ${10}`;
    equal(text, "select * from t where a = $1 and b = $2 limit $3");
    deepEqual(params, [nasty, 7, 10]);
    ok(!text.includes("drop table"));
  });

  it("keeps arrays and nulls in params instead of interpolating them", () => {
    const tags = ["alpha", "beta"];
    const meta = { k: [1, 2] };
    const { text, params } = tag`insert into t (tags, meta, deleted_at) values (${tags}::text[], ${meta}::jsonb, ${null})`;
    equal(
      text,
      "insert into t (tags, meta, deleted_at) values ($1::text[], $2::jsonb, $3)"
    );
    equal(params.length, 3);
    equal(params[0], tags);
    equal(params[1], meta);
    equal(params[2], null);
    ok(!text.includes("alpha"));
    ok(!text.includes("beta"));
    ok(!text.toLowerCase().includes("null"));
  });

  it("throws when strings.length is not values.length + 1", () => {
    throws(() => toQuery(["a ", " b"], []), /strings\.length/);
    throws(() => toQuery(["a"], [1, 2]), Error);
    throws(() => toQuery([], []), Error);
  });
});
