import packageJson from "../../package.json";
import { LABEL_MAX } from "@/lib/credentials";
import { PROGRESS_INGEST_KINDS } from "@/lib/progress-store";
import { WINDOWS } from "@/lib/progress-config";
import { MAX_REPOS } from "@/lib/repo-validation";
import { SCOPES } from "@/lib/scopes";
import { INGEST_KINDS } from "@/lib/store";
import { TASK_STATUSES } from "@/lib/types";
import { USAGE_SOURCES } from "@/lib/usage-types";
import { USAGE_WINDOWS } from "@/lib/usage-window";

/**
 * OpenAPI 3.1 for the documented REST routes.
 *
 * Request fields come from the same constants and interfaces the handlers
 * use (scopes, repo limit, task statuses, ingest kinds, usage sources).
 * Routes that only check "present" still accept a wider string than the
 * documented enum; the enum is the contract in docs/API.md.
 *
 * MCP tool names are not listed here. They stay in docs/MCP.md.
 */

type Json = Record<string, unknown>;

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

function pathParam(name: string, description: string, schema: Json = { type: "string" }): Json {
  return { name, in: "path", required: true, schema, description };
}

function body(schema: Json): Json {
  return { required: true, content: { "application/json": { schema } } };
}

const cookieOrBearer = [{ cookieAuth: [] }, { bearerAuth: [] }];
const bearerOnly = [{ bearerAuth: [] }];
const sessionOnly = [{ cookieAuth: [] }];

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
      { name: "messages" },
      { name: "memory" },
      { name: "progress" },
      { name: "settings" },
      { name: "usage" },
      { name: "traces" },
      { name: "auth" },
      { name: "mcp" },
    ],
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: "mc_auth" },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "MC_TOKEN, an akc_ agent credential, or an OAuth access token on the MCP transport.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code", "fix", "retryable"],
          properties: {
            error: { type: "string" },
            code: { type: "string" },
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
        WatchedRepos: {
          type: "object",
          required: ["source", "writable", "max", "version", "repos"],
          properties: {
            source: { type: "string", enum: ["database", "file"] },
            writable: { type: "boolean" },
            max: { type: "integer", const: MAX_REPOS },
            version: { type: "string" },
            repos: { type: "array", items: ref("RepoInput") },
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
              enum: ["replace_repos", "cancel_task", "update_task", "overwrite_memory", "insert_memory"],
            },
            changes: { type: "array", items: ref("DryRunChange") },
            affected: { type: "array", items: { type: "object", additionalProperties: true } },
            note: { type: "string" },
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
            query("limit", { type: "integer", default: 50 }, "Maximum notes. Default 50."),
          ],
          responses: {
            "200": jsonResponse("Matching notes, newest update first.", {
              type: "object",
              properties: {
                demo: { type: "boolean" },
                items: { type: "array", items: ref("MemoryItem") },
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
            "The REST twin of MCP remember. An agent credential needs memory:write. dry_run true returns the insert or the key overwrite and writes nothing. action is overwrite_memory when the key already exists, otherwise insert_memory. A non-boolean dry_run is 400 and writes nothing. With no database, a dry run still describes the note and sets would_write to false.",
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
            "The server sets actor_type and actor_id from the authenticated credential. created_by is a label and does not set those fields. When MC_DASHBOARD_PASSWORD is unset and the request presents no credential, both actor fields are null.",
          security: cookieOrBearer,
          requestBody: body({
            type: "object",
            required: ["agent_id", "body"],
            properties: {
              agent_id: { type: "string" },
              body: { type: "string" },
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
            "actor_type and actor_id are taken from the bearer, not from created_by. A dashboard session is human / operator. MC_TOKEN is agent / mc-token.",
          security: bearerOnly,
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
            query("limit", { type: "integer" }, "Maximum rows."),
          ],
          responses: {
            "200": jsonResponse("Tasks. actor_type and actor_id are server-set.", {
              type: "object",
              properties: {
                demo: { type: "boolean" },
                tasks: { type: "array", items: ref("Task") },
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
            "actor_type and actor_id on the returned task come from the authenticated credential. The body cannot set them. created_by is only a label.",
          security: cookieOrBearer,
          requestBody: body(ref("CreateTask")),
          responses: {
            "200": jsonResponse("The task was queued, or dropped in demo mode.", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                demo: { type: "boolean" },
                note: { type: "string" },
                task: ref("Task"),
              },
            }),
            ...flatErrors,
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
            "dry_run true returns the affected task and the field diff and writes nothing. action is cancel_task when status is cancelled, otherwise update_task. A missing id is still 404. A non-boolean dry_run is 400 and writes nothing. With no database, a dry run returns would_write false.",
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
            "404": jsonResponse("No task has this id when a database is connected.", ref("Error")),
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
            "dry_run true returns the diff against the list GET would show (adds, removes, updates, reorders) and writes nothing. A stale version is still 409. With no database, a dry run returns that diff with would_write false instead of 409. A non-boolean dry_run is 400 and writes nothing.",
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
            query("limit", { type: "integer" }, "Maximum rows. Default 50."),
          ],
          responses: {
            "200": jsonResponse("demo and traces.", { type: "object" }),
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
