# Migrations

`../schema.sql` is the canonical schema. It is idempotent (`create ... if not exists`,
`add column if not exists`), so upgrading any deployment is:

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

The dated files in this directory are a changelog, not a second upgrade path: each one
records what a release added so you can see what changed, and every change in it is
already folded into `schema.sql`. You never need to run them separately.
