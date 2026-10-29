import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { actorFromPrincipal, currentActor, runWithActor } from "@/lib/actor";
import { activityDetail, readReceipt, withReceipt } from "@/lib/activity";
import { apiError, memoryKeyError, toolResultFromCaught, type McpToolResult } from "@/lib/api-error";
import { secretsMatch, verifyAccessToken } from "@/lib/authcrypto";
import { resolveAgentCredential } from "@/lib/credentials";
import { isConfigured } from "@/lib/db";
import {
  demoClaimTaskTool,
  demoCreateTaskTool,
  demoFleetStatusTool,
  demoRecallTool,
  demoReportStatusTool,
  demoTaskQueueTool,
} from "@/lib/demo-store";
import { listActivityResult, recallResult, taskQueueResult } from "@/lib/list-read";
import { evaluateMcpMessages, insufficientScopeBody, principalFromMcpAuth } from "@/lib/scopes";
import { rememberForTool, updateTaskForTool } from "@/lib/dry-run-actions";
import { claimNextTask, createTask, fetchMessages, fleet, replyFromAgent, report } from "@/lib/store";
import { progress } from "@/lib/progress-store";
import { formatDigest } from "@/lib/progress-digest";
import { morningBriefText } from "@/lib/brief";
import { OPERATOR } from "@/lib/operator";
import { demoProgress } from "@/lib/demo-progress";
import { listDecisionsTool, requestDecisionTool, resolveDecisionTool } from "@/lib/decision-resolve";
import { getSkillTool, listSkillsTool, runSkillTool } from "@/lib/skills/mcp";
import { deleteNoteTool, requeueTaskTool, sendMessageTool } from "@/lib/operator-actions";
import { getSettingsTool, setWatchedReposTool } from "@/lib/settings-tools";

export const maxDuration = 60;

/**
 * MCP tool annotations. Every tool declares all four hints explicitly so hosts can
 * warn before invoking. Agent Kontrol is a closed system (its own database), so
 * openWorldHint is false everywhere. delete_note is the tool that removes a row.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Overwrites existing state, or deletes a note, so not idempotent. */
const WRITE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** Caught tool failures become an isError result. The text is the JSON error body, never the exception. */
async function guardTool(label: string, run: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await run();
  } catch (e) {
    return toolResultFromCaught(label, e);
  }
}

/**
 * Agent Kontrol MCP server — /api/mcp
 * The semantic layer: any connected agent (Claude, ChatGPT Work, Hermes)
 * can report what it's doing, see what the rest of the fleet is doing,
 * and read/write shared memory.
 */
