import { neon, Pool as NeonPool } from "@neondatabase/serverless";
import { Pool, type PoolClient } from "pg";

import { toQuery } from "./sql-template";
import { asUnknownWriteOutcome } from "./write-outcome";

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
let sqlOverride: SqlTag | null = null;

function guardQuery(run: () => Promise<Row[]>): Promise<Row[]> {
  return run().catch((err: unknown) => {
    const unknown = asUnknownWriteOutcome(err);
    if (unknown) throw unknown;
    throw err;
  });
}

/** Tests substitute the SQL tag. Production never calls this. */
export function setSqlForTests(fn: SqlTag | null): void {
  sqlOverride = fn;
}

/**
 * Cached SQL tag function. Callers only ever use the tagged-template form:
 *
 *   const db = sql();
 *   const rows = await db`select * from t where a = ${x}`;
 */
export function sql(): SqlTag {
  if (sqlOverride) return sqlOverride;
  if (!isConfigured()) throw new Error("DATABASE_URL is not set");

  const databaseUrl = process.env.DATABASE_URL as string;
  const driver = chooseDriver(databaseUrl, process.env.MC_DB_DRIVER);

  if (driver === "neon") {
    if (!neonTag) {
      const raw = neon(databaseUrl) as unknown as SqlTag;
      neonTag = (strings, ...values) => guardQuery(() => raw(strings, ...values));
    }
    return neonTag;
  }

  if (!pgTag) {
    pgTag = (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Row[]> => guardQuery(async () => {
      const { text, params } = toQuery(strings, values);
      const pool = getPgPool();
      const res = await pool.query(text, params);
      return res.rows as Row[];
    });
  }
  return pgTag;
}

interface TxClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}

/**
 * Runs `fn` in one database transaction. The test override sees `begin`,
 * the statements, then `commit` or `rollback`. Postgres uses one pooled
 * client so the lock and the following statements share a snapshot sequence.
 * Neon uses a websocket client for the same reason: the HTTP driver cannot
 * hold an interactive transaction.
 */
export async function withTransaction<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T> {
  if (sqlOverride) return runTaggedTransaction(sqlOverride, fn);
  if (!isConfigured()) throw new Error("DATABASE_URL is not set");

  const databaseUrl = process.env.DATABASE_URL as string;
  const driver = chooseDriver(databaseUrl, process.env.MC_DB_DRIVER);
  const client = driver === "neon" ? await connectNeon(databaseUrl) : await connectPg();
  return runClientTransaction(client, fn);
}

async function runTaggedTransaction<T>(q: SqlTag, fn: (tx: SqlTag) => Promise<T>): Promise<T> {
  await q`begin`;
  try {
    const result = await fn(q);
    await q`commit`;
    return result;
  } catch (err) {
    try {
      await q`rollback`;
    } catch {
      // The original error is the one the caller can handle.
    }
    throw err;
  }
}

async function runClientTransaction<T>(client: TxClient, fn: (tx: SqlTag) => Promise<T>): Promise<T> {
  const tx: SqlTag = (strings, ...values) => guardQuery(async () => {
    const { text, params } = toQuery(strings, values);
    const res = await client.query(text, params);
    return res.rows;
  });
  try {
    await client.query("begin");
    const result = await fn(tx);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // The original error is the one the caller can handle.
    }
    throw err;
  } finally {
    client.release();
  }
}

function clientAdapter(client: PoolClient): TxClient {
  return {
    query: async (text, params) => {
      const res = await client.query(text, params as never[]);
      return { rows: res.rows as Row[] };
    },
    release: () => client.release(),
  };
}

async function connectPg(): Promise<TxClient> {
  return clientAdapter(await getPgPool().connect());
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

const neonGlobal = globalThis as unknown as { __mcNeonPool?: NeonPool };

function getNeonPool(databaseUrl: string): NeonPool {
  if (neonGlobal.__mcNeonPool) return neonGlobal.__mcNeonPool;
  const created = new NeonPool({ connectionString: databaseUrl, max: 5 });
  created.on("error", (err: Error) => {
    console.error("[db] unexpected error on an idle Neon client:", err);
  });
  neonGlobal.__mcNeonPool = created;
  return created;
}

async function connectNeon(databaseUrl: string): Promise<TxClient> {
  const client = await getNeonPool(databaseUrl).connect();
  return clientAdapter(client as unknown as PoolClient);
}
