# Lane spec: Mission Control 1.0 (delete before commit)

Repo: this checkout (mrhinkle/mission-control, Apache 2.0). Work on a branch per lane, never on main.
Gate for every lane: `npm run typecheck && npm test && npm run build` must pass. Do not weaken or delete tests.
No personal names, hosts, or private repo names anywhere. Operator is "the operator".

## Lane A: security and CI
1. `npm audit fix` (no `--force`, no major bumps). Commit lockfile + package.json.
2. Add `.github/workflows/ci.yml`: Node 22, `npm ci`, typecheck, `test:ui`, python unit tests, `npm test`, `next build`.
3. Add `.github/dependabot.yml` (npm + github-actions, weekly).
4. Auth: when `NODE_ENV=production` and `MC_TOKEN` is unset, `isAuthorized` must return false. Add a test.
5. Restrict `?key=` auth to the MCP transport routes only. Add a test.
6. Add basic rate limiting to `/api/login` (5 failures per IP per 10 min, in-memory is fine, document the limit).

## Lane B: configuration
1. Env var `NEXT_PUBLIC_MC_OPERATOR` (default "Operator") used for `created_by`, display text, and MCP tool text.
2. Single source for watched repos: `progress.config.json` read by `src/lib/progress-config.ts` and `scripts/collect-progress.sh` (via jq). Move lane-bot prefix there too.
3. Replace demo data seeds with obviously synthetic numbers (no real sweep figures).
4. Declare schema.sql canonical; `supabase/migrations/` becomes a dated changelog with a README saying so.

## Lane C: docs (after A and B merge)
README trimmed to pitch + diagram + quickstart + screenshots placeholder. Then `docs/`: DEPLOY.md, MCP.md (all 11 tools), API.md (every route with auth), AGENTS.md (adapter x feature matrix), ARCHITECTURE.md, PROGRESS-BOARD.md, USAGE.md (mark Experimental). Root: SECURITY.md, CONTRIBUTING.md (test commands), CHANGELOG.md, CODE_OF_CONDUCT.md, issue and PR templates. Move PLAYBOOK.md to docs/. Document every claim from the code, not from memory.

## Out of scope
Memory redesign, Usage Phase 2, dispatcher kill switch. Add them to CHANGELOG as "Known limitations".
