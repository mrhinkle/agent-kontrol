import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { secretsMatch, verifyAccessToken } from "@/lib/authcrypto";
import { isConfigured } from "@/lib/db";
import { claimNextTask, createTask, fetchMessages, fleet, listTasks, recall, remember, replyFromAgent, report, updateTask } from "@/lib/store";
import { progress } from "@/lib/progress-store";
import { formatDigest } from "@/lib/progress-digest";
import { OPERATOR } from "@/lib/operator";
import { demoProgress } from "@/lib/demo-progress";

export const maxDuration = 60;

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
      async (args) => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Agent Kontrol is in demo mode (no database configured); status not stored." }] };
        }
        await report({
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
        });
        return { content: [{ type: "text", text: "Status reported to Agent Kontrol." }] };
      }
    );

    server.registerTool(
      "get_fleet_status",
      {
        title: "Get fleet status",
        description:
          "See what every agent in the fleet (Claude Code, Cowork, ChatGPT Work, Hermes, ...) is currently doing, with recent activity. Use this to avoid duplicating work another agent is already on.",
        inputSchema: {},
      },
      async () => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Agent Kontrol is in demo mode (no database configured)." }] };
        }
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
      }
    );

    server.registerTool(
      "get_progress_digest",
      {
        title: "Get progress digest",
        description:
          "Read the fleet progress board as plain text: PRs merged, issues closed vs opened, net backlog per repo, and anything over a threshold that needs the operator's attention. Use this for a scheduled morning digest, or whenever asked whether the work is actually moving. The headline is net backlog (opened minus closed), not merge count — a high-merge day can still lose ground.",
        inputSchema: {
          window: z
            .enum(["24h", "7d", "30d", "90d"])
            .optional()
            .describe("Time window to summarise; defaults to 24h"),
        },
      },
      async (args) => {
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
      }
    );

    server.registerTool(
      "remember",
      {
        title: "Remember",
        description:
          "Write a note to Agent Kontrol shared memory so other agents (and future sessions) can see it. Use for decisions, handoffs, and 'don't duplicate this' coordination notes.",
        inputSchema: {
          content: z.string().describe("The note to store"),
          key: z.string().optional().describe("Optional stable key; writing the same key overwrites (good for living docs like 'project-x/status')"),
          tags: z.array(z.string()).optional().describe("Tags for filtering, e.g. ['agent-kontrol','decision']"),
          agent_id: z.string().optional().describe("Who is writing this note"),
        },
      },
      async (args) => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Demo mode; note not stored." }] };
        }
        const item = await remember(args);
        return { content: [{ type: "text", text: `Stored memory #${item.id}${item.key ? ` (key: ${item.key})` : ""}.` }] };
      }
    );

    server.registerTool(
      "recall",
      {
        title: "Recall",
        description:
          "Search Agent Kontrol shared memory. Filter by free-text query, exact key, and/or tags. Returns the most recently updated notes first.",
        inputSchema: {
          query: z.string().optional().describe("Free-text search over note content"),
          key: z.string().optional().describe("Exact key lookup"),
          tags: z.array(z.string()).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
      },
      async (args) => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Demo mode; no stored memory." }] };
        }
        const items = await recall(args);
        if (items.length === 0) {
          return { content: [{ type: "text", text: "No matching memory." }] };
        }
        const text = items
          .map(
            (m) =>
              `#${m.id}${m.key ? ` [${m.key}]` : ""}${m.tags.length ? ` (${m.tags.join(", ")})` : ""} by ${m.agent_id ?? "unknown"} @ ${m.updated_at}\n${m.content}`
          )
          .join("\n\n");
        return { content: [{ type: "text", text }] };
      }
    );

    server.registerTool(
      "check_inbox",
      {
        title: "Check inbox",
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
      async (args) => {
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
      }
    );

    server.registerTool(
      "reply_to_operator",
      {
        title: "Reply to the operator",
        description:
          "Send a reply to the operator in Agent Kontrol so it appears in the Fleet conversation drawer. Call after check_inbox when you have an answer, status update, or question. Optionally pass in_reply_to with the inbound message id.",
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
        },
      },
      async (args) => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Demo mode; reply not stored." }] };
        }
        const msg = await replyFromAgent({
          agent_id: args.agent_id,
          body: args.body,
          in_reply_to: args.in_reply_to,
          created_by: args.agent_id,
        });
        return {
          content: [
            {
              type: "text",
              text: `Reply #${msg.id} delivered to Agent Kontrol` +
                (msg.thread_id ? ` (thread ${msg.thread_id}).` : "."),
            },
          ],
        };
      }
    );

    server.registerTool(
      "create_task",
      {
        title: "Create task",
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
          created_by: z.string().optional().describe("Your agent id"),
        },
      },
      async (args) => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Demo mode; task not queued." }] };
        }
        const task = await createTask(args);
        return {
          content: [
            { type: "text", text: `Task #${task.id} queued for ${task.platform} (priority ${task.priority}).` },
          ],
        };
      }
    );

    server.registerTool(
      "get_task_queue",
      {
        title: "Get task queue",
        description:
          "See the fleet's task queue: what's queued, running, in review, or recently finished. Use before creating tasks to avoid duplicates, or to find work you could claim.",
        inputSchema: {
          status: z
            .enum(["open", "all", "queued", "claimed", "running", "review", "done", "failed", "cancelled"])
            .optional()
            .describe("Filter (default 'open')"),
        },
      },
      async (args) => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Demo mode; no task queue." }] };
        }
        const tasks = await listTasks({ status: args.status ?? "open", limit: 40 });
        if (tasks.length === 0) {
          return { content: [{ type: "text", text: "Task queue is empty." }] };
        }
        const text = tasks
          .map(
            (t) =>
              `#${t.id} [${t.status.toUpperCase()}] (${t.platform}, p${t.priority}) ${t.title}` +
              (t.project ? ` — project: ${t.project}` : "") +
              (t.assigned_agent ? ` — agent: ${t.assigned_agent}` : "") +
              (t.result ? `\n   result: ${t.result.slice(0, 200)}` : "")
          )
          .join("\n");
        return { content: [{ type: "text", text }] };
      }
    );

    server.registerTool(
      "claim_task",
      {
        title: "Claim next task",
        description:
          "Claim the next queued task routed to your platform (or 'any'). Returns the task's full instructions. When you finish, call update_task with status done/failed and a result summary.",
        inputSchema: {
          platform: z.enum(["claude-code", "codex", "grok", "hermes", "cowork-cloud"]),
          machine: z.string().optional(),
          agent_id: z.string().describe("Your agent id"),
        },
      },
      async (args) => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Demo mode; no tasks." }] };
        }
        const task = await claimNextTask(args);
        if (!task) {
          return { content: [{ type: "text", text: "No queued tasks for your platform." }] };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Claimed task #${task.id}: ${task.title}\n` +
                (task.project ? `Project: ${task.project}\n` : "") +
                (task.reviewer_platform ? `Review by: ${task.reviewer_platform} when done\n` : "") +
                `Instructions:\n${task.description ?? task.title}\n\n` +
                `When finished, call update_task (id: ${task.id}) with status 'done' or 'failed' and a result summary.`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "update_task",
      {
        title: "Update task",
        description:
          "Update a task you're working on: mark it running, done, or failed, and attach a result summary (and cost if known).",
        inputSchema: {
          id: z.number().int(),
          status: z.enum(["running", "review", "done", "failed", "cancelled"]).optional(),
          result: z.string().optional().describe("What happened — 1-6 lines"),
          cost_usd: z.number().optional(),
          agent_id: z.string().optional().describe("Your agent id (for the activity feed)"),
        },
      },
      async (args) => {
        if (!isConfigured()) {
          return { content: [{ type: "text", text: "Demo mode; task not updated." }] };
        }
        const task = await updateTask(args);
        if (args.status && args.agent_id) {
          await report({
            agent_id: args.agent_id,
            kind: args.status === "failed" ? "error" : "status",
            title: `Task #${task.id} → ${args.status}: ${task.title}`,
            detail: { task_id: task.id },
          });
        }
        return { content: [{ type: "text", text: `Task #${task.id} updated (${task.status}).` }] };
      }
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
  const mcToken = process.env.MC_TOKEN;
  if (mcToken && (await secretsMatch(bearerToken, mcToken))) {
    return {
      token: bearerToken,
      clientId: "mc-token",
      scopes: ["mcp"],
    };
  }

  // 2. OAuth access token (HS256 JWT).
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

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { authed as GET, authed as POST, authed as DELETE };
