# GitHub events inbox

Agent Kontrol can receive GitHub webhook deliveries instead of polling. One GitHub App webhook pointed at `POST /api/webhooks/github` covers every repo the App is installed on. Each accepted delivery becomes one row in `gh_events`. Consumers (#78) and the sweeper (#79) read that table; this document is the contract they build on.

The HTTP contract (status codes, check order, response bodies) is in [API.md](API.md#github-webhooks) and in `GET /api/openapi.json`.

## Setup (owner action)

Nothing here is configured by deploying the code. The owner sets:

1. `MC_GITHUB_WEBHOOK_SECRET` on the deployment. Until it is set, every delivery is `503` `not_configured` and nothing is stored.
2. In the GitHub App (or repository webhook) settings: the payload URL `https://<host>/api/webhooks/github`, content type `application/json`, the same secret, and the events listed below.
3. The schema: `supabase/schema.sql` creates `gh_events` on the next migrate. The dated file `supabase/migrations/20261030012111_gh_events.sql` is a changelog copy.

Send a ping from the App settings to check the secret: a correct setup answers `200`. A wrong secret is `401`. A form-encoded content type is `400` `invalid_json`.

## Security

- The HMAC signature is the only credential. The route is public in middleware on the exact path `/api/webhooks/github` only. A session cookie, `MC_TOKEN`, an agent credential, or an OAuth token is not accepted in place of the signature, and an edge proxy forwarding the request is not a grant.
- The signature is checked over the raw body bytes before the body is parsed. Whitespace, key order, Unicode, and newlines are signed as sent; nothing is re-serialized first.
- The body is capped at 1,048,576 bytes counted from the stream, not from `Content-Length`.
- Nothing in a payload is fetched, executed, or followed. Payload values reach SQL only as bound parameters: the payload is written as one `JSON.stringify(payload)::jsonb` parameter. A quote or a SQL fragment in a comment body is stored as text.
- A payload that Postgres `jsonb` cannot hold (a `U+0000`, an unpaired surrogate, or nesting deeper than 100 levels) is `400` and is not stored.

## Accepted events

| Event | `action` | `number` | `head_sha` |
| --- | --- | --- | --- |
| `pull_request` | `action` | `pull_request.number` | `pull_request.head.sha` |
| `pull_request_review` | `action` | `pull_request.number` | `pull_request.head.sha` |
| `issues` | `action` | `issue.number` | null |
| `issue_comment` | `action` | `issue.number` (an issue or a PR) | null |
| `check_suite` | `action` | the PR number when every entry in `check_suite.pull_requests` names the same one; otherwise null | `check_suite.head_sha` |
| `workflow_run` | `action` | the PR number when every entry in `workflow_run.pull_requests` names the same one; otherwise null | `workflow_run.head_sha` |
| `status` | null | null | `sha` |
| `push` | null | null | `after` (all zeros when a branch is deleted) |

`repo` is `repository.full_name` for every accepted event, as GitHub sent it (case preserved). A payload missing a field the table marks as a source (other than a `pull_requests` list) is `400` `validation_failed` and is not stored. The route does not guess a PR number: an empty, missing, or mixed `pull_requests` list stores null.

`ping` is `200` and is not stored. Any other event is `202` and is not stored.

## Table

```sql
create table if not exists gh_events (
  id bigserial primary key,
  delivery_id text not null unique check (char_length(delivery_id) between 1 and 200),
  event text not null check (char_length(event) between 1 and 64),
  action text,
  repo text,
  number bigint,
  head_sha text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists gh_events_received_at_idx on gh_events (received_at);
create index if not exists gh_events_pending_idx on gh_events (id) where processed_at is null;
```

- `id` increases with each insert. Consumers use it as a cursor (`where id > $last`). A rolled-back insert can leave a gap, so read by order, not by count.
- `delivery_id` is `X-GitHub-Delivery`. It is the dedupe key: a second insert with the same id changes nothing, not even `received_at`.
- `event` has no enum, so synthetic rows can use their own names.
- `received_at` is the database clock at insert. `processed_at` is null until a consumer sets it.
- Retention (deleting rows older than 30 days) belongs to the sweeper (#79). State a reducer derives from these rows must not depend on the history still being there.
- No grants, no `security definer`, no row-level policies are added. The table is reached through the app's own database role.

## Synthetic rows

Delivery ids that start with `sweep:` are reserved for rows written by Agent Kontrol itself, such as the sweeper (#79). The webhook route rejects that namespace (`400`), and real GitHub ids are GUIDs, so the two never collide.

The absence sweeper (#79, [VELOCITY.md](VELOCITY.md#absence-sweeper)) writes these `event` names: `consumer-silent`, `pr-stuck`, `pause-unexplained`, `pause-expired`, `resume-uncited`, `decision-aging`, `dispatch-ready-empty`, and each with `-cleared`. Delivery ids:

- firing: `sweep:<condition>:<entity digest>:e<episode>:s<seq>`
- cleared: `sweep:<condition>-cleared:<entity digest>:e<episode>`

The digest is the first 24 hex characters of the SHA-256 of the entity key (`consumer:<id>`, `pr:<owner/name lowercased>#<n>`, `job:<source>/<job>`, `decision:<key>`, `queue:<id>`). `repo`, `number`, and `head_sha` are filled where the condition has them. The payload is `{ condition, entity_key, state, verdict, episode, sequence, source: "agent-kontrol-sweeper", evaluated_at, evidence }`: bounded references (observation ids, counts, timestamps), never a prompt or a secret. The row and the latch change commit in one transaction.

### Retention

Each sweep deletes rows whose `received_at` is more than 30 days before the database clock, oldest first, in batches of 1,000 and at most 10 batches per run (`retention.complete` is false when more remain). This is an age horizon, not processing completion: GitHub rows and synthetic rows are removed alike, whether or not a consumer set `processed_at`. The sweeper's latches live in `sweep_latches` and are not affected.

## Writing from code

`src/lib/gh-events.ts` exports `insertGhEvent(input, db?)`. It runs one statement:

```sql
insert into gh_events (delivery_id, event, action, repo, number, head_sha, payload)
values ($1, $2, $3, $4, $5, $6, $7::jsonb)
on conflict (delivery_id) do nothing
returning id::text as id
```

It returns `{ stored: true, duplicate: false, id }` for a new row (`id` is a decimal string) or `{ stored: false, duplicate: true }`. It never begins or commits. Pass the tag from `withTransaction` as `db` to insert a row and update other state in one transaction:

```ts
await withTransaction(async (tx) => {
  const row = await insertGhEvent({ delivery_id: `sweep:${key}`, event: "sweep_condition", payload }, tx);
  if (row.stored) await tx`update ... where ...`;
});
```

`input.payload` must be a plain object. `delivery_id` is 1 to 200 characters and `event` 1 to 64, with no control characters; anything else throws `GhEventInputError` before any SQL runs.
