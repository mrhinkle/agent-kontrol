import { describe, it } from "node:test";
import { equal } from "node:assert/strict";

import { chooseDriver } from "../../src/lib/db";

const NEON_TECH_URL =
  "postgres://user:secret@ep-quiet-leaf-123456.eu-central-1.aws.neon.tech/neondb";
const NEON_BUILD_URL =
  "postgres://user:secret@ep-bold-frog-789012.us-east-2.aws.neon.build/neondb";
const NEON_INTERNAL_URL =
  "postgres://user:secret@db.neon.internal.example.com:5432/appdb";
const LOCAL_URL = "postgres://postgres:postgres@localhost:5432/appdb";
const RDS_URL =
  "postgres://user:secret@mydb.abc123def456.us-east-1.rds.amazonaws.com:5432/appdb";

describe("chooseDriver", () => {
  it("auto-detects neon for a .neon.tech host", () => {
    equal(chooseDriver(NEON_TECH_URL), "neon");
  });

  it("auto-detects neon for an .aws.neon.build host", () => {
    equal(chooseDriver(NEON_BUILD_URL), "neon");
  });

  it("auto-detects neon for a host containing .neon.", () => {
    equal(chooseDriver(NEON_INTERNAL_URL), "neon");
  });

  it("auto-detects pg for localhost", () => {
    equal(chooseDriver(LOCAL_URL), "pg");
  });

  it("auto-detects pg for an RDS-style host", () => {
    equal(chooseDriver(RDS_URL), "pg");
  });

  it("falls back to pg when the URL cannot be parsed", () => {
    equal(chooseDriver("not-a-valid-url"), "pg");
    equal(chooseDriver(""), "pg");
  });

  it("lets the override force the driver, case-insensitively", () => {
    equal(chooseDriver(LOCAL_URL, "neon"), "neon");
    equal(chooseDriver(NEON_TECH_URL, "PG"), "pg");
    equal(chooseDriver(LOCAL_URL, "NeOn"), "neon");
    equal(chooseDriver(NEON_BUILD_URL, "pg"), "pg");
  });

  it("ignores an unrecognized override and auto-detects instead", () => {
    equal(chooseDriver(NEON_TECH_URL, "sqlite"), "neon");
    equal(chooseDriver(LOCAL_URL, "sqlite"), "pg");
    equal(chooseDriver(LOCAL_URL, ""), "pg");
    equal(chooseDriver(NEON_TECH_URL, undefined), "neon");
  });
});
