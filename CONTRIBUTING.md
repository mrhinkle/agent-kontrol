# Contributing

## Development setup

- Node 22
- `npm ci`
- `npm run dev` — runs in demo mode when `DATABASE_URL` is unset.

## Where to start

Read `docs/ARCHITECTURE.md` and the code map in it.

## Checks CI runs

- `npm run typecheck`
- `npm run test:ui`
- `npm test` — includes Python unit tests and ingest/provider/usage/message tests
- `npm run build`
- `npm run test:pg` — runs against a Postgres. Set `DATABASE_URL` to a scratch database with `supabase/schema.sql` applied. The suite skips when unset.

## Schema changes

- Edit `supabase/schema.sql` and keep it idempotent: `create ... if not exists`, `add column if not exists`, and add columns before any index that uses them.
- Add a dated note in `supabase/migrations/`.

## Progress repos

Progress repos live in `progress.config.json`.

## Expectations for changes

- New behavior needs a test.
- Do not weaken existing tests.
- No secrets, personal names or private hostnames in code, docs or fixtures. Fixtures are synthetic.
- Keep PRs small and focused.

## Pull requests

PRs are checked by CI plus automated review bots. Address their findings or explain why not.

## License

Contributions are licensed under Apache-2.0 (section 5 of the license).