const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "report_status",
      {
        title: "Report status",
        annotations: WRITE,
        description:
          "Report what you are currently working on to Agent Kontrol. Call this at the start of a task, at major milestones, and when you finish or get blocked.",
        inputSchema: {
          agent_id: z
            .string()
            .describe("Stable identifier for this agent, e.g. 'cowork-cloud' or 'chatgpt-work'"),
          platform: z
            .enum(["claude-code", "cowork-cloud", "cowork-local", "chatgpt-work", "codex", "grok", "hermes", "other"])
            .optional(),
          machine: z.string().optional().describe("Hostname or 'cloud'"),
          display_name: z.string().optional().describe("Human-friendly name shown on the dashboard"),
          session_id: z.string().optional().describe("Your session/conversation id if you have one"),
          status: z.enum(["active", "waiting", "done", "failed"]).optional(),
          title: z.string().describe("One line: what just happened or what you're doing"),
          project: z.string().optional().describe("Project/repo/initiative name"),
          summary: z.string().optional().describe("One-line summary of the overall task"),
        },
      },
      async (args) => guardTool("report_status", async () => {
        if (!isConfigured()) return demoReportStatusTool(args);
        const actor = currentActor();
        const receipt = await report({
          agent_id: args.agent_id,
          platform: args.platform,
          machine: args.machine,
          display_name: args.display_name,
          session_id: args.session_id ?? `${args.agent_id}-default`,
          kind: "status",
          status: args.status,
          title: args.title,
          project: args.project,
          summary: args.summary ?? args.title,
          detail: activityDetail("report_status", actor, {}),
        });
        return withReceipt("Status reported to Agent Kontrol.", receipt);
      }),
    );

    server.registerTool(
      "get_fleet_status",
      {
        title: "Get fleet status",
        annotations: READ_ONLY,
        description:
          "See what every agent in the fleet (Claude Code, Cowork, ChatGPT Work, Hermes, ...) is currently doing, with recent activity. Use this to avoid duplicating work another agent is already on.",
        inputSchema: {},
      },
      async () => guardTool("get_fleet_status", async () => {
        if (!isConfigured()) return demoFleetStatusTool();
        const { agents, events } = await fleet();
        const lines: string[] = [];
        for (const a of agents) {
          const name = a.display_name ?? a.id;
          const s = a.current_session;
          lines.push(
            `- ${name} [${a.platform}${a.machine ? ` @ ${a.machine}` : ""}] — ${a.derived_status.toUpperCase()}` +
              (s ? ` — ${s.summary ?? s.project ?? s.id} (project: ${s.project ?? "n/a"})` : " — no open session")
          );
        }
        lines.push("", "Recent events:");
        for (const e of events.slice(0, 15)) {
          lines.push(`- [${e.created_at}] ${e.agent_id}: ${e.kind}${e.title ? ` — ${e.title}` : ""}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }),
    );

    server.registerTool(
      "get_progress_digest",
      {
        title: "Get progress digest",
        annotations: READ_ONLY,
        description:
          "Read the fleet progress board as plain text: PRs merged, issues closed vs opened, net backlog per repo, and anything over a threshold that needs the operator's attention. Use this for a scheduled morning digest, or whenever asked whether the work is actually moving. The headline is net backlog (opened minus closed), not merge count — a high-merge day can still lose ground.",
        inputSchema: {
          window: z
            .enum(["24h", "7d", "30d", "90d"])
            .optional()
            .describe("Time window to summarise; defaults to 24h"),
        },
      },
      async (args) => guardTool("get_progress_digest", async () => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: formatDigest(demoProgress(args.window ?? "24h")) }] };
        }
        const win = args.window ?? "24h";
        const data = await progress(win);
        return {
          content: [
            {
              type: "text",
              text: formatDigest({ demo: false, ...data, generated_at: new Date().toISOString() }),
            },
          ],
        };
      }),
    );

    server.registerTool(
      "get_morning_brief",
      {
        title: "Get morning brief",
        annotations: READ_ONLY,
        description:
          "Read the morning brief as plain text: merges, issue flow, stuck PRs, decisions waiting on the owner, and whether the coordinator's last event is real work. Same text as GET /api/brief. window is 24h (default) or 72h. A heartbeat does not count as working.",
        inputSchema: {
          window: z
            .enum(["24h", "72h"])
            .optional()
            .describe("24h or 72h. Defaults to 24h."),
        },
      },
      async (args) => guardTool("get_morning_brief", async () => {
        const text = await morningBriefText(args.window ?? "24h");
        return { content: [{ type: "text", text }] };
      }),
    );

    server.registerTool(
      "remember",
      {
        title: "Remember",
        annotations: WRITE_DESTRUCTIVE,
        description:
          "Write a note to Agent Kontrol shared memory so other agents (and future sessions) can see it. Use for decisions, handoffs, and 'don't duplicate this' coordination notes. Pass dry_run true to preview an insert or key overwrite without writing.",
        inputSchema: {
          content: z.string().describe("The note to store"),
          key: z.string().optional().describe("Optional stable key; writing the same key overwrites (good for living docs like 'project-x/status')"),
          tags: z.array(z.string()).optional().describe("Tags for filtering, e.g. ['agent-kontrol','decision']"),
          agent_id: z.string().optional().describe("Who is writing this note"),
          dry_run: z.boolean().optional().describe("When true, return what would be written and write nothing"),
        },
      },
      async (args) => guardTool("remember", () => rememberForTool(args)),
    );

    server.registerTool(
      "recall",
      {
        title: "Recall",
        annotations: READ_ONLY,
        description:
          "Search Agent Kontrol shared memory. Filter by free-text query, exact key, and/or tags. Returns the most recently updated notes first.",
        inputSchema: {
          query: z.string().optional().describe("Free-text search over note content"),
          key: z.string().optional().describe("Exact key lookup"),
          tags: z.array(z.string()).optional(),
          limit: z.number().optional().describe("Maximum notes, from 1 to 200. Defaults to 20. Passing limit or cursor adds a next_cursor line."),
          cursor: z.string().optional().describe("Opaque cursor from a previous next_cursor line."),
          fields: z.string().optional().describe("Comma-separated allowlisted fields. id is always included. One JSON object per line."),
        },
      },
      async (args) => guardTool("recall", async () => {
        const badKey = memoryKeyError(args.key);
        if (badKey) return badKey;
        if (!isConfigured() && args.limit === undefined && args.cursor === undefined && args.fields === undefined)
          return demoRecallTool({ query: args.query, key: args.key, tags: args.tags });
        return recallResult(args, isConfigured());
      }),
    );

    server.registerTool(
      "check_inbox",
      {
        title: "Check inbox",
        annotations: WRITE_IDEMPOTENT,
        description:
          "Check Agent Kontrol for messages the operator has sent to this agent. Call at the start of a task and periodically while working. Returns pending messages and marks them read.",
        inputSchema: {
          agent_id: z
            .string()
            .describe("This agent's id, e.g. 'cowork-cloud' or 'hermes-<host>'"),
          ack: z
            .boolean()
            .optional()
            .describe("Mark messages read so they aren't returned again (default true)"),
        },
      },
      async (args) => guardTool("check_inbox", async () => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Demo mode; no inbox." }] };
        }
        const msgs = await fetchMessages({ agent_id: args.agent_id, ack: args.ack ?? true });
        if (msgs.length === 0) {
          return { content: [{ type: "text", text: "No new messages." }] };
        }
        const text = msgs
          .map(
            (m) =>
              `- #${m.id} [${m.created_at}] from ${m.created_by ?? OPERATOR}` +
              (m.thread_id ? ` (thread ${m.thread_id})` : "") +
              `: ${m.body}`
          )
          .join("\n");
        return {
          content: [
            { type: "text", text: `You have ${msgs.length} message(s) from ${OPERATOR}:\n${text}` },
          ],
        };
      }),
    );

    // `reply_to_mark` is the tool's original name. Existing agents are told to call it
    // in their standing instructions, so it stays registered as a deprecated alias
    // for the whole 1.x line.
    const replyTools = [
      {
        name: "reply_to_operator",
        title: "Reply to the operator",
        description:
          "Send a reply to the operator in Agent Kontrol so it appears in the Fleet conversation drawer. Call after check_inbox when you have an answer, status update, or question. Optionally pass in_reply_to with the inbound message id.",
      },
      {
        name: "reply_to_mark",
        title: "Reply to the operator (deprecated alias)",
        description:
          "Deprecated alias of reply_to_operator, kept so existing agent instructions keep working. Behaves identically; prefer reply_to_operator.",
      },
    ];
    for (const tool of replyTools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          annotations: WRITE,
          description: tool.description,
          inputSchema: {
            agent_id: z
              .string()
              .describe("This agent's id, e.g. 'hermes-<host>' or 'codex-box'"),
            body: z.string().describe("Your reply text (1-20 lines)"),
            in_reply_to: z
              .number()
              .int()
              .optional()
              .describe("Optional id of the inbound message you are answering"),
            idempotency_key: z
              .string()
              .optional()
              .describe("Optional. Scoped by actor and route. The same key and the same arguments return the original reply for 24 hours and do not store a second row during that window. After 24 hours the same key starts a new write. The same key with different arguments is an error."),
          },
        },
        async (args) => guardTool(tool.name, async () => {
          if (!isConfigured()) {
            return { content: [{ type: "text", text: "Demo mode; reply not stored." }] };
          }
          const msg = await replyFromAgent({
            agent_id: args.agent_id,
            body: args.body,
            in_reply_to: args.in_reply_to,
            created_by: args.agent_id,
            actor: currentActor(),
            idempotency_key: args.idempotency_key,
          });
          const text = `Reply #${msg.id} delivered to Agent Kontrol` +
            (msg.thread_id ? ` (thread ${msg.thread_id}).` : ".");
          return withReceipt(text, readReceipt(msg));
        }),
      );
    }

    server.registerTool(
      "create_task",
      {
        title: "Create task",
        annotations: WRITE,
        description:
          "Queue a task for the fleet. A dispatcher (or another agent) will claim and run it. Use platform to route: 'codex' for terminal-heavy/parallel implementation, 'claude-code' for deep or large-codebase work, 'grok' for research/X-adjacent work, 'hermes' for messaging/ops, 'any' when it doesn't matter. Set reviewer_platform for cross-vendor review (e.g. claude-code writes, codex reviews).",
        inputSchema: {
          title: z.string().describe("Short imperative title"),
          description: z.string().optional().describe("Full instructions — this becomes the worker's prompt"),
          project: z.string().optional().describe("Repo/folder name under the dispatcher's workdir"),
          platform: z
            .enum(["claude-code", "codex", "grok", "hermes", "cowork-cloud", "any"])
            .optional(),
          machine: z.string().optional().describe("Pin to one machine's dispatcher"),
          priority: z.number().int().min(1).max(3).optional().describe("1 high, 2 normal (default), 3 low"),
          reviewer_platform: z
            .enum(["claude-code", "codex", "grok"])
            .optional()
            .describe("Have a second platform review the work before it's marked done"),
          created_by: z
            .string()
            .optional()
            .describe("Free-text label stored as created_by. It does not set actor_type or actor_id; the server records the authenticated credential."),
          idempotency_key: z
            .string()
            .optional()
            .describe("Optional. Scoped by actor and route. The same key and the same arguments return the original task for 24 hours and do not queue a second task during that window. After 24 hours the same key starts a new write. The same key with different arguments is an error."),
        },
      },
      async (args) => guardTool("create_task", async () => {
        if (!isConfigured()) return demoCreateTaskTool(args, currentActor());
        const task = await createTask({
          ...args,
          idempotency_key: args.idempotency_key,
          actor: currentActor(),
        });
        const text = `Task #${task.id} queued for ${task.platform} (priority ${task.priority}).`;
        return withReceipt(text, readReceipt(task));
      }),
    );

    server.registerTool(
      "get_task_queue",
      {
        title: "Get task queue",
        annotations: READ_ONLY,
        description:
          "See the fleet's task queue: what's queued, running, in review, or recently finished. Use before creating tasks to avoid duplicates, or to find work you could claim.",
        inputSchema: {
          status: z
            .enum(["open", "all", "queued", "claimed", "running", "review", "done", "failed", "cancelled"])
            .optional()
            .describe("Filter (default 'open')"),
          limit: z.number().optional().describe("Maximum tasks, from 1 to 200. Defaults to 40. Passing limit or cursor adds a next_cursor line."),
          cursor: z.string().optional().describe("Opaque cursor from a previous next_cursor line."),
          fields: z.string().optional().describe("Comma-separated allowlisted fields. id is always included. One JSON object per line."),
        },
      },
      async (args) => guardTool("get_task_queue", () => {
        if (!isConfigured() && args.limit === undefined && args.cursor === undefined && args.fields === undefined)
          return demoTaskQueueTool({ status: args.status });
        return taskQueueResult(args, isConfigured());
      }),
    );

    server.registerTool(
      "claim_task",
      {
        title: "Claim next task",
        annotations: WRITE,
        description:
          "Claim the next queued task routed to your platform (or 'any'). Returns the task's full instructions. When you finish, call update_task with status done/failed and a result summary.",
        inputSchema: {
          platform: z.enum(["claude-code", "codex", "grok", "hermes", "cowork-cloud"]),
          machine: z.string().optional(),
          agent_id: z.string().describe("Your agent id"),
        },
      },
      async (args) => guardTool("claim_task", async () => {
        if (!isConfigured()) return demoClaimTaskTool(args);
        const task = await claimNextTask(args);
        if (!task) {
          return { content: [{ type: "text", text: "No queued tasks for your platform." }] };
        }
        const text =
          `Claimed task #${task.id}: ${task.title}\n` +
          (task.project ? `Project: ${task.project}\n` : "") +
          (task.reviewer_platform ? `Review by: ${task.reviewer_platform} when done\n` : "") +
          `Instructions:\n${task.description ?? task.title}\n\n` +
          `When finished, call update_task (id: ${task.id}) with status 'done' or 'failed' and a result summary.`;
        return withReceipt(text, readReceipt(task));
      }),
    );

    server.registerTool(
      "update_task",
      {
        title: "Update task",
        annotations: WRITE_DESTRUCTIVE,
        description:
          "Update a task you're working on: mark it running, done, or failed, and attach a result summary (and cost if known). Pass dry_run true to preview the update, including a cancel, without writing.",
        inputSchema: {
          id: z.number().int(),
          status: z.enum(["running", "review", "done", "failed", "cancelled"]).optional(),
          result: z.string().optional().describe("What happened — 1-6 lines"),
          cost_usd: z.number().optional(),
          agent_id: z.string().optional().describe("Your agent id (for the activity feed)"),
          dry_run: z.boolean().optional().describe("When true, return what would change and write nothing"),
        },
      },
      async (args) => guardTool("update_task", () => updateTaskForTool(args)),
    );

    // Skills tools. Keep this block contiguous and after update_task.
    // run_skill is one tool with two phases. A second report_skill_done name
    // would be the same row and the same actor check.
    server.registerTool(
      "list_skills",
      {
        title: "List skills",
        annotations: READ_ONLY,
        description:
          "List skills whose trigger is not off, whose scope admits the lane, and which are compatible with runtime when runtime is passed. With no runtime, incompatible skills are not hidden. With no lane, selected-lane skills are hidden. Trigger off is omitted. category is an exact case-insensitive match. Pass uncategorized for skills with no category. Each line includes category and tags.",
        inputSchema: {
          runtime: z.enum(["claude", "codex", "grok", "hermes", "mini", "nemoclaw"]).optional().describe("Caller runtime. Omit to skip the runtime filter."),
          lane: z.string().optional().describe("Lane name. Required to see skills limited to selected lanes."),
          query: z.string().optional().describe("Case-insensitive match on id and description."),
          category: z.string().optional().describe("Exact category, case-insensitive. Pass uncategorized to list skills with no category."),
        },
      },
      async (args) => guardTool("list_skills", () => listSkillsTool(args)),
    );

    server.registerTool(
      "get_skill",
      {
        title: "Get skill",
        annotations: READ_ONLY,
        description:
          "Return the mirrored SKILL.md pinned to its content SHA, or one reference file when path is set. Never fetches the upstream repository. A skill whose trigger is off is not served.",
        inputSchema: {
          id: z.string().describe("Skill id."),
          path: z.string().optional().describe("Reference path relative to the skill directory. Omit for SKILL.md."),
          runtime: z.enum(["claude", "codex", "grok", "hermes", "mini", "nemoclaw"]).optional(),
          lane: z.string().optional(),
        },
      },
      async (args) => guardTool("get_skill", () => getSkillTool(args)),
    );

    server.registerTool(
      "run_skill",
      {
        title: "Run skill",
        annotations: WRITE,
        description:
          "Start or finish a skill run. The agent executes the instructions. Agent Kontrol only stores the start, the end, and an optional note. Omit run_id to start. id and runtime are required then. agent_id is optional: the recorded agent is the authenticated caller. Call again with that run_id and complete true to finish, and omit id. If you pass id on completion, it must match the skill on the run. Only the actor that started the run can finish it.",
        inputSchema: {
          id: z.string().optional().describe("Skill id. Required on start. Omit it on completion. If you pass it then, it must match the skill on the run."),
          agent_id: z.string().optional().describe("Omit to use the authenticated caller. An agent credential or OAuth client may pass only that same id."),
          runtime: z.enum(["claude", "codex", "grok", "hermes", "mini", "nemoclaw"]).optional().describe("Required on start. Caller hint for the rendered instructions, not an identity."),
          lane: z.string().optional().describe("Caller hint. Required when the skill's scope is selected. Not an identity."),
          run_id: z.string().optional().describe("Set with complete true to finish the run you started."),
          complete: z.boolean().optional().describe("True finishes the run. Requires run_id."),
          status: z.enum(["done", "failed"]).optional().describe("Completion outcome. Defaults to done."),
          note: z.string().optional().describe("Optional note, at most 500 characters. Not a prompt or a tool log."),
        },
      },
      async (args) => guardTool("run_skill", () => runSkillTool(args)),
    );

    // Decision tools. request and list do not resolve. resolve_decision is
    // decisions:write, so an agent that can only file a decision cannot close it.
    // The handlers below forward only the fields in each inputSchema.
    server.registerTool(
      "request_decision",
      {
        title: "Request a decision",
        annotations: WRITE,
        description:
          "File a decision for the owner. The key is agent:<your id>:<slug>. Sending the same slug again updates the open row and does not reopen a decided one. You cannot choose the key, the repo, or the issue number.",
        inputSchema: {
          slug: z.string().describe("Short lowercase id, unique for you. The same slug updates the same row."),
          title: z.string().describe("What the owner is deciding."),
          why: z.string().optional().describe("Why this needs the owner."),
          options: z
            .array(z.object({ id: z.string(), label: z.string() }))
            .max(20)
            .optional()
            .describe("Choices. Each has an id and a label."),
          recommended: z.string().optional().describe("Option id you recommend. Must be one of options when options are sent."),
        },
      },
      async (args) => guardTool("request_decision", () => requestDecisionTool({
        slug: args.slug,
        title: args.title,
        why: args.why,
        options: args.options,
        recommended: args.recommended,
      })),
    );

    server.registerTool(
      "list_decisions",
      {
        title: "List decisions",
        annotations: READ_ONLY,
        description:
          "Read the decision queue. This does not change a row. status defaults to open, which also includes deferrals whose date has passed.",
        inputSchema: {
          status: z.enum(["open", "decided", "deferred", "withdrawn", "all"]).optional(),
          repo: z.string().optional().describe("owner/name. Omit for every repo."),
          limit: z.number().int().min(1).max(1000).optional(),
        },
      },
      async (args) => guardTool("list_decisions", () => listDecisionsTool({
        status: args.status,
        repo: args.repo,
        limit: args.limit,
      })),
    );

    server.registerTool(
      "resolve_decision",
      {
        title: "Resolve a decision",
        annotations: WRITE,
        description:
          "Decide, defer, or withdraw a decision. Requires decisions:write or the dashboard. An agent that filed the decision cannot call this with only decisions:request. Send expected_revision from the row you loaded. expected_updated_at is accepted and is not the concurrency token. The GitHub comment goes to the issue named by the row key.",
        inputSchema: {
          id: z.number().int().positive(),
          status: z.enum(["open", "decided", "deferred", "withdrawn"]),
          decision: z.string().optional().describe("Required when status is decided, unless option_id names a choice."),
          defer_until: z.string().optional().describe("Required when status is deferred. A date is the end of that UTC day. A past date is rejected."),
          option_id: z.string().optional().describe("One of the row's option ids."),
          expected_updated_at: z.string().optional().describe("Accepted for older clients. Not compared."),
          expected_revision: z.number().int().nonnegative().optional().describe("revision from the row you loaded. A mismatch is stale."),
        },
      },
      async (args) => guardTool("resolve_decision", () => resolveDecisionTool({
        id: args.id,
        status: args.status,
        decision: args.decision,
        defer_until: args.defer_until,
        option_id: args.option_id,
        expected_updated_at: args.expected_updated_at,
        expected_revision: args.expected_revision,
      })),
    );

    server.registerTool(
      "send_message",
      {
        title: "Send message",
        annotations: WRITE,
        description:
          "Send an inbound message to an agent that has already reported. Requires messages:write. The recipient is slugified and must match an existing agent. body is at most 8000 characters and is stored as given. created_by is a label and does not set actor_type or actor_id. The server records the authenticated credential. idempotency_key matches create_task: the same key, actor, and arguments return the original message for 24 hours.",
        inputSchema: {
          agent_id: z.string().describe("Agent to receive the message. Slugified. Must already exist."),
          body: z.string().describe("Message text, 1 to 8000 characters. Not trimmed."),
          created_by: z.string().optional().describe("Free-text label. It does not set actor_type or actor_id."),
          idempotency_key: z
            .string()
            .optional()
            .describe("Optional. Scoped by actor and the enqueue_message route. The same key and the same arguments return the original message for 24 hours."),
        },
      },
      async (args) => guardTool("send_message", () => sendMessageTool(args)),
    );

    server.registerTool(
      "requeue_task",
      {
        title: "Requeue task",
        annotations: WRITE,
        description:
          "Put a done, failed, or cancelled task back to queued. Requires tasks:write. A running, claimed, or review task is refused. A running task held by another agent is forbidden. assigned_agent and completed_at are left as they are. dry_run true returns the diff and expected_revision and writes nothing. Send that expected_revision to make the confirm conditional. A mismatch is stale_write and writes nothing. The server records the authenticated actor on the task.",
        inputSchema: {
          id: z.number().int().describe("Task id."),
          agent_id: z
            .string()
            .optional()
            .describe("Caller compared with assigned_agent. Omit to use the authenticated actor id. This does not clear or set assigned_agent."),
          dry_run: z.boolean().optional().describe("True returns the preview and writes nothing."),
          expected_revision: z
            .string()
            .optional()
            .describe("Revision from the preview. Omit for an unconditional confirm. Ignored when dry_run is true, except that a bad token is still rejected."),
        },
      },
      async (args) => guardTool("requeue_task", () => requeueTaskTool(args)),
    );

    server.registerTool(
      "delete_note",
      {
        title: "Delete note",
        annotations: WRITE_DESTRUCTIVE,
        description:
          "Delete one shared memory note by key. Requires memory:write. A missing key is not_found and deletes nothing. dry_run true returns the diff and expected_revision and writes nothing. Send that expected_revision to make the confirm conditional. A mismatch is stale_write and writes nothing. The authenticated actor is named in the result. The memory table has no actor columns.",
        inputSchema: {
          key: z.string().describe("Memory key, 1 to 200 characters, no control characters."),
          dry_run: z.boolean().optional().describe("True returns the preview and writes nothing."),
          expected_revision: z
            .string()
            .optional()
            .describe("Revision from the preview. Omit for an unconditional confirm. Ignored when dry_run is true, except that a bad token is still rejected."),
        },
      },
      async (args) => guardTool("delete_note", () => deleteNoteTool(args)),
    );

    server.registerTool(
      "list_activity",
      {
        title: "List activity",
        annotations: READ_ONLY,
        description:
          "List write receipts and other events, newest first. Filter by actor (the authenticated actor id), kind, since, and until. since and until are inclusive ISO timestamps. limit, cursor, and fields match the other lists: limit is 1 to 200, cursor is the opaque next_cursor, and fields is a comma-separated allowlist. Operator only, the same boundary as traces. An agent credential is denied, including one with fleet:read. MC_TOKEN and an OAuth access token can call it. With no database, this reads the in-memory demo log.",
        inputSchema: {
          actor: z.string().optional().describe("Exact actor_id. Omit to include every actor."),
          kind: z.string().optional().describe("Exact event kind, such as task_updated or status."),
          since: z.string().optional().describe("Inclusive ISO timestamp. Rows at or after this instant."),
          until: z.string().optional().describe("Inclusive ISO timestamp. Rows in this millisecond and earlier."),
          limit: z.number().optional().describe("Maximum rows, from 1 to 200. Defaults to 50. Passing limit or cursor adds a next_cursor line."),
          cursor: z.string().optional().describe("Opaque cursor from a previous next_cursor line."),
          fields: z.string().optional().describe("Comma-separated allowlisted fields. id is always included. One JSON object per line."),
        },
      },
      async (args) => guardTool("list_activity", () => listActivityResult(args, isConfigured())),
    );

    server.registerTool(
      "get_settings",
      {
        title: "Get settings",
        annotations: READ_ONLY,
        description:
          "Read the watched repo list and the watched owners. The repos object matches GET /api/settings/repos, including source and version. The owners object matches GET /api/settings/owners. Operator only, the same boundary as list_activity. An agent credential is denied. MC_TOKEN and an OAuth access token can call it. With no database, this matches those GETs: file repos and an empty owner list.",
        inputSchema: {},
      },
      async () => guardTool("get_settings", () => getSettingsTool()),
    );

    server.registerTool(
      "set_watched_repos",
      {
        title: "Set watched repos",
        annotations: WRITE_DESTRUCTIVE,
        description:
          "Replace the hand-added watched repo list. Same validation and replace as PUT /api/settings/repos, including case-insensitive owner/name. Operator only, the same boundary as list_activity. An agent credential is denied. MC_TOKEN and an OAuth access token can call it. expected_version is required unless dry_run is true. Send the version from get_settings. A mismatch is stale and writes nothing. dry_run true returns the diff (added, removed, and changed repos) and the current version and writes nothing. A successful write records one activity receipt for the authenticated actor. Auto rows the body omits stay.",
        inputSchema: {
          repos: z
            .array(
              z.object({
                repo: z.string(),
                label: z.string(),
                short: z.string(),
                color: z.string(),
                blockedLabel: z.string().nullable().optional(),
                pinned: z.boolean().optional(),
                hidden: z.boolean().optional(),
              }),
            )
            .describe("Hand-added repos, the same objects as PUT /api/settings/repos."),
          expected_version: z
            .string()
            .optional()
            .describe("version from get_settings. Required unless dry_run is true. A mismatch is stale and writes nothing."),
          dry_run: z.boolean().optional().describe("True returns the diff and the current version and writes nothing."),
        },
      },
      async (args) => guardTool("set_watched_repos", () => setWatchedReposTool(args)),
    );
  },
  {},
  {
    basePath: "/api",
    maxDuration: 60,
  }
);

