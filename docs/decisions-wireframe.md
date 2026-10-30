# /decisions wireframe

Low-fi layout for the owner queue. Oldest open decision first. Built before the page.

```
+------------------------------------------------------------------+
| Decisions                                                        |
| Oldest open item first. Decide, defer, or withdraw.             |
+------------------------------------------------------------------+
| No open decisions.                                               |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
| Ship the schema or wait                         Age 12 days      |
| source: mrhinkle/agent-kontrol#65                                |
|                                                                  |
| Why                                                              |
| The collector and the page disagree on which label counts.      |
|                                                                  |
| Options                                                          |
| ( ) ship-now     Ship the additive columns                      |
| ( ) wait         Wait for the next brief          (recommended) |
|                                                                  |
| Decision text                                                    |
| [............................................................]   |
| [ Decide ]                                                       |
|                                                                  |
| Defer until                                                      |
| [ 2026-11-02 ]  [ Defer ]                                        |
|                                                                  |
| [ Withdraw ]                                                     |
+------------------------------------------------------------------+
| Pick the reviewer                               Age 3 days       |
| source: mrhinkle/conference-os#2271                              |
| Why: Two vendors have to read this and only one has.            |
| Options: claude (recommended), codex                             |
| [ Decide ]  [ Defer ]  [ Withdraw ]                              |
+------------------------------------------------------------------+

After Decide, when GitHub did not take the comment:

+------------------------------------------------------------------+
| Ship the schema or wait                         decided          |
| Decision: Ship the additive columns.                             |
| not written back                                                 |
| [ Retry write-back ]                                             |
+------------------------------------------------------------------+
```

The source link comes from the row url when it is http(s). Otherwise it is built from the key `github:<owner/repo>#<n>` (`/pull/` when kind is pr, otherwise `/issues/`). The link never uses `repo` or `number` from the request. Decide, Defer, and Withdraw send the row's `updated_at` as `expected_updated_at`. A stale row asks for a reload. A decided or withdrawn row returns a conflict. Defer sends the date from the date field. Free text is rendered as text, never as HTML.
