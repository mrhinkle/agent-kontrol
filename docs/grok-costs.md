# Grok cost reporting

The Usage dashboard separates direct xAI team charges, verified Grok subscription payments, and the Grok portion already included in OpenRouter. It never adds the OpenRouter subset to provider charges. The existing subscription-fee headline includes recorded payments across providers, separately from Hermes usage.

Direct billing uses [xAI management analytics](https://docs.x.ai/developers/rest-api-reference/management/billing): `usd` is dollars, `transactions` is requests, and the end of a range is exclusive. It captures all billed resources for the configured team as one daily aggregate, without estimating prices or combining different token/image/audio units. It requires `MC_XAI_MANAGEMENT_KEY` and `MC_XAI_TEAM_ID` (aliases `XAI_MANAGEMENT_KEY` and `XAI_TEAM_ID`); inference keys are never used. Keep credentials in the existing protected configuration, not in command arguments or repository files.

```sh
npx tsx scripts/collect-provider-usage.ts --provider xai --env-file ~/.claude/mission-control.env --days 30 --output /private/path/new-xai-report.json
```

This is a dry run. Adding `--publish` sends an atomically validated report to the configured Fleet origin. Before the first live xAI publication, verify a real response and reconcile one complete UTC day against the xAI console. Tests and synthetic previews do not establish live access or billing reconciliation. The output path must be new; it is created with mode 0600. Provider reports cover 1–30 complete UTC days, separately from rolling local-usage and payment windows.

A successful response requires an explicit `limitReached: false` and a `timeSeries` array. An empty array is a quiet report; a nonempty series must contain every requested UTC day. Missing or malformed buckets fail closed. Row-limited responses are discarded and split into disjoint intervals (at most 59 requests for 30 days); a limited one-day response fails. No report is published if any slice fails. USD values are rounded to 10 decimal places using the existing money helper. Latest report identities exclude rows removed by corrections. Team fingerprints keep fact identities distinct; the latest configured team's report is displayed while older facts remain stored. Hashes avoid publishing raw team and invoice identifiers but are not an anonymity guarantee for guessable identifiers.

For an actual verified subscription payment, use `--provider grok-fee --fee-file /private/path/payment.json` with `invoice_id`, `paid_at`, `amount_usd` and `currency: "USD"`. Invoice references are hashed. Repeating a provider/invoice updates the same record, including operator corrections. Claude fee identities remain unchanged. Do not assume a plan price or automatically repeat a payment each month.

OpenRouter models in the canonical `x-ai/grok` family form the displayed routed subtotal. Complete reports can establish zero; missing or incomplete evidence is unavailable or explicitly unverified. This subset uses the current report only, including corrections.

Local Grok CLI totals are unavailable: session metadata may inherit resume/fork history and include subagent rollups without a durable original-turn ownership identifier. This release does not ingest local Grok records, conversation content, or credentials.

Run daily sources independently (`openrouter`, `anthropic`, `xai`, and the existing Claude collector), record individual outcomes, and continue other sources when one is unavailable. `--provider all` is a manual preflight convenience requiring all three reporting credentials; it is not the recurring runner. Retain immutable capture artifacts and verify the API's non-demo readback before calling any capture complete. Missing credentials, missing fee records and unavailable local totals are never successful zeroes.
