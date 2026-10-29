import packageJson from "../../package.json";
import { API_ERRORS } from "@/lib/api-error";
import { LABEL_MAX } from "@/lib/credentials";
import { DECISION_STATUSES, LIST_SHAPES, LIST_STATUSES } from "@/lib/decisions";
import { PROGRESS_INGEST_KINDS } from "@/lib/progress-store";
import { WINDOWS } from "@/lib/progress-config";
import { MAX_OWNERS } from "@/lib/owner-validation";
import { MAX_REPOS } from "@/lib/repo-validation";
import { SCOPES } from "@/lib/scopes";
import { INGEST_KINDS } from "@/lib/store";
import { TASK_STATUSES } from "@/lib/types";
import { USAGE_SOURCES } from "@/lib/usage-types";
import { USAGE_WINDOWS } from "@/lib/usage-window";
import { ACTIVITY_LIST, LIST_MAX } from "./list-params";
import { RUNTIMES } from "./skills/types";
import { WATCH_STATUSES } from "./watch";
import { WATCH_SOURCES } from "./watch-sources";

/**
 * OpenAPI 3.1 for the documented REST routes.
 *
 * Request fields come from the same constants and interfaces the handlers
 * use (scopes, repo limit, task statuses, decision statuses and list shapes,
 * ingest kinds, usage sources, error codes). Routes that only check
 * "present" still accept a wider string than the documented enum; the enum
 * is the contract in docs/API.md.
 *
 * MCP tool names are not listed here. They stay in docs/MCP.md.
 */

/** Keys of API_ERRORS, plus the scope denial that src/lib/scopes.ts returns. */
const ERROR_CODES = [...new Set([...Object.keys(API_ERRORS), "insufficient_scope"])];

type Json = Record<string, unknown>;

/** The nine names list_activity and GET /api/activity return. fields= may omit some. */
const ACTIVITY_ITEM_PROPERTIES: Json = Object.fromEntries(
  ACTIVITY_LIST.allow.map((name) => {
    if (name === "id") return [name, { type: "integer" }];
    if (name === "created_at") return [name, { type: "string", format: "date-time" }];
    if (name === "detail") return [name, { type: ["object", "null"], additionalProperties: true }];
    return [name, { type: ["string", "null"] }];
  }),
);

const INGEST_PLATFORMS = [
  "claude-code",
  "cowork-cloud",
  "chatgpt-work",
  "codex",
  "hermes",
  "other",
] as const;

const TASK_PLATFORMS = ["claude-code", "codex", "grok", "hermes", "cowork-cloud", "any"] as const;
const REVIEWER_PLATFORMS = ["claude-code", "codex", "grok"] as const;

function ref(name: string): Json {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schema: Json): Json {
  return { description, content: { "application/json": { schema } } };
}

function textResponse(description: string): Json {
  return { description, content: { "text/plain": { schema: { type: "string" } } } };
}

function query(name: string, schema: Json, description: string, opts?: { required?: boolean }): Json {
  return { name, in: "query", required: opts?.required === true, schema, description };
}

function listLimit(defaultLimit: number): Json {
  return { type: "integer", minimum: 1, maximum: LIST_MAX, default: defaultLimit };
}

const listCursor = query(
  "cursor",
  { type: "string" },
  "Opaque keyset cursor from next_cursor. A tampered or mismatched cursor is 400 validation_failed. It does not restart at the first page.",
);

const listFields = query(
  "fields",
  { type: "string" },
  "Comma-separated allowlisted names. The id is always returned (trace_id on traces). An unknown name, an empty name, or text that is not an allowlisted name is 400. Omitted returns the same columns as before. Names are not read from the database as SQL.",
);

function listLimitParam(defaultLimit: number): Json {
  return query(
    "limit",
    listLimit(defaultLimit),
    `Maximum rows, from 1 to ${LIST_MAX}. Default ${defaultLimit}. Above ${LIST_MAX}, zero, a negative, or a non-integer is 400. Passing limit or cursor adds next_cursor. Omitting both leaves the body without that field.`,
  );
}

const nextCursor: Json = {
  type: ["string", "null"],
  description:
    "Present only when the request passed limit or cursor. Null when there is no further page. Opaque; send it back as cursor.",
};

function pathParam(name: string, description: string, schema: Json = { type: "string" }): Json {
  return { name, in: "path", required: true, schema, description };
}

const idempotencyHeader: Json = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 200 },
  description:
    "Optional. A blank value is the same as omitting the header. 1 to 200 characters and no control characters; anything else is 400 validation_failed. The same key, the same actor, the same route, and the same body return the original result for 24 hours and do not insert a second row. After 24 hours the same key starts a new write. A different body is 409 idempotency_conflict and is not retryable. While the first request is inside its 30 second lease, the same body is 409 idempotency_conflict with retryable true, a Retry-After header, and retry_after in the body. The key is scoped by actor and route.",
};

const idempotencyConflict: Json = jsonResponse(
  "This Idempotency-Key was reused. code is idempotency_conflict. A different body is not retryable. The same body during the 30 second lease is retryable and includes Retry-After and retry_after.",
  ref("Error"),
);

function body(schema: Json): Json {
  return { required: true, content: { "application/json": { schema } } };
}

const cookieOrBearer = [{ cookieAuth: [] }, { bearerAuth: [] }];
const bearerOnly = [{ bearerAuth: [] }];
const sessionOnly = [{ cookieAuth: [] }];
/** Dashboard session or MC_TOKEN. Not the generic bearer that accepts an agent credential. */
const operatorSessionOrMcToken = [{ cookieAuth: [] }, { mcToken: [] }];

/** Server-set. A request body cannot write these. */
const actorType: Json = {
  type: ["string", "null"],
  enum: ["human", "agent", null],
  description:
    "Set by the server from the authenticated credential. human for a dashboard session (actor_id operator). agent for an agent credential, MC_TOKEN (actor_id mc-token), or an OAuth client. Null on older rows, and null when MC_DASHBOARD_PASSWORD is unset and the request presented no credential.",
};

const actorId: Json = {
  type: ["string", "null"],
  description:
    "Credential id, mc-token, the OAuth client id, or operator. Null in the same cases as actor_type.",
};

const dryRunFlag: Json = {
  type: "boolean",
  description:
    "When true, return what would change and write nothing. Omitted or false applies the write. Any other JSON type is 400 and writes nothing.",
};

const expectedRevision: Json = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description:
    "Optional token from the dry-run preview. For a memory row or a task it is the md5 of the whole row, computed in SQL on that same read. A memory key with no row uses the literal absent. When it no longer matches, the route answers 409 stale_write with current_revision and writes nothing. Omit it to keep the previous unconditional write. An empty string, a non-string, or a value longer than 200 characters is 400 and writes nothing.",
};

const staleWrite: Json = jsonResponse(
  "expected_revision does not match the current row. error and code are stale_write. current_revision is the token a new preview would return. Nothing was written.",
  {
    allOf: [
      ref("Error"),
      {
        type: "object",
        required: ["current_revision"],
        properties: {
          error: { type: "string", const: "stale_write" },
          code: { type: "string", const: "stale_write" },
          current_revision: { type: "string" },
        },
      },
    ],
  },
);

const flatErrors: Json = {
  "400": jsonResponse("The body is not JSON, a required field is missing, or a field failed validation.", ref("Error")),
  "401": jsonResponse("The credential is missing or not valid.", ref("Error")),
  "403": jsonResponse("An agent credential does not have the scope for this route.", ref("Error")),
  "500": jsonResponse("The handler failed. The body is internal_error and does not include the exception text.", ref("Error")),
};

function operation(spec: Json): Json {
  return spec;
}