/**
 * Accept either a legacy MC_TOKEN bearer OR a valid OAuth access JWT.
 * Returning undefined makes mcp-handler respond 401 + WWW-Authenticate
 * pointing at /.well-known/oauth-protected-resource.
 */
async function verifyToken(_req: Request, bearerToken?: string) {
  if (!bearerToken) return undefined;

  // 1. Legacy shared secret — keeps existing dispatchers/agents working.
  //    It has every scope. The scope list on the AuthInfo stays ["mcp"]
  //    so nothing that read that field changes; enforcement uses extra.kind.
  const mcToken = process.env.MC_TOKEN;
  if (mcToken && (await secretsMatch(bearerToken, mcToken))) {
    return {
      token: bearerToken,
      clientId: "mc-token",
      scopes: ["mcp"],
      extra: { kind: "legacy" },
    };
  }

  // 2. Per-agent credential. Unknown, revoked, expired, or a store error
  //    returns undefined: the same 401 + WWW-Authenticate as any other
  //    bad bearer. Do not fall through to OAuth.
  if (bearerToken.startsWith("akc_")) {
    const resolved = await resolveAgentCredential(bearerToken);
    if (resolved.status !== "ok") return undefined;
    return {
      token: bearerToken,
      clientId: resolved.credential.id,
      scopes: [...resolved.credential.scopes],
      extra: { kind: "agent" },
    };
  }

  // 3. OAuth access token (HS256 JWT). Verification and this return value
  //    are unchanged. An authenticated OAuth principal keeps all-access;
  //    the "mcp" scope string is not checked against the scope table.
  const payload = await verifyAccessToken(bearerToken);
  if (!payload) return undefined;
  if (payload.typ === "refresh") return undefined;

  return {
    token: bearerToken,
    clientId: payload.client_id,
    scopes: payload.scope ? payload.scope.split(" ").filter(Boolean) : ["mcp"],
    expiresAt: payload.exp,
    extra: { sub: payload.sub },
  };
}

function scopeDenied(body: { error: string; code: string; fix: string; retryable: false }): Response {
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

/**
 * tools/call is checked here, before the tool runs. An empty body or a body
 * that is not JSON is HTTP 400 invalid_json, so mcp-handler never sees a
 * SyntaxError from req.json(). A JSON body that is not a tool call is left
 * to the handler. Auth still runs first: a missing bearer is 401 with
 * WWW-Authenticate and never reaches this function.
 */
async function enforceMcpScope(req: Request): Promise<Response | null> {
  if (req.method !== "POST") return null;
  let text = "";
  try {
    text = await req.clone().text();
  } catch {
    return apiError("invalid_json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return apiError("invalid_json");
  }
  const decision = evaluateMcpMessages(principalFromMcpAuth(req.auth), parsed);
  if (decision.ok) return null;
  return scopeDenied(decision.body);
}

const authed = withMcpAuth(
  async (req) => {
    const denied = await enforceMcpScope(req);
    if (denied) return denied;
    const principal = principalFromMcpAuth(req.auth);
    if (!principal) return handler(req);
    return runWithActor(actorFromPrincipal(principal), () => handler(req));
  },
  verifyToken,
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource",
  },
);

export { authed as GET, authed as POST, authed as DELETE };
