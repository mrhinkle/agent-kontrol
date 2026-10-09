# Usage collector (Usage and Costs Phase 1)

Read-only Hermes `session_model_usage` → `POST /api/usage/ingest`.

```bash
# Dry-run against fixture roots (no Hermes writes, no POST)
python3 collect_usage.py --dry-run --roots ../../fixtures/hermes \
  --since 2026-09-28 --until 2026-10-06

# Live tick on the Mac Mini (after install.sh)
python3 collect_usage.py
```

Privacy: only token counts, costs, model, billing metadata. Never prompts or completions.
