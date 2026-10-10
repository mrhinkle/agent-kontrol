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

The default list lives in `progress.config.json`. Operators change the live list in the app's Settings page; the file is only the starting point.

## Expectations for changes

- New behavior needs a test.
- Do not weaken existing tests.
- No secrets, personal names or private hostnames in code, docs or fixtures. Fixtures are synthetic.
- Keep PRs small and focused.
- Adapters need evidence: say what you ran them against. An adapter that watches files must be checked against a real install of the tool, not only its documentation.
- Anything that records agent activity must say what it stores. Prompts and tool input or output stay out by default.

## Pull requests

PRs are checked by CI plus automated review bots. Address their findings or explain why not.

Branch from `main`, open the PR against `main`, and squash-merge when CI is green. Do not use branch names that start with `release/`: the repository has a branch called `release`, and Git cannot hold both.

## Releases

- `main` is the integration branch. The maintainers deploy from a `release` branch (see [Releasing on Vercel](docs/DEPLOY.md)), so a merge to `main` is not a deployment.
- Version numbers follow semver. During 1.0 beta the REST API, the MCP tool names and the schema are kept stable; breaking one needs a changelog entry and a deprecation path.
- A release is a version bump and a dated CHANGELOG entry in one PR, then a Git tag and a GitHub release (a prerelease while in beta).

## Dependencies

Dependabot opens the PRs. Patch and minor updates that pass CI can be merged. Major upgrades (Next.js, zod, mcp-handler, `@types/node`) are done deliberately in their own PR with the OAuth, MCP and Postgres paths exercised, not by merging the bot's PR as it arrives. Closing a major-version PR tells Dependabot to skip that version; reopen the work when you plan it.

## License

Contributions are licensed under Apache-2.0 (section 5 of the license).
