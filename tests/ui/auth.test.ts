import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isAuthorized } from "../../src/lib/auth";

const env = process.env as Record<string, string | undefined>;
let savedToken: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedToken = env.MC_TOKEN;
  savedNodeEnv = env.NODE_ENV;
});

afterEach(() => {
  if (savedToken === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = savedToken;
  if (savedNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = savedNodeEnv;
});

function reqWith(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("isAuthorized", () => {
  it("dev + no token => true", async () => {
    delete env.MC_TOKEN;
    env.NODE_ENV = "development";
    assert.equal(await isAuthorized(reqWith("http://localhost/x")), true);
  });

  it("production + no token => false (fail closed)", async () => {
    delete env.MC_TOKEN;
    env.NODE_ENV = "production";
    assert.equal(await isAuthorized(reqWith("http://localhost/x")), false);
  });

  it("unset NODE_ENV + no token => false (fail closed)", async () => {
    delete env.MC_TOKEN;
    delete env.NODE_ENV;
    assert.equal(await isAuthorized(reqWith("http://localhost/x")), false);
  });

  it("test NODE_ENV + no token => true", async () => {
    delete env.MC_TOKEN;
    env.NODE_ENV = "test";
    assert.equal(await isAuthorized(reqWith("http://localhost/x")), true);
  });

  it("correct bearer => true", async () => {
    env.MC_TOKEN = "sekret";
    env.NODE_ENV = "production";
    assert.equal(
      await isAuthorized(reqWith("http://localhost/x", { authorization: "Bearer sekret" })),
      true,
    );
  });

  it("wrong bearer => false", async () => {
    env.MC_TOKEN = "sekret";
    env.NODE_ENV = "production";
    assert.equal(
      await isAuthorized(reqWith("http://localhost/x", { authorization: "Bearer nope" })),
      false,
    );
  });

  it("?key= with correct token => false by default", async () => {
    env.MC_TOKEN = "sekret";
    env.NODE_ENV = "production";
    assert.equal(await isAuthorized(reqWith("http://localhost/x?key=sekret")), false);
  });

  it("?key= with correct token => true with allowQueryKey", async () => {
    env.MC_TOKEN = "sekret";
    env.NODE_ENV = "production";
    assert.equal(
      await isAuthorized(reqWith("http://localhost/x?key=sekret"), { allowQueryKey: true }),
      true,
    );
  });

  it("wrong ?key= => false even with allowQueryKey", async () => {
    env.MC_TOKEN = "sekret";
    env.NODE_ENV = "production";
    assert.equal(
      await isAuthorized(reqWith("http://localhost/x?key=nope"), { allowQueryKey: true }),
      false,
    );
  });
});
