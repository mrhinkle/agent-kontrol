import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";

import { toQuery } from "./sql-template";

export type Row = Record<string, any>;

export type SqlTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Row[]>;

export function isConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Pure driver selection, exported for tests.
 *
 * - An explicit override of "neon" or "pg" (case-insensitive) wins.
 * - Otherwise the driver is auto-detected from the hostname of the URL:
 *   hosts ending in ".neon.tech", containing ".neon.", or ending in
 *   ".aws.neon.build" use the Neon HTTP driver; everything else uses
 *   node-postgres. A URL that cannot be parsed falls back to "pg".
 */
export function chooseDriver(
  databaseUrl: string,
  override?: string
): "neon" | "pg" {
  const forced = override?.trim().toLowerCase();
  if (forced === "neon") return "neon";
  if (forced === "pg") return "pg";

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return "pg";
  }

  if (
    hostname.endsWith(".neon.tech") ||
    hostname.includes(".neon.") ||
    hostname.endsWith(".aws.neon.build")
  ) {
    return "neon";
  }
  return "pg";
}

let neonTag: SqlTag | null = null;
let pgTag: SqlTag | null = null;

/**
 * Cached SQL tag function. Callers only ever use the tagged-template form:
 *
 *   const db = sql();
 *   const rows = await db`select * from t where a = ${x}`;
 */
export function sql(): SqlTag {
  if (!isConfigured()) throw new Error("DATABASE_URL is not set");

  const databaseUrl = process.env.DATABASE_URL as string;
  const driver = chooseDriver(databaseUrl, process.env.MC_DB_DRIVER);

  if (driver === "neon") {
    if (!neonTag) {
      neonTag = neon(databaseUrl) as unknown as SqlTag;
    }
    return neonTag;
  }

  if (!pgTag) {
    pgTag = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Row[]> => {
      const { text, params } = toQuery(strings, values);
      const pool = getPgPool();
      const res = await pool.query(text, params);
      return res.rows as Row[];
    };
  }
  return pgTag;
}

let pool: Pool | null = null;
const pgGlobal = globalThis as unknown as { __mcPgPool?: Pool };

function getPgPool(): Pool {
  if (pool) return pool;
  if (pgGlobal.__mcPgPool) {
    pool = pgGlobal.__mcPgPool;
    return pool;
  }

  const configuredMax = Number(process.env.MC_DB_POOL_MAX);
  const max =
    Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : 5;

  const created = new Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  created.on("error", (err: Error) => {
    console.error("[db] unexpected error on an idle Postgres client:", err);
  });

  pool = created;
  pgGlobal.__mcPgPool = created;
  return pool;
}
