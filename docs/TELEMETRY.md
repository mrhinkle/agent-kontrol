# Telemetry and traces

Agent Kontrol records what each agent did, step by step, as **traces**. A trace is a tree of **spans** that share a trace id: one session, a turn for each prompt, and a span for each tool or model call inside it. Open **Traces** in the app header to see them as a waterfall.

Traces use the OpenTelemetry wire format (OTLP over HTTP with JSON), so anything that can export OpenTelemetry can send to Agent Kontrol. It sits beside the Fleet view, which shows liveness, and the Usage ledger, which shows cost.

## What you get

- **Traces list.** Newest first, with agent, span count, error count and duration. Filter to traces with errors.
- **Waterfall.** Nested bars on a shared time axis, errors in red, running spans pulsing. Click a span for its attributes, status, model, tokens and cost.
- **Live updates.** The list refreshes every 10 seconds and an open trace every 5.

## Claude Code, with no setup beyond the hook

The Claude Code hook already installed for the Fleet view now emits traces too. Merge the updated `agents/claude-code/settings-fragment.json` into your Claude Code settings so the `PreToolUse` and `PostToolUse` hooks are registered, and traces start flowing.

| Span | Made from |
| --- | --- |
| `session` | `SessionStart` to `SessionEnd` |
| `turn N` | each prompt, to the next `Stop` |
| the tool name, for example `Bash` | `PreToolUse` to `PostToolUse` |

A tool call whose response reports an error is marked as an error. The hook keeps a tiny state file per session under `~/.claude/mission-control-trace/` to pair a tool's start with its end, and deletes it when the session ends (leftovers older than 7 days are cleaned up). Tool traces are sent from a detached child process, so the agent never waits on the network (on Windows, where fork is unavailable, the send is synchronous with a short timeout). After a failed send the hook skips tracing for 30 seconds, so a down server cannot slow every tool call. Set `MC_TRACES=0` to turn tracing off while keeping the Fleet events.

## Any other agent or tool: send OTLP

Point an OpenTelemetry exporter at:

```
POST <your-url>/api/v1/traces
Content-Type: application/json
Authorization: Bearer <MC_TOKEN>
```

For the standard OpenTelemetry SDKs, set:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://your-deploy/api/v1/traces
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <MC_TOKEN>"
export OTEL_RESOURCE_ATTRIBUTES="agent.id=my-agent"
```

Rules:

- **Format.** JSON only. Protobuf is answered with 415. gzip request bodies are accepted. Requests over 2 MB, or with more than 500 spans, are cut off; spans past the limit are reported as rejected.
- **Agent id.** The `agent.id` resource attribute, falling back to `service.name`. A span with neither is rejected.
- **Ids.** `traceId` is 32 hex characters and `spanId` 16, as OpenTelemetry defines them. Zero ids are rejected.
- **Numbers.** Token counts must be non-negative integers and cost a finite amount under a trillion. A value that is not is dropped from that span, and the span is still stored.
- **Updates are monotonic.** Sending a span again merges it: the earliest start and latest end win, a span that has failed stays failed, and attributes combine with the newer value winning. A retry of an older update cannot shorten a span or erase an error.
- **Open spans.** A span sent without an end time is shown as running. Send it again later with the same ids and an end time, and it is updated in place. Earliest start, latest end and combined attributes win.
- **Response.** `200 { "partialSuccess": { "rejectedSpans": N, "errorMessage": "..." } }`, as OTLP specifies. A bad token is 401.

### Attributes Agent Kontrol understands

| Attribute | Used for |
| --- | --- |
| `agentkontrol.span.kind` | `session`, `turn`, `tool`, `model` or `other` |
| `tool.name` | marks a tool span |
| `gen_ai.request.model`, `gen_ai.response.model` | the model |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | token counts (the older `prompt_tokens` and `completion_tokens` also work) |
| `agentkontrol.cost_usd` | cost of the span |
| `session.id` | groups traces by session |

Without a kind hint, a span with `gen_ai.*` attributes is a model call, one with `tool.name` is a tool, and a span with no parent is a session.

## What is and is not stored

Prompts and tool payloads are the most sensitive data an agent touches, so they are **not stored by default**.

- Attributes whose names look like credentials (`secret`, `token`, `password`, `authorization`, `api_key`, `cookie`, `credential`, `private_key`) are dropped. This always applies.
- Prompt, completion, and tool input and output attributes (`gen_ai.prompt`, `gen_ai.completion`, `tool.input`, `tool.output`, and similar) are dropped unless you set `MC_TRACE_CAPTURE_CONTENT=1` on the server. The Claude Code hook also needs `MC_TRACE_CAPTURE_CONTENT=1` before it sends them, and truncates to 300 characters.
- Obvious credentials inside values, span names and status messages (API keys, bearer tokens, JWTs, GitHub and Slack tokens) are replaced with `[redacted]`. This is a best-effort filter, not a guarantee; the real protection is that content is not stored.
- Only strings, numbers and booleans are kept. Values are cut to 500 characters, names to 64, and a span keeps at most 40 attributes.
- Everything stored is plain Postgres data, unencrypted by this app, like the rest of your data. Use your provider's encryption at rest.

Turning content capture on means a leaked database or token exposes what your agents were asked and shown. Decide that on purpose.

## Retention

Spans older than `MC_TRACE_RETENTION_DAYS` (default 30) are deleted. Pruning runs on a small share of ingest requests, so no scheduler is needed and it can lag by a few hours on a quiet deployment.

## Reading traces from other tools

- `GET /api/traces?agent=<id>&errors=1&before=<ISO>&limit=<1-100>` returns summaries.
- `GET /api/traces/<traceId>` returns the spans.

Both accept the dashboard cookie or the bearer token. Forwarding traces on to Grafana, Honeycomb or another OpenTelemetry backend is not built yet; for now you can send the same spans to both places by configuring two exporters.

## Known limits

- Hook-based traces show what an agent did and how long it took. They do not include token counts or cost per model call, because Claude Code hooks do not expose them. Usage and Costs has those at the account level, and an SDK that exports `gen_ai.*` attributes fills them in per span.
- A trace for a session that crashed never receives its end, so its session span stays "running".
- Search is by agent and errors only, not by span name or attribute yet.