export function openApiDocument(): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Kontrol",
      version: packageJson.version,
      summary: "REST API for the Agent Kontrol fleet dashboard.",
      description:
        "Documented routes from docs/API.md. Authentication is a dashboard session cookie, an MC_TOKEN bearer, or an agent credential whose scope covers the route. The MCP tool list is in docs/MCP.md, not in this document.",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "fleet" },
      { name: "tasks" },
      { name: "decisions" },
      { name: "messages" },
      { name: "memory" },
      { name: "progress" },
      { name: "settings" },
      { name: "usage" },
      { name: "traces" },
      { name: "activity" },
      { name: "skills" },
      { name: "auth" },
      { name: "mcp" },
      { name: "watch" },
    ],
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: "mc_auth" },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "MC_TOKEN, an akc_ agent credential, or an OAuth access token on the MCP transport.",
        },
        mcToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "MC_TOKEN",
          description: "Operator MC_TOKEN. An agent credential and an OAuth access token are not accepted on operations that use this scheme.",
        },
        agentCredential: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "akc_",
          description:
            "Per-agent akc_ credential. MC_TOKEN, the dashboard session, an OAuth access token, and a dev-open caller are not accepted on operations that use this scheme.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code", "fix", "retryable"],
          properties: {
            error: { type: "string" },
            code: {
              type: "string",
              enum: ERROR_CODES,
              description:
                "Keys of API_ERRORS in src/lib/api-error.ts. insufficient_scope is the additional code src/lib/scopes.ts returns when an agent credential cannot call the route.",
            },
            fix: { type: "string" },
            retryable: { type: "boolean" },
            fields: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        ErrorMessage: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
        BriefAlert: {
          type: "object",
          required: ["key", "kind", "condition", "sent", "last_sent_at", "summary"],
          properties: {
            key: { type: "string" },
            kind: { type: "string", enum: ["coordinator_silent", "zero_merge", "decision_age"] },
            condition: { type: "string", enum: ["firing", "clear", "unknown"] },
            sent: {
              type: ["boolean", "null"],
              description: "True when a latch is active. False when the table was read and this key is not latched. Null when the latch table could not be read.",
            },
            last_sent_at: { type: ["string", "null"], format: "date-time" },
            summary: { type: "string" },
          },
        },
        BriefAlerts: {
          type: "object",
          required: ["enabled", "delivery", "generated_at", "sent_count", "alerts"],
          properties: {
            enabled: { type: "boolean" },
            delivery: { type: "string", enum: ["read", "disabled", "live"] },
            generated_at: { type: "string", format: "date-time" },
            sent_count: { type: "integer" },
            alerts: { type: "array", items: ref("BriefAlert") },
            latches: { type: "string", enum: ["ok", "unknown"] },
            failures: {
              type: "array",
              items: {
                type: "object",
                required: ["step"],
                properties: {
                  step: { type: "string", enum: ["latches", "claim", "clear", "message", "restore"] },
                  key: { type: "string" },
                },
              },
            },
            note: { type: "string" },
          },
        },
        ReportInput: {
          type: "object",
          required: ["agent_id", "kind"],
          properties: {
            agent_id: { type: "string" },
            kind: { type: "string", enum: [...INGEST_KINDS] },
            platform: { type: "string", enum: [...INGEST_PLATFORMS] },
            machine: { type: "string" },
            display_name: { type: "string" },
            session_id: { type: "string" },
            title: { type: "string" },
            detail: { type: "object", additionalProperties: true },
            project: { type: "string" },
            summary: { type: "string" },
            status: { type: "string" },
          },
        },
        RepoInput: {
          type: "object",
          required: ["repo", "label", "short", "color", "blockedLabel"],
          properties: {
            repo: { type: "string", maxLength: 100, description: "owner/name" },
            label: { type: "string", minLength: 1, maxLength: 40 },
            short: { type: "string" },
            color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            blockedLabel: { type: ["string", "null"] },
            pinned: { type: "boolean", description: "Always show on the brief, including after the activity window. Hide wins over pin." },
            hidden: { type: "boolean", description: "Collected, but omitted from the brief and the board. Hide wins over pin." },
            origin: { type: "string", enum: ["manual", "auto"], description: "manual is hand-added. auto is discovered and is kept when a save omits it." },
          },
        },
        WatchedOwnerInput: {
          type: "object",
          required: ["owner"],
          properties: {
            owner: { type: "string", maxLength: 39, description: "GitHub user or organization login. Stored lowercase." },
            activity_days: { type: "integer", minimum: 1, maximum: 3650, description: "Repos with a push older than this drop off the brief. Default 30. The boundary day is still shown." },
            activityDays: { type: "integer", minimum: 1, maximum: 3650, description: "Same as activity_days. Sending both is 400." },
            include_forks: { type: "boolean", description: "Default false. Forks stay out of the brief unless this is true." },
            includeForks: { type: "boolean" },
            include_archived: { type: "boolean", description: "Default false." },
            includeArchived: { type: "boolean" },
          },
        },
        WatchedOwner: {
          type: "object",
          required: ["owner", "activity_days", "include_forks", "include_archived"],
          properties: {
            owner: { type: "string" },
            activity_days: { type: "integer" },
            include_forks: { type: "boolean" },
            include_archived: { type: "boolean" },
            last_error: { type: ["string", "null"], description: "Set when gh repo list failed, was rate-limited, or returned no repos. A truncated list stores a warning here and still sets last_discovered_at." },
            last_error_at: { type: ["string", "null"], format: "date-time" },
            last_discovered_at: { type: ["string", "null"], format: "date-time" },
            actor_type: { type: ["string", "null"], enum: ["human", "agent", null] },
            actor_id: { type: ["string", "null"] },
          },
        },
        WatchedOwners: {
          type: "object",
          required: ["writable", "max", "version", "owners"],
          properties: {
            writable: { type: "boolean" },
            max: { type: "integer", const: MAX_OWNERS },
            version: { type: "string" },
            owners: { type: "array", items: ref("WatchedOwner") },
          },
        },
        OwnerList: {
          type: "object",
          required: ["owners"],
          properties: {
            version: { type: "string", description: "Version from the last GET. A mismatch is 409 stale and writes nothing." },
            dry_run: dryRunFlag,
            owners: { type: "array", maxItems: MAX_OWNERS, items: ref("WatchedOwnerInput") },
          },
        },
        OwnerDiscovery: {
          type: "object",
          required: ["results"],
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                required: ["owner", "ok", "swept_at"],
                properties: {
                  owner: { type: "string" },
                  ok: { type: "boolean" },
                  error: { type: ["string", "null"] },
                  truncated: { type: "boolean", description: "True when gh repo list hit the 1000-repo cap. Seen repos are updated. Others are not marked gone." },
                  swept_at: { type: "string", format: "date-time", description: "Required. Collector time just before gh repo list. A sweep that is not newer than last_discovered_at is ignored." },
                  repos: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["name", "isArchived", "isFork"],
                      properties: {
                        name: { type: "string" },
                        pushedAt: { type: ["string", "null"], format: "date-time" },
                        isArchived: { type: "boolean" },
                        isFork: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        RepoOverride: {
          type: "object",
          required: ["repo"],
          anyOf: [
            { required: ["pinned"] },
            { required: ["hidden"] },
          ],
          properties: {
            repo: { type: "string", description: "owner/name" },
            pinned: { type: "boolean" },
            hidden: { type: "boolean", description: "Hide wins over pin. The repo stays collected and drops off the brief." },
            dry_run: dryRunFlag,
          },
        },
        RepoList: {
          type: "object",
          required: ["repos"],
          properties: {
            version: { type: "string", description: "Version from the last GET. A mismatch is 409 stale and writes nothing." },
            dry_run: dryRunFlag,
            repos: {
              type: "array",
              minItems: 1,
              maxItems: MAX_REPOS,
              items: ref("RepoInput"),
            },
          },
        },
        WatchedRepo: {
          type: "object",
          required: ["repo", "label", "short", "color", "blockedLabel"],
          properties: {
            repo: { type: "string", description: "owner/name" },
            label: { type: "string" },
            short: { type: "string" },
            color: { type: "string" },
            blockedLabel: { type: ["string", "null"] },
            origin: { type: "string", enum: ["manual", "auto"] },
            pinned: { type: "boolean", description: "Always show on the brief, including after the activity window. Hide wins over pin." },
            hidden: { type: "boolean", description: "Collected, but omitted from the brief and the board. Hide wins over pin." },
            gone: { type: "boolean", description: "True when the repo left the last successful non-truncated gh repo list. The row is kept. A gone repo is not shown, including when it is pinned." },
            shown: { type: "boolean", description: "False drops the repo off the brief and the board. Omitted means show." },
            isFork: { type: "boolean", description: "True when the repo is a fork." },
            isArchived: { type: "boolean", description: "True when the repo is archived." },
            lastActivityAt: { type: ["string", "null"], format: "date-time", description: "Last push time from gh. The activity window uses this." },
            fieldsOverridden: {
              type: ["boolean", "null"],
              description: "True after a hand-added save overrode label, short, color, or blocked label on an auto row. False after a later save cleared that override. Null means discovery owns those fields. Omitting the field is the same as null.",
            },
          },
        },
        WatchedRepos: {
          type: "object",
          required: ["source", "writable", "max", "version", "repos"],
          properties: {
            source: { type: "string", enum: ["database", "file"] },
            writable: { type: "boolean" },
            max: { type: "integer", const: MAX_REPOS },
            version: { type: "string" },
            repos: { type: "array", items: ref("WatchedRepo") },
          },
        },
        UsageFact: {
          type: "object",
          required: ["source", "account_id", "model", "last_seen_at"],
          properties: {
            source: { type: "string", enum: [...USAGE_SOURCES] },
            account_id: { type: "string" },
            profile: { type: ["string", "null"] },
            session_id: { type: ["string", "null"] },
            model: { type: "string" },
            billing_provider: { type: ["string", "null"] },
            billing_mode: { type: ["string", "null"] },
            cron_job_id: { type: ["string", "null"] },
            cron_job_name: { type: ["string", "null"] },
            task: { type: ["string", "null"] },
            api_call_count: { type: "number" },
            input_tokens: { type: "number" },
            output_tokens: { type: "number" },
            cache_read_tokens: { type: "number" },
            cache_write_tokens: { type: "number" },
            reasoning_tokens: { type: "number" },
            paid_cost_usd: { type: "number" },
            shadow_cost_usd: { type: "number" },
            price_version: { type: ["string", "null"] },
            cost_status: { type: ["string", "null"] },
            first_seen_at: { type: ["string", "null"] },
            last_seen_at: { type: "string", format: "date-time" },
            detail: { type: ["object", "null"], additionalProperties: true },
          },
        },
        UsageIngest: {
          type: "object",
          required: ["facts"],
          properties: {
            collected_at: { type: "string", format: "date-time" },
            kind: { type: "string" },
            facts: { type: "array", items: ref("UsageFact") },
            snapshot: {
              type: "object",
              required: ["account_id"],
              properties: {
                account_id: { type: "string" },
                collected_at: { type: "string", format: "date-time" },
                balance_usd: { type: ["number", "null"] },
                credits_remaining: { type: ["number", "null"] },
                quota_detail: {},
                detail: {},
              },
            },
          },
        },
        ProgressIngest: {
          type: "object",
          required: ["repos"],
          properties: {
            collected_at: { type: "string", format: "date-time" },
            kind: { type: "string", enum: [...PROGRESS_INGEST_KINDS] },
            repos: {
              type: "array",
              minItems: 1,
              items: ref("SnapshotInput"),
            },
          },
        },
        SnapshotInput: {
          type: "object",
          required: ["repo"],
          properties: {
            repo: { type: "string" },
            label: { type: "string" },
            open_issues: { type: "number" },
            open_prs: { type: "number" },
            blocked_issues: { type: "number" },
            merged_prs_24h: { type: "number" },
            issues_closed_24h: { type: "number" },
            issues_opened_24h: { type: "number" },
            total_issues_created: { type: "number" },
            total_issues_closed: { type: "number" },
            total_prs_merged: { type: "number" },
            review_rounds: { type: "number" },
            no_verdict_rate: { type: "number" },
            detail: { type: "object", additionalProperties: true },
          },
        },
        CreateTask: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            project: { type: "string" },
            platform: { type: "string", enum: [...TASK_PLATFORMS] },
            machine: { type: "string" },
            priority: { type: "integer", minimum: 1, maximum: 3 },
            reviewer_platform: { type: "string", enum: [...REVIEWER_PLATFORMS] },
            created_by: {
              type: "string",
              description: "Free-text label stored on the task. It does not set actor_type or actor_id.",
            },
          },
        },
        ClaimTask: {
          type: "object",
          required: ["platform", "agent_id"],
          properties: {
            platform: { type: "string" },
            machine: { type: "string" },
            agent_id: { type: "string" },
          },
        },
        PatchTask: {
          type: "object",
          properties: {
            status: { type: "string", enum: [...TASK_STATUSES] },
            result: { type: "string" },
            cost_usd: { type: "number" },
            session_id: { type: "string" },
            assigned_agent: { type: "string" },
            agent_id: { type: "string" },
            dry_run: dryRunFlag,
            expected_revision: expectedRevision,
          },
        },
        Task: {
          type: "object",
          required: [
            "id",
            "title",
            "description",
            "project",
            "platform",
            "machine",
            "priority",
            "status",
            "reviewer_platform",
            "assigned_agent",
            "session_id",
            "result",
            "cost_usd",
            "created_by",
            "actor_type",
            "actor_id",
            "created_at",
            "claimed_at",
            "updated_at",
            "completed_at",
          ],
          properties: {
            id: { type: "integer" },
            title: { type: "string" },
            description: { type: ["string", "null"] },
            project: { type: ["string", "null"] },
            platform: { type: "string", enum: [...TASK_PLATFORMS] },
            machine: { type: ["string", "null"] },
            priority: { type: "integer" },
            status: { type: "string", enum: [...TASK_STATUSES] },
            reviewer_platform: { type: ["string", "null"], enum: [...REVIEWER_PLATFORMS, null] },
            assigned_agent: { type: ["string", "null"] },
            session_id: { type: ["string", "null"] },
            result: { type: ["string", "null"] },
            cost_usd: { type: ["number", "null"] },
            created_by: { type: ["string", "null"] },
            actor_type: actorType,
            actor_id: actorId,
            created_at: { type: "string", format: "date-time" },
            claimed_at: { type: ["string", "null"], format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            completed_at: { type: ["string", "null"], format: "date-time" },
          },
        },
        Message: {
          type: "object",
          required: [
            "id",
            "agent_id",
            "body",
            "created_by",
            "actor_type",
            "actor_id",
            "created_at",
            "delivered_at",
            "acked_at",
            "direction",
            "in_reply_to",
            "thread_id",
            "read_by_dashboard_at",
          ],
          properties: {
            id: { type: "integer" },
            agent_id: { type: "string" },
            body: { type: "string" },
            created_by: {
              type: ["string", "null"],
              description: "Free-text label. It does not set actor_type or actor_id.",
            },
            actor_type: actorType,
            actor_id: actorId,
            created_at: { type: "string", format: "date-time" },
            delivered_at: { type: ["string", "null"], format: "date-time" },
            acked_at: { type: ["string", "null"], format: "date-time" },
            direction: { type: "string", enum: ["inbound", "outbound"] },
            in_reply_to: { type: ["integer", "null"] },
            thread_id: { type: ["string", "null"] },
            read_by_dashboard_at: { type: ["string", "null"], format: "date-time" },
          },
        },
        MemoryItem: {
          type: "object",
          required: ["id", "key", "content", "tags", "agent_id", "created_at", "updated_at"],
          properties: {
            id: { type: "integer" },
            key: { type: ["string", "null"] },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            agent_id: { type: ["string", "null"] },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        RememberInput: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "string" },
            key: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "1 to 200 characters and no control characters. Omit it to insert a note with no key. Null is treated as omitted.",
            },
            tags: { type: "array", items: { type: "string" } },
            agent_id: { type: ["string", "null"] },
            dry_run: dryRunFlag,
            expected_revision: expectedRevision,
          },
        },
        DryRunChange: {
          type: "object",
          required: ["op", "summary", "before", "after"],
          properties: {
            op: { type: "string", enum: ["add", "remove", "update", "reorder", "overwrite", "insert"] },
            summary: { type: "string" },
            before: { type: ["object", "null"], additionalProperties: true },
            after: { type: ["object", "null"], additionalProperties: true },
          },
        },
        DryRunResult: {
          type: "object",
          required: ["dry_run", "applied", "would_write", "action", "changes", "affected"],
          properties: {
            dry_run: { type: "boolean", const: true },
            applied: { type: "boolean", const: false },
            would_write: { type: "boolean" },
            action: {
              type: "string",
              enum: ["replace_repos", "replace_owners", "cancel_task", "update_task", "overwrite_memory", "insert_memory"],
            },
            changes: { type: "array", items: ref("DryRunChange") },
            affected: { type: "array", items: { type: "object", additionalProperties: true } },
            expected_revision: {
              type: "string",
              description:
                "Token to send back as expected_revision. The md5 of the row from the same read, or the literal absent when a memory key has no row.",
            },
            note: { type: "string" },
          },
        },
        Decision: {
          type: "object",
          required: [
            "id",
            "key",
            "source",
            "repo",
            "repo_short",
            "number",
            "url",
            "title",
            "why",
            "options",
            "recommended",
            "requested_by",
            "status",
            "decision",
            "decided_by",
            "decided_at",
            "defer_until",
            "kind",
            "labels",
            "opened_at",
            "github_present",
            "first_seen_at",
            "last_seen_at",
            "created_at",
            "updated_at",
            "revision",
            "age_days",
            "actor_type",
            "actor_id",
            "chosen_option",
            "writeback",
          ],
          properties: {
            id: { type: "integer" },
            key: { type: "string" },
            source: { type: "string" },
            repo: { type: ["string", "null"], description: "owner/name. The morning brief joins on this." },
            repo_short: { type: ["string", "null"], description: "Config short name. Display only." },
            number: { type: ["integer", "null"] },
            url: { type: ["string", "null"] },
            title: { type: "string" },
            why: { type: ["string", "null"] },
            options: { description: "JSON value stored with the row. Null when unset." },
            recommended: { type: ["string", "null"] },
            requested_by: { type: ["string", "null"] },
            status: { type: "string", enum: [...DECISION_STATUSES] },
            decision: { type: ["string", "null"] },
            decided_by: { type: ["string", "null"] },
            decided_at: { type: ["string", "null"], format: "date-time" },
            defer_until: { type: ["string", "null"], format: "date-time" },
            kind: { type: ["string", "null"], enum: ["issue", "pr", null] },
            labels: { type: ["array", "null"], items: { type: "string" }, description: "Null when the column was never written. An empty list is a real value." },
            opened_at: { type: ["string", "null"], format: "date-time" },
            github_present: { type: ["boolean", "null"] },
            first_seen_at: { type: "string", format: "date-time" },
            last_seen_at: { type: "string", format: "date-time" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            revision: {
              type: "integer",
              minimum: 0,
              description: "Optimistic concurrency token. Increments on every mutation. Not a timestamp.",
            },
            age_days: { type: "integer", description: "Whole days from opened_at, else first_seen_at, to now." },
            actor_type: { type: ["string", "null"], enum: ["human", "agent", null] },
            actor_id: { type: ["string", "null"] },
            chosen_option: { type: ["string", "null"] },
            writeback: {
              type: ["string", "null"],
              enum: ["written", "not_written", null],
              description: "Null when the row has no GitHub target, or before it is decided. not_written means the row is decided and the GitHub comment did not land.",
            },
          },
        },
        BriefDecision: {
          type: "object",
          required: ["repo", "repo_short", "number", "title", "url", "kind", "age_hours", "age_days", "labels"],
          properties: {
            repo: { type: "string", description: "owner/name." },
            repo_short: { type: "string", description: "Config short name. Display only." },
            number: { type: "integer" },
            title: { type: "string" },
            url: { type: "string" },
            kind: { type: "string", enum: ["issue", "pr"] },
            age_hours: { type: "number" },
            age_days: { type: "integer" },
            labels: { type: "array", items: { type: "string" } },
          },
        },
        DecisionUpsert: {
          type: "object",
          required: ["key", "source", "title"],
          description:
            "Upsert by key. A body field status does not decide the row. A new key is open. decided and deferred stay unless force is true. withdrawn returns to open without force. A github-label upsert that omits github_present stores true.",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 300 },
            source: { type: "string", description: "Short lowercase slug." },
            repo: { type: ["string", "null"], description: "owner/name." },
            repo_short: { type: ["string", "null"], maxLength: 64 },
            number: { type: ["integer", "null"], minimum: 1 },
            url: { type: ["string", "null"] },
            title: { type: "string", minLength: 1, maxLength: 500 },
            why: { type: ["string", "null"] },
            options: { type: ["array", "null"], maxItems: 20 },
            recommended: { type: ["string", "null"] },
            requested_by: { type: ["string", "null"] },
            kind: { type: ["string", "null"], enum: ["issue", "pr", null] },
            labels: { type: ["array", "null"], maxItems: 30, items: { type: "string", minLength: 1, maxLength: 100 } },
            opened_at: { type: ["string", "null"], format: "date-time" },
            first_seen_at: { type: ["string", "null"], format: "date-time" },
            github_present: { type: ["boolean", "null"] },
            force: {
              type: "boolean",
              description: "When true, reopen a decided or deferred row to open and clear the answer. Omitted is false.",
            },
          },
        },
        DecisionReconcile: {
          type: "object",
          required: ["reconcile"],
          description: "Withdraw label-sourced rows for one repo that this sweep did not see. Mutually exclusive with a decision upsert.",
          properties: {
            reconcile: {
              type: "object",
              required: ["repo", "seen_keys"],
              properties: {
                repo: { type: "string", description: "owner/name." },
                source: { type: "string", default: "github-label", description: "Short lowercase slug. Default github-label." },
                seen_keys: {
                  type: "array",
                  maxItems: 5000,
                  items: { type: "string" },
                  description: "Keys still present. Each must start with github:<repo>#. Empty withdraws every row for that repo and source.",
                },
              },
            },
          },
        },
        PatchDecision: {
          type: "object",
          minProperties: 1,
          description:
            "At least one of status, decision, decided_by, or defer_until. status decided requires decision text or option_id and sets decided_at to now. status deferred requires defer_until in the future. A date-only defer_until is the end of that UTC day. A past or impossible date is 400 validation_failed. status open clears the answer. status withdrawn sets github_present false. decided_by in this body is ignored. The stored decided_by and actor fields come from the principal, and are null for dev-open. expected_revision must match the row or the response is 409 stale. expected_updated_at is accepted and is not compared. Deciding, deferring, or withdrawing a decided or withdrawn row is 409 conflict. Reopening while an unexpired write-back claim holds the row is 409 writeback_in_progress.",
          properties: {
            status: { type: "string", enum: [...DECISION_STATUSES] },
            decision: { type: ["string", "null"] },
            decided_by: { type: ["string", "null"], description: "Ignored. The stored actor comes from the principal." },
            defer_until: { type: ["string", "null"], format: "date-time" },
            option_id: { type: "string" },
            expected_updated_at: { type: "string", format: "date-time", description: "Accepted for older clients. Not compared." },
            expected_revision: { type: "integer", minimum: 0, description: "revision from the row you loaded. A mismatch is 409 stale." },
          },
        },
        RetryDecisionWriteback: {
          type: "object",
          description: "Retry the GitHub comment for a decided row. Does not decide the row again. expected_revision is the concurrency token. expected_updated_at is accepted and is not compared.",
          properties: {
            expected_updated_at: { type: "string", format: "date-time" },
            expected_revision: { type: "integer", minimum: 0 },
          },
        },
        CreateCredential: {
          type: "object",
          required: ["label", "scopes"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: LABEL_MAX },
            scopes: {
              type: "array",
              minItems: 1,
              maxItems: SCOPES.length,
              items: { type: "string", enum: [...SCOPES] },
            },
            expires_at: { type: ["string", "null"], format: "date-time" },
          },
        },
        WatchBeatWrite: {
          type: "object",
          additionalProperties: false,
          required: ["source", "status", "detail", "beat_at"],
          properties: {
            source: { type: "string", enum: [...WATCH_SOURCES] },
            status: { type: "string", enum: [...WATCH_STATUSES] },
            detail: {
              type: "string",
              description: "At most 500 Unicode code points. Empty is allowed.",
            },
            beat_at: {
              type: "string",
              format: "date-time",
              description:
                "Finite RFC 3339 instant with an explicit Z or ±HH:MM offset. The sender clock does not decide freshness.",
            },
          },
        },
        WatchBeat: {
          type: "object",
          required: ["source", "status", "detail", "beat_at", "received_at", "age_s"],
          properties: {
            source: { type: "string", enum: [...WATCH_SOURCES] },
            status: { type: "string", enum: [...WATCH_STATUSES] },
            detail: { type: "string" },
            beat_at: { type: "string", format: "date-time" },
            received_at: { type: "string", format: "date-time" },
            age_s: {
              type: "integer",
              minimum: 0,
              description: "Whole seconds from the database clock to received_at, never below 0. Not derived from beat_at.",
            },
          },
        },
      },
    },
    paths: {
      "/api/openapi.json": {
        get: operation({
          operationId: "getOpenApi",
          tags: ["auth"],
          summary: "OpenAPI 3.1 document for these routes.",
          security: [],
          responses: {
            "200": jsonResponse("This document.", { type: "object" }),
          },
        }),
      },
      "/api/login": {
        post: operation({
          operationId: "login",
          tags: ["auth"],
          summary: "Exchange the dashboard password for an mc_auth cookie.",
          security: [],
          requestBody: body({
            type: "object",
            properties: { password: { type: "string" } },
          }),
          responses: {
            "200": jsonResponse("Password accepted. Sets the mc_auth cookie.", {
              type: "object",
              required: ["ok"],
              properties: { ok: { type: "boolean" } },
            }),
            "400": jsonResponse("The body is not JSON. error stays invalid request.", ref("Error")),
            "401": jsonResponse("Wrong password.", ref("Error")),
            "429": jsonResponse("More than 5 attempts in 10 minutes from one client IP.", ref("Error")),
          },
        }),
      },
      "/api/fleet": {
        get: operation({
          operationId: "getFleet",
          tags: ["fleet"],
          summary: "Everything the dashboard needs in one call.",
          security: cookieOrBearer,
          responses: {
            "200": jsonResponse("Fleet agents, sessions, and recent events.", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/ingest": {
        post: operation({
          operationId: "ingestStatus",
          tags: ["fleet"],
          summary: "Record liveness from a hook, watcher, or daemon.",
          security: bearerOnly,
          requestBody: body(ref("ReportInput")),
          responses: {
            "200": jsonResponse("Stored, or dropped in demo mode.", { type: "object", properties: { ok: { type: "boolean" } } }),
            ...flatErrors,
          },
        }),
      },
      "/api/memory": {
        get: operation({
          operationId: "listMemory",
          tags: ["memory"],
          summary: "Memory browser feed.",
          security: cookieOrBearer,
          parameters: [
            query("query", { type: "string" }, "Free-text search."),
            query("tag", { type: "string" }, "One tag."),
            listLimitParam(50),
            listCursor,
            listFields,
          ],
          responses: {
            "200": jsonResponse("Matching notes, newest update first. next_cursor is absent unless limit or cursor was passed.", {
              type: "object",
              properties: {
                demo: { type: "boolean" },
                items: { type: "array", items: ref("MemoryItem") },
                next_cursor: nextCursor,
              },
            }),
            ...flatErrors,
          },
        }),
        post: operation({
          operationId: "remember",
          tags: ["memory"],
          summary: "Store a note, or preview the write.",
          description:
            "The REST twin of MCP remember. An agent credential needs memory:write. dry_run true returns the insert or the key overwrite and writes nothing. action is overwrite_memory when the key already exists, otherwise insert_memory. The preview includes expected_revision, the md5 of the row from that same read, or the literal absent when the key has no row. Sending that token makes the write conditional: a mismatch is 409 stale_write with current_revision and writes nothing. When expected_revision is present and the key is already gone, the route answers 404 not_found and writes nothing. Omitting expected_revision keeps the unconditional write. A non-boolean dry_run, or an expected_revision that is empty, non-string, or longer than 200 characters, is 400 and writes nothing. With no database, a dry run still describes the note and sets would_write to false. A confirm that omits expected_revision still answers the demo acknowledgement and does not store the note.",
          security: cookieOrBearer,
          requestBody: body(ref("RememberInput")),
          responses: {
            "200": jsonResponse("The stored note, or a preview that writes nothing.", {
              oneOf: [
                {
                  type: "object",
                  required: ["ok", "applied"],
                  properties: {
                    ok: { type: "boolean" },
                    applied: { type: "boolean" },
                    demo: { type: "boolean" },
                    note: { type: "string" },
                    item: ref("MemoryItem"),
                  },
                },
                ref("DryRunResult"),
              ],
            }),
            ...flatErrors,
            "404": jsonResponse(
              "No memory row has this key when expected_revision is present. code is not_found and error is not found. A missing key with no expected_revision still inserts.",
              ref("Error"),
            ),
            "409": staleWrite,
          },
        }),
      },
      "/api/messages": {
        get: operation({
          operationId: "listMessages",
          tags: ["messages"],
          summary: "Inbound inbox, or the full conversation.",
          security: cookieOrBearer,
          parameters: [
            query("agent_id", { type: "string" }, "Agent whose messages to read. Required.", { required: true }),
            query("ack", { type: "boolean" }, "When true, mark the returned inbound messages read."),
            query("conversation", { type: "boolean" }, "When true, return the full history."),
          ],
          responses: {
            "200": jsonResponse("Messages for the agent. Each message carries server-set actor_type and actor_id.", {
              type: "object",
              properties: {
                demo: { type: "boolean" },
                messages: { type: "array", items: ref("Message") },
              },
            }),
            ...flatErrors,
            "503": jsonResponse("The messages table is not set up.", ref("Error")),
          },
        }),
        post: operation({
          operationId: "enqueueMessage",
          tags: ["messages"],
          summary: "Operator enqueues an inbound message.",
          description:
            "The server sets actor_type and actor_id from the authenticated credential. created_by is a label and does not set those fields. When MC_DASHBOARD_PASSWORD is unset and the request presents no credential, both actor fields are null. body is at most 8000 characters. A longer body is 400 validation_failed and stores nothing. Optional header Idempotency-Key.",
          security: cookieOrBearer,
          parameters: [idempotencyHeader],
          requestBody: body({
            type: "object",
            required: ["agent_id", "body"],
            properties: {
              agent_id: { type: "string" },
              body: { type: "string", maxLength: 8000 },
              created_by: { type: "string" },
            },
          }),
          responses: {
            "200": jsonResponse("The message was stored. actor_type and actor_id are on message.", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                id: { type: "integer" },
                demo: { type: "boolean" },
                note: { type: "string" },
                message: ref("Message"),
              },
            }),
            ...flatErrors,
            "409": idempotencyConflict,
            "503": jsonResponse("The messages table is not set up.", ref("Error")),
          },
        }),
        patch: operation({
          operationId: "markMessagesRead",
          tags: ["messages"],
          summary: "Operator marks outbound replies read.",
          security: cookieOrBearer,
          requestBody: body({
            type: "object",
            required: ["agent_id"],
            properties: { agent_id: { type: "string" } },
          }),
          responses: {
            "200": jsonResponse("Replies marked read.", { type: "object" }),
            ...flatErrors,
            "503": jsonResponse("The messages table is not set up.", ref("Error")),
          },
        }),
      },
      "/api/messages/reply": {
        post: operation({
          operationId: "replyToOperator",
          tags: ["messages"],
          summary: "A non-MCP agent posts a reply.",
          description:
            "actor_type and actor_id are taken from the bearer, not from created_by. A dashboard session is human / operator. MC_TOKEN is agent / mc-token. Optional header Idempotency-Key.",
          security: bearerOnly,
          parameters: [idempotencyHeader],
          requestBody: body({
            type: "object",
            required: ["agent_id", "body"],
            properties: {
              agent_id: { type: "string" },
              body: { type: "string" },
              in_reply_to: { type: "integer" },
              created_by: { type: "string" },
            },
          }),
          responses: {
            "200": jsonResponse("The reply was stored. actor_type and actor_id are on message.", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                id: { type: "integer" },
                demo: { type: "boolean" },
                note: { type: "string" },
                message: ref("Message"),
              },
            }),
            ...flatErrors,
            "404": jsonResponse("in_reply_to does not exist.", ref("Error")),
            "409": idempotencyConflict,
            "503": jsonResponse("The messages table is not set up.", ref("Error")),
          },
        }),
      },
      "/api/tasks": {
        get: operation({
          operationId: "listTasks",
          tags: ["tasks"],
          summary: "List tasks.",
          security: cookieOrBearer,
          parameters: [
            query(
              "status",
              { type: "string", enum: ["open", "all", ...TASK_STATUSES] },
              "open, all, or one status. Default all on this route.",
            ),
            listLimitParam(100),
            listCursor,
            listFields,
          ],
          responses: {
            "200": jsonResponse("Tasks. actor_type and actor_id are server-set. next_cursor is absent unless limit or cursor was passed.", {
              type: "object",
              properties: {
                demo: { type: "boolean" },
                tasks: { type: "array", items: ref("Task") },
                next_cursor: nextCursor,
              },
            }),
            ...flatErrors,
          },
        }),
        post: operation({
          operationId: "createTask",
          tags: ["tasks"],
          summary: "Create a task.",
          description:
            "actor_type and actor_id on the returned task come from the authenticated credential. The body cannot set them. created_by is only a label. Optional header Idempotency-Key. The key is not a body field.",
          security: cookieOrBearer,
          parameters: [idempotencyHeader],
          requestBody: body(ref("CreateTask")),
          responses: {
            "200": jsonResponse("The task was queued, replayed for this Idempotency-Key, or dropped in demo mode.", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                demo: { type: "boolean" },
                note: { type: "string" },
                task: ref("Task"),
              },
            }),
            ...flatErrors,
            "409": idempotencyConflict,
          },
        }),
      },
      "/api/tasks/claim": {
        post: operation({
          operationId: "claimTask",
          tags: ["tasks"],
          summary: "Atomically claim the next queued task for a platform.",
          security: cookieOrBearer,
          requestBody: body(ref("ClaimTask")),
          responses: {
            "200": jsonResponse("The claimed task, or task null when none is queued.", {
              type: "object",
              properties: {
                task: { oneOf: [ref("Task"), { type: "null" }] },
              },
            }),
            ...flatErrors,
          },
        }),
      },
      "/api/tasks/{id}": {
        patch: operation({
          operationId: "updateTask",
          tags: ["tasks"],
          summary: "Report progress, cancel a task, or preview that write.",
          description:
            "dry_run true returns the affected task and the field diff and writes nothing. action is cancel_task when status is cancelled, otherwise update_task. The preview includes expected_revision. Sending that token makes the update conditional: a mismatch is 409 stale_write with current_revision and writes nothing, including no activity event. Omitting expected_revision keeps the unconditional update. A missing id is still 404. A non-boolean dry_run, or an expected_revision that is empty, non-string, or longer than 200 characters, is 400 and writes nothing. With no database, a dry run returns would_write false. A confirm that omits expected_revision still answers the demo acknowledgement and does not update a task.",
          security: cookieOrBearer,
          parameters: [pathParam("id", "Task id.", { type: "integer" })],
          requestBody: body(ref("PatchTask")),
          responses: {
            "200": jsonResponse("The updated task, a demo acknowledgement, or a preview that writes nothing.", {
              oneOf: [
                {
                  type: "object",
                  required: ["ok"],
                  properties: {
                    ok: { type: "boolean" },
                    demo: { type: "boolean" },
                    task: ref("Task"),
                  },
                },
                ref("DryRunResult"),
              ],
            }),
            ...flatErrors,
            "404": jsonResponse("No task has this id when a database is connected. Also when expected_revision is present and the id is already gone.", ref("Error")),
            "409": staleWrite,
          },
        }),
      },
      "/api/decisions": {
        get: operation({
          operationId: "listDecisions",
          tags: ["decisions"],
          summary: "Decision queue, oldest first.",
          description:
            "Dashboard session or MC_TOKEN. An agent credential is denied, including one that holds decisions:write, with 403 and code insufficient_scope. status defaults to open and also returns deferred rows whose defer_until has passed. shape defaults to row. shape=brief ignores status and source: decisions is the morning-brief list from complete github-label rows, and incomplete_repos names owner/name repos whose brief-eligible rows are missing kind, labels, opened_at, or repo_short. A rejected status, shape, repo, source, or limit is 400 validation_failed.",
          security: cookieOrBearer,
          parameters: [
            query(
              "status",
              { type: "string", enum: [...LIST_STATUSES], default: "open" },
              "open, decided, deferred, withdrawn, or all. Default open. Ignored when shape is brief.",
            ),
            query(
              "shape",
              { type: "string", enum: [...LIST_SHAPES], default: "row" },
              "row is the queue. brief is the morning-brief decisions list plus incomplete_repos. Default row.",
            ),
            query("repo", { type: "string" }, "owner/name. Applies to row and brief."),
            query("source", { type: "string" }, "Source slug. Ignored when shape is brief."),
            query(
              "limit",
              { type: "integer", minimum: 1, maximum: 1000, default: 500 },
              "Maximum rows. Default 500. Maximum 1000.",
            ),
            query(
              "writeback",
              { type: "string", enum: ["written", "not_written"] },
              "When set, only rows with this write-back stamp. Ignored when shape is brief.",
            ),
          ],
          responses: {
            "200": jsonResponse("Queue rows, the morning-brief list, or an empty demo list.", {
              oneOf: [
                {
                  type: "object",
                  required: ["demo", "decisions"],
                  description: "No database. shape is ignored.",
                  properties: {
                    demo: { type: "boolean", const: true },
                    decisions: { type: "array", maxItems: 0, items: ref("Decision") },
                  },
                },
                {
                  type: "object",
                  required: ["demo", "decisions"],
                  description: "shape=row.",
                  properties: {
                    demo: { type: "boolean", const: false },
                    decisions: { type: "array", items: ref("Decision") },
                  },
                },
                {
                  type: "object",
                  required: ["demo", "decisions", "incomplete_repos"],
                  description: "shape=brief.",
                  properties: {
                    demo: { type: "boolean", const: false },
                    decisions: { type: "array", items: ref("BriefDecision") },
                    incomplete_repos: { type: "array", items: { type: "string" } },
                  },
                },
              ],
            }),
            ...flatErrors,
          },
        }),
        post: operation({
          operationId: "upsertDecision",
          tags: ["decisions"],
          summary: "Upsert one decision, or reconcile a collector sweep.",
          description:
            "Dashboard session or MC_TOKEN. An agent credential is denied, including one that holds decisions:write, with 403 and code insufficient_scope. Send either a decision (key, source, title) or { reconcile }, not both. A non-JSON body is 400 invalid_json. A missing key, source, or title is 400 missing_field. Any other rejected field is 400 validation_failed. force true while an unexpired write-back claim holds a decided or deferred row is 409 writeback_in_progress and does not change the row. With no database the response is ok, demo, and note, and the row is dropped.",
          security: cookieOrBearer,
          requestBody: body({ oneOf: [ref("DecisionUpsert"), ref("DecisionReconcile")] }),
          responses: {
            "200": jsonResponse("The stored row, the reconcile counts, or a demo acknowledgement.", {
              oneOf: [
                {
                  type: "object",
                  required: ["ok", "demo", "note"],
                  properties: {
                    ok: { type: "boolean", const: true },
                    demo: { type: "boolean", const: true },
                    note: { type: "string" },
                  },
                },
                {
                  type: "object",
                  required: ["ok", "decision", "status_held"],
                  properties: {
                    ok: { type: "boolean", const: true },
                    decision: ref("Decision"),
                    status_held: {
                      type: "boolean",
                      description: "True when a decided or deferred row kept its status because force was not set.",
                    },
                  },
                },
                {
                  type: "object",
                  required: ["ok", "reconciled", "withdrawn"],
                  properties: {
                    ok: { type: "boolean", const: true },
                    reconciled: { type: "integer" },
                    withdrawn: { type: "integer" },
                  },
                },
              ],
            }),
            ...flatErrors,
          },
        }),
      },
      "/api/decisions/{id}": {
        patch: operation({
          operationId: "patchDecision",
          tags: ["decisions"],
          summary: "Record a decision, a deferral, or a withdrawal.",
          description:
            "Dashboard session, MC_TOKEN, or an agent credential with decisions:write. An agent credential without that scope is 403 insufficient_scope. decided_by in the body is ignored. The stored actor is the principal, or null for dev-open. status decided records the row and then comments on the GitHub issue named by the row key and removes the decision labels. A failed write-back still decides the row and sets writeback to not_written. A past or invalid defer_until is 400 validation_failed. expected_revision that does not match is 409 stale. expected_updated_at is accepted and is not compared. A decided or withdrawn row is 409 conflict, including a body that omits status. status open is the reopen, except while an unexpired write-back claim holds the row, which is 409 writeback_in_progress. A non-integer id is 400 validation_failed. A non-JSON body is 400 invalid_json. A body with none of status, decision, decided_by, or defer_until is 400 missing_field. An unknown id, when a database is connected, is 404 not_found and error stays Decision not found. Demo mode does not look the id up.",
          security: cookieOrBearer,
          parameters: [pathParam("id", "Decision id.", { type: "integer", minimum: 1 })],
          requestBody: body(ref("PatchDecision")),
          responses: {
            "200": jsonResponse("The updated row, or a demo acknowledgement.", {
              oneOf: [
                {
                  type: "object",
                  required: ["ok", "demo"],
                  properties: {
                    ok: { type: "boolean", const: true },
                    demo: { type: "boolean", const: true },
                  },
                },
                {
                  type: "object",
                  required: ["ok", "decision"],
                  properties: {
                    ok: { type: "boolean", const: true },
                    decision: ref("Decision"),
                  },
                },
              ],
            }),
            ...flatErrors,
            "404": jsonResponse(
              "No decision has this id when a database is connected. code is not_found and error is Decision not found.",
              ref("Error"),
            ),
            "409": jsonResponse(
              "code stale when expected_revision does not match. code conflict when the row is already decided or withdrawn. code writeback_in_progress when an unexpired write-back claim holds the row.",
              ref("Error"),
            ),
          },
        }),
      },
      "/api/decisions/{id}/writeback": {
        post: operation({
          operationId: "retryDecisionWriteback",
          tags: ["decisions"],
          summary: "Retry the GitHub comment for a decided row.",
          description:
            "Dashboard session, MC_TOKEN, or an agent credential with decisions:write. An agent credential without that scope is 403 insufficient_scope. Posts the decision comment unless an existing comment contains the full canonical text for this row, then removes decision labels. A marker alone does not count. Concurrent retries share a per-row lock. The issue is the one named by the row key. Does not decide the row again. A row that is not decided is 409 conflict. expected_revision that does not match is 409 stale. expected_updated_at is accepted and is not compared. No token, a GitHub 403 or 404, a network error, or a closed issue leaves writeback not_written. Demo mode does not look the id up.",
          security: cookieOrBearer,
          parameters: [pathParam("id", "Decision id.", { type: "integer", minimum: 1 })],
          requestBody: body(ref("RetryDecisionWriteback")),
          responses: {
            "200": jsonResponse("The row after the retry, or a demo acknowledgement.", {
              oneOf: [
                {
                  type: "object",
                  required: ["ok", "demo"],
                  properties: {
                    ok: { type: "boolean", const: true },
                    demo: { type: "boolean", const: true },
                  },
                },
                {
                  type: "object",
                  required: ["ok", "decision"],
                  properties: {
                    ok: { type: "boolean", const: true },
                    decision: ref("Decision"),
                  },
                },
              ],
            }),
            ...flatErrors,
            "404": jsonResponse("No decision has this id when a database is connected.", ref("Error")),
            "409": jsonResponse("code stale or code conflict.", ref("Error")),
          },
        }),
      },
      "/api/progress": {
        get: operation({
          operationId: "getProgress",
          tags: ["progress"],
          summary: "Progress board data, read from Postgres.",
          security: cookieOrBearer,
          parameters: [
            query("window", { type: "string", enum: [...WINDOWS] }, "Time window. Default 24h."),
          ],
          responses: {
            "200": jsonResponse("Board payload.", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/progress/digest": {
        get: operation({
          operationId: "getProgressDigest",
          tags: ["progress"],
          summary: "The progress board as plain text.",
          security: cookieOrBearer,
          parameters: [
            query("window", { type: "string", enum: [...WINDOWS] }, "Time window. Default 24h."),
          ],
          responses: {
            "200": textResponse("Plain-text digest."),
            ...flatErrors,
          },
        }),
      },
      "/api/brief": {
        get: operation({
          operationId: "getMorningBrief",
          tags: ["progress"],
          summary: "Morning brief. Plain text by default; JSON when Accept asks for it.",
          description:
            "window is 24h (default) or 72h. Any other value, an empty value, a repeated window, or a key such as window[] is 400 validation_failed. The body is text/plain unless Accept lists application/json with a q strictly greater than the effective quality of text/plain (its own q, else text/*, else */*). Equal quality stays text. Accept */* alone stays text. A success response sends Vary: Accept. Errors are the JSON error body even when the client asked for text. Auth matches the other data routes: session cookie, MC_TOKEN, or an agent credential with progress:read. An akc_ token is checked even when MC_DASHBOARD_PASSWORD is unset. Counts, stuck PRs, and lead time come from repo_snapshots. A 72h median uses detail.merged timestamps and is not the stored 24h median. Decisions join on owner/name. A repo in the decisions incomplete_repos list has decisions null and is named on the brief's incomplete_repos. A missing decisions relation or a failed decisions query is decisions unavailable, not an empty list. The route does not call GitHub.",
          security: cookieOrBearer,
          parameters: [
            query("window", { type: "string", enum: ["24h", "72h"] }, "24h or 72h. Default 24h. Anything else is 400."),
          ],
          responses: {
            "200": {
              description: "The brief. text/plain is the default. application/json is the morning-brief object.",
              content: {
                "text/plain": { schema: { type: "string" } },
                "application/json": { schema: { type: "object", additionalProperties: true } },
              },
            },
            ...flatErrors,
          },
        }),
      },
      "/api/brief/alerts": {
        get: operation({
          operationId: "getBriefAlerts",
          tags: ["progress"],
          summary: "Threshold alert conditions. Does not send.",
          description:
            "Auth matches GET /api/brief: session cookie, MC_TOKEN, or an agent credential with progress:read. Returns the coordinator-silence, zero-merge, and decision-age conditions. condition is firing, clear, or unknown. unknown means that source could not be read or the merge history does not cover the window; it is not a clear. sent is true only when a brief_alerts latch exists and cleared_at is null, false when that table was read and the key is not latched, and null when the table could not be read. latches is unknown in that case. This route never inserts a message. With no database every condition is unknown.",
          security: cookieOrBearer,
          responses: {
            "200": jsonResponse("Current conditions and latch state.", ref("BriefAlerts")),
            ...flatErrors,
          },
        }),
      },
      "/api/brief/alerts/evaluate": {
        post: operation({
          operationId: "evaluateBriefAlerts",
          tags: ["progress"],
          summary: "Evaluate threshold alerts and send newly claimed ones.",
          description:
            "Auth matches POST /api/progress/ingest: Authorization Bearer MC_TOKEN. An agent credential is 403, including one with progress:read. The body is ignored. When brief.alerts.enabled is false the conditions are still computed, sent_count is 0, delivery is disabled, and no brief_alerts row is claimed or cleared. When enabled, one operator message is inserted per alert whose claim statement returns a row. The claim stores a claim_token and the evaluation's compute instant. Episode and repeat claims re-arm a cleared latch only when cleared_at is null or older than that instant. A clear writes cleared_at only when last_sent_at is older than the clear's instant. A decision claim inserts only while that decision is still open and still old enough. An event between compute and claim with no concurrent evaluation can still send once; the next evaluation clears it. A failed message insert restores the previous row only while that token still matches and cleared_at is still null. Coordinator silence re-claims after coordinatorRepeatHours. A zero-merge alert re-arms only after it clears. A decision alerts once per row. Unknown conditions are not claimed and do not clear an existing latch. failures names a latch read, claim, clear, message, or restore that threw.",
          security: bearerOnly,
          responses: {
            "200": jsonResponse("Conditions, plus sent_count for this call.", ref("BriefAlerts")),
            ...flatErrors,
          },
        }),
      },
      "/api/progress/ingest": {
        post: operation({
          operationId: "ingestProgress",
          tags: ["progress"],
          summary: "One collection tick from the progress collector.",
          security: bearerOnly,
          requestBody: body(ref("ProgressIngest")),
          responses: {
            "200": jsonResponse("Snapshots written, or dropped in demo mode.", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/settings/repos": {
        get: operation({
          operationId: "getWatchedRepos",
          tags: ["settings"],
          summary: "Repos the progress board watches.",
          security: cookieOrBearer,
          responses: {
            "200": jsonResponse("The current list and its version.", ref("WatchedRepos")),
            ...flatErrors,
          },
        }),
        put: operation({
          operationId: "putWatchedRepos",
          tags: ["settings"],
          summary: "Replace the watched-repo list, or preview that replace.",
          description:
            "dry_run true returns the diff against the list GET would show (adds, removes, updates, reorders) and writes nothing. An omitted auto row is not a remove. When that row has fieldsOverridden true, the diff reports an update that resets label, short, color, and blocked label to the discovery defaults. A stale version is still 409. The version is checked again under the discovery write lock in the same transaction as the replace. A pin or hide that changed the list is 409 stale and is kept. With no database, a dry run returns that diff with would_write false instead of 409. A non-boolean dry_run is 400 and writes nothing.",
          security: cookieOrBearer,
          requestBody: body(ref("RepoList")),
          responses: {
            "200": jsonResponse("The stored list, or a preview that writes nothing.", {
              oneOf: [ref("WatchedRepos"), ref("DryRunResult")],
            }),
            "400": jsonResponse("The list failed validation. errors is unchanged.", {
              allOf: [ref("Error"), { type: "object", properties: { errors: { type: "array" } } }],
            }),
            "401": flatErrors["401"],
            "403": flatErrors["403"],
            "409": jsonResponse("No database, or version does not match the stored list.", ref("Error")),
            "500": flatErrors["500"],
          },
        }),
        patch: operation({
          operationId: "patchWatchedRepo",
          tags: ["settings"],
          summary: "Pin or hide one watched repo.",
          description:
            "Sets pinned and hidden on one stored row. Takes the same advisory lock as discovery and repo replacement. Changing a flag changes the list version. Send at least one flag. Hide wins over pin: the repo stays collected and is left off the brief. A repo marked gone is not shown, including when it is pinned. Does not change origin. dry_run true returns before and after and writes nothing. With no database, the preview resolves the repo against the file fallback, returns before and after, and sets would_write false. An unknown repo is 404 in both modes.",
          security: cookieOrBearer,
          requestBody: body(ref("RepoOverride")),
          responses: {
            "200": jsonResponse("The stored list, or a preview that writes nothing.", {
              oneOf: [ref("WatchedRepos"), ref("DryRunResult")],
            }),
            "400": flatErrors["400"],
            "401": flatErrors["401"],
            "403": flatErrors["403"],
            "404": jsonResponse("That repo is not in the watched list.", ref("Error")),
            "409": jsonResponse("No database is connected.", ref("Error")),
            "500": flatErrors["500"],
          },
        }),
      },
      "/api/settings/owners": {
        get: operation({
          operationId: "getWatchedOwners",
          tags: ["settings"],
          summary: "GitHub owners whose repos are discovered.",
          description:
            "With no database, returns writable false and an empty owners list. A missing table is writable false and the same empty list, not a 500.",
          security: cookieOrBearer,
          responses: {
            "200": jsonResponse("The current owner list and its version.", ref("WatchedOwners")),
            ...flatErrors,
          },
        }),
        put: operation({
          operationId: "putWatchedOwners",
          tags: ["settings"],
          summary: "Replace the watched-owner list, or preview that replace.",
          description:
            "Auth matches PUT /api/settings/repos. An agent credential is 403 insufficient_scope. The actor is the principal, never a body field. dev-open stores null actor fields. Removing an owner does not delete repos already tracked. An empty owners list is allowed. dry_run true returns the diff and writes nothing. A stale version is 409. The version is checked again under a lock in the same transaction as the replace. With no database, or before the table exists, a dry run returns that diff with would_write false instead of 409, and a save is 409 conflict.",
          security: cookieOrBearer,
          requestBody: body(ref("OwnerList")),
          responses: {
            "200": jsonResponse("The stored list, or a preview that writes nothing.", {
              oneOf: [ref("WatchedOwners"), ref("DryRunResult")],
            }),
            "400": jsonResponse("The list failed validation.", {
              allOf: [ref("Error"), { type: "object", properties: { errors: { type: "array" } } }],
            }),
            "401": flatErrors["401"],
            "403": flatErrors["403"],
            "409": jsonResponse("No database, or version does not match the stored list.", ref("Error")),
            "500": flatErrors["500"],
          },
        }),
      },
      "/api/settings/owners/discover": {
        post: operation({
          operationId: "discoverWatchedOwners",
          tags: ["settings"],
          summary: "Apply one collector tick of gh repo list results.",
          description:
            "Auth matches PUT /api/settings/repos. A result with ok false, a rate-limit error, or zero repos records last_error and does not change tracked repos. A truncated list updates the repos it saw, does not mark the others gone, and stores a warning on last_error while still setting last_discovered_at. An unknown owner is an error on that result and does not fail the batch. A duplicate owner in one request is 400 and writes nothing. A missing swept_at is 400. A repo name that is not safe to store fails that owner's sweep and writes no repo changes. One owner's metadata update and repo changes commit together, under one global advisory lock shared by every owner, after reloading tracked repos. The lock is not held during gh repo list. swept_at orders overlapping ticks: a sweep that is not newer than last_discovered_at writes nothing. A short-name unique violation replans once and then is 409 with results plus added, updated, and marked_gone as empty arrays on the response and on each result. Discovery does not change pin, hide, label, short, color, origin, fieldsOverridden, or the actor who saved the owner. No database, or a missing watched_owners table, is 409 and includes results plus added, updated, and marked_gone as empty arrays on the response and on each result.",
          security: cookieOrBearer,
          requestBody: body(ref("OwnerDiscovery")),
          responses: {
            "200": jsonResponse("One outcome per owner.", {
              type: "object",
              required: ["results"],
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["owner", "ok", "added", "updated", "marked_gone"],
                    properties: {
                      owner: { type: "string" },
                      ok: { type: "boolean" },
                      error: { type: ["string", "null"] },
                      added: { type: "integer" },
                      updated: { type: "integer" },
                      marked_gone: { type: "integer" },
                    },
                  },
                },
              },
            }),
            "400": flatErrors["400"],
            "401": flatErrors["401"],
            "403": flatErrors["403"],
            "409": jsonResponse("No database is connected, or watched_owners does not exist yet.", ref("Error")),
            "500": flatErrors["500"],
          },
        }),
      },
      "/api/settings/credentials": {
        get: operation({
          operationId: "listCredentials",
          tags: ["settings"],
          summary: "List agent credentials. No token and no hash.",
          description: "Dashboard session only. A request that sends Authorization is 401.",
          security: sessionOnly,
          responses: {
            "200": jsonResponse("Credentials without the secret.", { type: "object" }),
            "401": jsonResponse("No dashboard session, or an Authorization header was sent.", ref("ErrorMessage")),
            "500": jsonResponse("The store failed.", ref("ErrorMessage")),
          },
        }),
        post: operation({
          operationId: "createCredential",
          tags: ["settings"],
          summary: "Create an agent credential. The token is in this response only.",
          security: sessionOnly,
          requestBody: body(ref("CreateCredential")),
          responses: {
            "200": jsonResponse("The new credential, including token once.", { type: "object" }),
            "400": jsonResponse("The label, scopes, or expiry was rejected.", ref("ErrorMessage")),
            "401": jsonResponse("No dashboard session, or an Authorization header was sent.", ref("ErrorMessage")),
            "500": jsonResponse("The store failed.", ref("ErrorMessage")),
          },
        }),
        delete: operation({
          operationId: "revokeCredential",
          tags: ["settings"],
          summary: "Revoke an agent credential by id.",
          security: sessionOnly,
          requestBody: body({
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          }),
          responses: {
            "200": jsonResponse("The revoked row.", { type: "object" }),
            "400": jsonResponse("id is missing, or the body is not JSON.", ref("ErrorMessage")),
            "401": jsonResponse("No dashboard session, or an Authorization header was sent.", ref("ErrorMessage")),
            "404": jsonResponse("No credential has this id.", ref("ErrorMessage")),
            "500": jsonResponse("The store failed.", ref("ErrorMessage")),
          },
        }),
      },
      "/api/usage": {
        get: operation({
          operationId: "getUsage",
          tags: ["usage"],
          summary: "Usage ledger.",
          security: cookieOrBearer,
          parameters: [
            query("window", { type: "string", enum: [...USAGE_WINDOWS] }, "Rolling window. Default 7d. Ignored when since and until are both set."),
            query("since", { type: "string", format: "date-time" }, "Range start. Used with until."),
            query("until", { type: "string", format: "date-time" }, "Range end. Used with since."),
          ],
          responses: {
            "200": jsonResponse("Usage summary. Stays 200 with setup_required when the table is missing.", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/usage/ingest": {
        post: operation({
          operationId: "ingestUsage",
          tags: ["usage"],
          summary: "Ingest usage facts. Separate from liveness ingest.",
          security: bearerOnly,
          requestBody: body(ref("UsageIngest")),
          responses: {
            "200": jsonResponse("Facts written, or dropped in demo mode.", { type: "object" }),
            ...flatErrors,
            "503": jsonResponse("The usage tables are not set up.", ref("Error")),
          },
        }),
      },
      "/api/activity": {
        get: operation({
          operationId: "listActivity",
          tags: ["activity"],
          summary: "Write receipts and other events, newest first.",
          description:
            "Operator only. Authenticate with a dashboard session or MC_TOKEN. An agent credential is denied, including one with fleet:read. Same boundary as GET /api/traces. actor is an exact actor_id. kind is an exact event kind. since and until are inclusive ISO timestamps; a since later than until is 400 validation_failed. With no database the body is the in-memory demo event log (demo true), not a static sample, and the filters still apply. next_cursor is absent unless limit or cursor was passed.",
          security: operatorSessionOrMcToken,
          parameters: [
            query("actor", { type: "string" }, "Exact actor_id. Empty means no filter. Longer than 200 characters is 400."),
            query("kind", { type: "string" }, "Exact event kind. Empty means no filter. Anything other than 1 to 64 letters, digits, or _ . : - is 400."),
            query("since", { type: "string", format: "date-time" }, "Inclusive start. A value that is not an ISO timestamp is 400."),
            query("until", { type: "string", format: "date-time" }, "Inclusive end, through that millisecond. A value that is not an ISO timestamp, or a value before since, is 400."),
            listLimitParam(50),
            listCursor,
            listFields,
          ],
          responses: {
            "200": jsonResponse("demo and activity. next_cursor is absent unless limit or cursor was passed.", {
              type: "object",
              properties: {
                demo: { type: "boolean" },
                activity: { type: "array", items: { type: "object", properties: ACTIVITY_ITEM_PROPERTIES } },
                next_cursor: nextCursor,
              },
            }),
            ...flatErrors,
          },
        }),
      },
      "/api/traces": {
        get: operation({
          operationId: "listTraces",
          tags: ["traces"],
          summary: "Trace summaries, newest first.",
          security: cookieOrBearer,
          parameters: [
            query("agent", { type: "string" }, "Filter by agent id."),
            query("errors", { type: "string", enum: ["1"] }, "When 1, only traces with an error."),
            query("before", { type: "string", format: "date-time" }, "Return traces before this instant."),
            listLimitParam(50),
            listCursor,
            listFields,
          ],
          responses: {
            "200": jsonResponse("demo and traces. next_cursor is absent unless limit or cursor was passed.", {
              type: "object",
              properties: {
                demo: { type: "boolean" },
                traces: { type: "array", items: { type: "object" } },
                next_cursor: nextCursor,
              },
            }),
            ...flatErrors,
          },
        }),
      },
      "/api/traces/{traceId}": {
        get: operation({
          operationId: "getTrace",
          tags: ["traces"],
          summary: "Spans of one trace.",
          security: cookieOrBearer,
          parameters: [pathParam("traceId", "Trace id.")],
          responses: {
            "200": jsonResponse("demo and spans. Demo mode returns an empty list for an unknown id.", { type: "object" }),
            ...flatErrors,
            "404": jsonResponse("Unknown or pruned trace when a database is connected.", ref("Error")),
          },
        }),
      },
      "/api/v1/traces": {
        post: operation({
          operationId: "exportTraces",
          tags: ["traces"],
          summary: "OTLP/HTTP JSON trace export.",
          security: bearerOnly,
          requestBody: body({
            type: "object",
            description: "An OTLP export request. Protobuf is rejected.",
          }),
          responses: {
            "200": jsonResponse("OTLP partialSuccess.", { type: "object" }),
            "401": flatErrors["401"],
            "400": flatErrors["400"],
            "413": jsonResponse("The body is over 2 MB.", ref("Error")),
            "415": jsonResponse("The body is not JSON.", ref("Error")),
            "500": flatErrors["500"],
          },
        }),
      },
      "/api/skills": {
        get: operation({
          operationId: "listSkills",
          tags: ["skills"],
          summary: "List mirrored skills.",
          description:
            "Agent credentials need skills:read. runtime filters to skills compatible with that runtime. An unknown runtime is 400 validation_failed. q matches name and description, case-insensitive. category is an exact case-insensitive match on the stored category. The value uncategorized matches a null category. The taxonomy is not enforced. Each skill includes category (string or null) and tags (string array), plus lastScheduledAt and nextDueAt (ISO strings or null). Removed skills are omitted. With no database the body is demo true and a fixture list.",
          security: cookieOrBearer,
          parameters: [
            query("runtime", { type: "string", enum: [...RUNTIMES] }, "Compatible runtime. Omit to return every skill."),
            query("q", { type: "string" }, "Case-insensitive match on name and description."),
            query("category", { type: "string" }, "Exact category, case-insensitive. uncategorized matches a null category."),
          ],
          responses: {
            "200": jsonResponse("demo, upstream, and skills. List runtimes is an array of names. Each skill has category and tags.", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/skills/pointers": {
        get: operation({
          operationId: "getSkillPointers",
          tags: ["skills"],
          summary: "The AGENTS.md pointer block for a lane.",
          description:
            "Agent credentials need skills:read. Returns the block between <!-- ak-skills:begin --> and <!-- ak-skills:end --> for skills whose trigger is auto_inject, which match runtime, and whose scope admits lane. lane and runtime are required; a bad value is 400 validation_failed. empty is true and block is \"\" when nothing matches. format=text returns the block as text/plain, or an empty body.",
          security: cookieOrBearer,
          parameters: [
            query("lane", { type: "string" }, "Lane name. Selected-scope skills match only an exact lane.", { required: true }),
            query("runtime", { type: "string", enum: [...RUNTIMES] }, "Runtime that will read the file.", { required: true }),
            query("format", { type: "string", enum: ["json", "text"] }, "json (default) or text."),
          ],
          responses: {
            "200": {
              description: "json: demo, lane, runtime, empty, and block. text: the block, or an empty body.",
              content: { ...jsonResponse("", { type: "object" }).content as Json, ...textResponse("").content as Json },
            },
            ...flatErrors,
          },
        }),
        post: operation({
          operationId: "applySkillPointers",
          tags: ["skills"],
          summary: "Apply the pointer block to an AGENTS.md text.",
          description:
            "Agent credentials need skills:read. Nothing is stored and no file is written. The block is inserted at the end, replaced in place, or removed when empty. Text outside the markers is preserved, CRLF is kept, and a second run changes nothing. agents_md omitted or null means the file does not exist: content is null when there is nothing to write. An unpaired or nested marker in agents_md is 400 validation_failed.",
          security: cookieOrBearer,
          requestBody: body({
            type: "object",
            required: ["lane", "runtime"],
            properties: {
              lane: { type: "string" },
              runtime: { type: "string", enum: [...RUNTIMES] },
              agents_md: { type: ["string", "null"] },
            },
          }),
          responses: {
            "200": jsonResponse("demo, lane, runtime, empty, changed, and content (string or null).", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/skill-bundles": {
        get: operation({
          operationId: "exportSkills",
          tags: ["skills"],
          summary: "Download a skill tree for one runtime.",
          description:
            "Operator only. Authenticate with a dashboard session or MC_TOKEN. An agent credential is denied, including one with skills:read or skills:write. runtime is required and is claude, codex, grok, hermes, mini, or nemoclaw. lane is optional. Visibility is the list_skills check. Trigger off is omitted. A trigger other than off, on_request, auto_inject, or scheduled is treated as off and listed with reason invalid trigger. A selected scope is omitted unless lane is set and admits it. category and q match list_skills. The body is a gzip-compressed tar. Paths are relative. The directory is the skill id, which is the upstream directory slug. The frontmatter name is a display string and may differ. The folder is the id. Category is a Hermes folder only. Claude, Codex, Grok, mini, and NemoClaw leave category out of the path, so a category value does not omit the skill for those runtimes. NemoClaw uses .agents/skills/<id>/SKILL.md. Its frontmatter is name and description, plus license, user_invocable, and metadata.author or metadata.tags only when the stored file already has them. A Hermes category or a skill id that does not already match ^[a-z0-9][a-z0-9-_]*$ is omitted and listed. The stored text is left as it is. When two skills would write one archive path, every one of those skills is omitted and listed. A reference that is unsafe, that collides case-insensitively, or that does not fit a ustar name and prefix is omitted and listed with its path, and the skill is still exported. A skill whose SKILL.md cannot be written is omitted as a whole. Each omission is {skill, path?, reason}. When the list is not empty, manifest.json at the archive root contains every entry. The x-ak-skipped header carries count, the first 20 entries, and the text see manifest.json. The header is at most 4 KB. The archive contains each path once. A skill with no category is under uncategorized/ in the Hermes layout. hermes uses <category>/<id>/SKILL.md. With no database the archive is the demo fixture under the same rules. A repeated runtime, lane, category, or q is 400 validation_failed.",
          security: operatorSessionOrMcToken,
          parameters: [
            query("runtime", { type: "string", enum: [...RUNTIMES] }, "Runtime the tree is rendered for.", { required: true }),
            query("lane", { type: "string" }, "When omitted, skills whose scope is selected are omitted."),
            query("category", { type: "string" }, "Exact category, case-insensitive. uncategorized matches a null category."),
            query("q", { type: "string" }, "Case-insensitive match on the skill id and the description."),
          ],
          responses: {
            "200": {
              description: "gzip-compressed tar of the rendered tree. x-ak-demo is true when no database is configured.",
              content: { "application/gzip": { schema: { type: "string", contentEncoding: "gzip" } } },
            },
            ...flatErrors,
          },
        }),
      },
      "/api/skills/sync": {
        post: operation({
          operationId: "syncSkills",
          tags: ["skills"],
          summary: "Mirror skill sources from GitHub.",
          description:
            "Operator route. An agent credential is denied. Omit the body, or send {trigger:manual}, for a manual run. A scheduler sends {trigger:scheduled} with MC_TOKEN. status in the body is ok, failed, or busy. failed means a source or a SKILL.md could not be evaluated. It is not a deletion. busy writes nothing. With no database the body is a no-op note and no sync is claimed.",
          security: cookieOrBearer,
          requestBody: body({
            type: "object",
            properties: { trigger: { type: "string", enum: ["manual", "scheduled"] } },
          }),
          responses: {
            "200": jsonResponse("Sync result, or a demo no-op.", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/skills/schedule/tick": {
        post: operation({
          operationId: "tickSkillSchedule",
          tags: ["skills"],
          summary: "Queue a task for each scheduled skill that is due.",
          description:
            "Operator route. An agent credential is denied, including one with skills:write. An external scheduler calls it every minute with MC_TOKEN. The body is ignored. For each skill whose trigger is scheduled and whose cron (UTC) has a due minute in the catch-up window, it queues one task titled Run scheduled skill <id>. A connected agent claims the task and calls run_skill. Agent Kontrol never runs the skill. The task is keyed on the skill and the due minute, so a repeated tick queues nothing. A skill is skipped while its previous scheduled task is still queued, claimed, running, or in review. Due minutes with no task are folded into the next one and counted in missed. items[].reason is previous_open, already_scheduled, duplicate, or no_runtime. With no database the body is a no-op note.",
          security: cookieOrBearer,
          responses: {
            "200": jsonResponse("ok, now, scheduled, queued, skipped, and items; or a demo no-op.", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/skills/drift": {
        post: operation({
          operationId: "reportSkillDrift",
          tags: ["skills"],
          summary: "Report skills present on a machine.",
          description:
            "Operator route. An agent credential is denied. The server does not read the machine. sha is the SHA-256 hex of the SKILL.md bytes. An empty skills array means the directory was read and was empty.",
          security: cookieOrBearer,
          requestBody: body({
            type: "object",
            required: ["host", "dir", "skills"],
            properties: {
              host: { type: "string" },
              dir: { type: "string" },
              skills: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "sha"],
                  properties: { name: { type: "string" }, sha: { type: "string" } },
                },
              },
            },
          }),
          responses: {
            "200": jsonResponse("This report compared with the mirror. driftCount is the finding count for this host and dir.", { type: "object" }),
            ...flatErrors,
          },
        }),
      },
      "/api/skills/{id}": {
        get: operation({
          operationId: "getSkill",
          tags: ["skills"],
          summary: "One skill, its body, and recent runs.",
          description:
            "Agent credentials need skills:read. runtimes is an object of booleans, not the array used by the list. category is a string or null. tags is an array of strings. Both come from SKILL.md and are not checked against a vocabulary. lastScheduledAt is the newest slot the scheduler queued, or null. nextDueAt is the next due minute in UTC for a scheduled skill, or null. triggers status is done when the run ended, running inside the stall window, and stalled after it. outcome carries done or failed. Unknown id is 404.",
          security: cookieOrBearer,
          parameters: [pathParam("id", "Skill id. The directory slug.")],
          responses: {
            "200": jsonResponse("The skill. Demo mode returns the fixture or 404.", { type: "object" }),
            ...flatErrors,
            "404": jsonResponse("Unknown or removed skill.", ref("Error")),
          },
        }),
        patch: operation({
          operationId: "patchSkillSettings",
          tags: ["skills"],
          summary: "Set trigger, scope, and schedule.",
          description:
            "Operator route. An agent credential is denied. trigger is off, on_request, auto_inject, or scheduled. scope.mode all stores lanes as an empty array. selected requires at least one lane. scheduled requires a five-field cron. Any other trigger clears schedule. Unknown keys are 400. dry_run is not accepted. With no database the body is a no-op note and the id is not looked up.",
          security: cookieOrBearer,
          parameters: [pathParam("id", "Skill id.")],
          requestBody: body({
            type: "object",
            properties: {
              trigger: { type: "string", enum: ["off", "on_request", "auto_inject", "scheduled"] },
              scope: { type: "object" },
              schedule: { type: ["string", "null"] },
            },
          }),
          responses: {
            "200": jsonResponse("The updated skill, or a demo no-op.", { type: "object" }),
            ...flatErrors,
            "404": jsonResponse("Unknown or removed skill when a database is connected.", ref("Error")),
          },
        }),
      },
      "/api/watch/beat": {
        post: operation({
          operationId: "postWatchBeat",
          tags: ["watch"],
          summary: "Store one host liveness beat.",
          description:
            "Verified akc_ credential with watch:write only. MC_TOKEN, the dashboard session, an OAuth access token, and a dev-open caller are 401. A valid credential without watch:write is 403 insufficient_scope. The credential store being unreachable is 503 credential_store_unavailable. WATCH_SOURCE_CREDENTIAL_IDS_JSON must map the body's source to this credential's row id; a missing or invalid map is 503, and a credential bound to a different source is 403 with no write. Content-Type must be application/json (415 otherwise). The body is measured before parsing and rejected at 413 above 8 KiB; Content-Length is not trusted. received_at and age_s are rejected. beat_at is the sender's instant and may be old or in the future. received_at and age_s come from the database on read. No database is 503, never a demo ack.",
          security: [{ agentCredential: [] }],
          requestBody: body(ref("WatchBeatWrite")),
          responses: {
            "200": jsonResponse("The beat replaced the row for that source.", {
              type: "object",
              required: ["ok"],
              properties: { ok: { type: "boolean", const: true } },
            }),
            ...flatErrors,
            "413": jsonResponse("The body is larger than 8 KiB.", ref("Error")),
            "415": jsonResponse("Content-Type is not application/json.", ref("Error")),
            "503": jsonResponse(
              "The credential store is unreachable, source binding is not configured, or the beat table is unavailable.",
              ref("Error"),
            ),
          },
        }),
      },
      "/api/watch/beats": {
        get: operation({
          operationId: "listWatchBeats",
          tags: ["watch"],
          summary: "List host liveness beats.",
          description:
            "Verified akc_ credential with watch:read only. MC_TOKEN, the dashboard session, an OAuth access token, and a dev-open caller are 401. A valid credential without watch:read is 403 insufficient_scope. No source binding. age_s is the database clock minus received_at. Cache-Control is no-store. With no database, or when the query fails, the response is 503. It is not an empty list and not demo data. An empty beats array means the table was read and has no rows.",
          security: [{ agentCredential: [] }],
          responses: {
            "200": jsonResponse("Rows ordered by source. Cache-Control: no-store.", {
              type: "object",
              required: ["beats"],
              properties: { beats: { type: "array", items: ref("WatchBeat") } },
            }),
            ...flatErrors,
            "503": jsonResponse("The credential store or the beat table is unavailable.", ref("Error")),
          },
        }),
      },
      "/api/{transport}": {
        get: operation({
          operationId: "mcpListen",
          tags: ["mcp"],
          summary: "MCP listen. Tool names are documented in docs/MCP.md.",
          security: bearerOnly,
          parameters: [
            pathParam("transport", "mcp is the streamable HTTP endpoint. sse and message are the legacy SSE transport.", {
              type: "string",
              enum: ["mcp", "sse", "message"],
            }),
          ],
          responses: {
            "200": textResponse("Event stream, when the transport supports it."),
            "401": jsonResponse("Missing or invalid bearer. Includes WWW-Authenticate.", { type: "object" }),
            "405": jsonResponse("This method is not used on that transport.", { type: "object" }),
          },
        }),
        post: operation({
          operationId: "mcpPost",
          tags: ["mcp"],
          summary: "MCP JSON-RPC message.",
          description: "A missing bearer is 401 with WWW-Authenticate. Tool names are not repeated here.",
          security: bearerOnly,
          parameters: [
            pathParam("transport", "Use mcp.", { type: "string", enum: ["mcp", "sse", "message"] }),
          ],
          requestBody: body({
            type: "object",
            description: "A JSON-RPC request or a batch.",
          }),
          responses: {
            "200": jsonResponse("JSON-RPC result, often as text/event-stream.", { type: "object" }),
            "401": jsonResponse("Missing or invalid bearer. Includes WWW-Authenticate.", { type: "object" }),
            "403": jsonResponse("The credential cannot call that tool.", { type: "object" }),
          },
        }),
        delete: operation({
          operationId: "mcpDelete",
          tags: ["mcp"],
          summary: "MCP session delete.",
          security: bearerOnly,
          parameters: [
            pathParam("transport", "Use mcp.", { type: "string", enum: ["mcp", "sse", "message"] }),
          ],
          responses: {
            "200": jsonResponse("Session ended.", { type: "object" }),
            "401": jsonResponse("Missing or invalid bearer. Includes WWW-Authenticate.", { type: "object" }),
            "405": jsonResponse("This method is not used on that transport.", { type: "object" }),
          },
        }),
      },
    },
  };
}
