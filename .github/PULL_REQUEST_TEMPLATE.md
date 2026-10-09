## Summary

<!-- What this PR changes, in a sentence or two. -->

## Why

<!-- The problem or need this addresses. -->

## How tested

- [ ] `npm run typecheck`
- [ ] `npm run test:ui`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:pg` (if the data layer was touched; requires a scratch Postgres with `supabase/schema.sql` applied)

## Checklist

- [ ] No secrets, personal names or private hostnames in code, docs or fixtures.
- [ ] Docs updated where behavior changed.
- [ ] Schema changes keep `supabase/schema.sql` idempotent, with a dated note in `supabase/migrations/`.
