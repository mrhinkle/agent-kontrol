# Usage and Costs (Phase 1)

Fleet usage ledger for Hermes + OpenRouter.

- UI: `/usage`
- Ingest: `POST /api/usage/ingest`
- Collector: `agents/usage-collector/`
- Spec: [issue #12](https://github.com/mrhinkle/mission-control-ops/issues/12)
- Synthetic fixtures: `python3 scripts/make-fixtures.py`

Committed Hermes SQLite under `fixtures/hermes/` is **synthetic only** (never real fleet DBs).
