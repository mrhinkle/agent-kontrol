import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;

export function isConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function sql(): NeonQueryFunction<false, false> {
  if (!isConfigured()) throw new Error("DATABASE_URL is not set");
  if (!_sql) _sql = neon(process.env.DATABASE_URL!);
  return _sql;
}
