# Database

## Supported databases

- **Neon**, via its serverless HTTP driver (`@neondatabase/serverless`). Queries are sent over HTTPS; no database sockets are held open.
- **Any ordinary Postgres 13+**, via `node-postgres` (`pg`) with a standard connection pool.

Both are reached through the same tagged-template interface from `src/lib/db.ts`, so callers do not change when the database does:

```ts
import { sql } from "@/lib/db";

const db = sql();
const rows = await db`select * from t where a = ${x}`;
```

## How the driver is chosen

The choice is made inside `sql()`:

1. If `MC_DB_DRIVER` is set to `neon` or `pg` (case-insensitive), that driver is used.
2. Otherwise it is auto-detected from the hostname in `DATABASE_URL`:
   - hostname ends with `.neon.tech`, contains `.neon.`, or ends with `.aws.neon.build` → Neon HTTP driver
   - anything else, including a URL that cannot be parsed → `pg`

### Environment variables

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Required by both drivers. |
| `MC_DB_DRIVER` | Force `neon` or `pg`. Unset or any other value means auto-detect. |
| `MC_DB_POOL_MAX` | Maximum number of connections in the `pg` pool. Must be a positive integer; defaults to `5`. Ignored by the Neon driver. |

## Applying the schema

```sh
psql "$DATABASE_URL" -f supabase/schema.sql
```

The schema file is idempotent: it is safe to re-run, including to upgrade an existing database to the current schema.

## Connection limits on serverless hosts

With the `pg` driver, every running instance keeps its own pool of up to `MC_DB_POOL_MAX` connections. On serverless platforms such as Vercel or AWS Lambda, many instances run concurrently, so the database's connection limit can be exhausted quickly. To avoid that:

- Use a pooler such as PgBouncer, or the provider's pooled connection string, when deploying on Vercel or a similar host.
- Or keep the pool small (for example `MC_DB_POOL_MAX=1` or `MC_DB_POOL_MAX=2`).

The Neon HTTP driver holds no connections at all, which makes it the zero-configuration choice on Vercel: point `DATABASE_URL` at Neon and no pool tuning is needed.
