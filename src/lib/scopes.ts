/**
 * Scopes for per-agent credentials.
 *
 * One table maps every agent-facing MCP tool and every agent-facing REST
 * route to exactly one scope. `requireScope` is the only allow decision.
 * A tool name that is not registered is denied for every principal.
 * `list_activity` is registered and is not in the table: an agent credential
 * is denied, and the legacy MC_TOKEN, the dashboard session, and OAuth can
 * call it. A REST route that is not in the table is denied for an agent
 * credential; the legacy MC_TOKEN, the dashboard session, and OAuth keep the
 * access they already had.
 *
 * OAuth tokens are still issued with the scope string "mcp". That string is
 * not an entry in this table and is not what we check.
 */

export const SCOPES = [
  "status:write",
  "fleet:read",
  "tasks:read",
  "tasks:write",
  "memory:read",
  "memory:write",
  "messages:read",
  "messages:write",
  "progress:read",
  "decisions:read",
  "decisions:request",
  "decisions:write",
  "skills:read",
  "skills:write",
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

/** MCP tool name -> required scope. Includes the deprecated reply alias. */
export const TOOL_SCOPES: Record<string, Scope> = {
  report_status: "status:write",
  get_fleet_status: "fleet:read",
  get_progress_digest: "progress:read",
  get_morning_brief: "progress:read",
  remember: "memory:write",
  recall: "memory:read",
  check_inbox: "messages:read",
  reply_to_operator: "messages:write",
  reply_to_mark: "messages:write",
  create_task: "tasks:write",
  get_task_queue: "tasks:read",
  claim_task: "tasks:write",
  update_task: "tasks:write",
  list_skills: "skills:read",
  get_skill: "skills:read",
  run_skill: "skills:write",
  list_decisions: "decisions:read",
  request_decision: "decisions:request",
  resolve_decision: "decisions:write",
  send_message: "messages:write",
  requeue_task: "tasks:write",
  delete_note: "memory:write",
};

/**
 * Agent-facing REST routes. Method + path. Collector and operator-only
 * routes are omitted on purpose: an agent credential cannot call them.
 * The legacy token and the dashboard session still can.
 */
const ROUTE_SCOPES: { method: string; path: RegExp; scope: Scope }[] = [
  { method: "GET", path: /^\/api\/fleet$/, scope: "fleet:read" },
  // GET /api/activity stays off this table, same as GET /api/traces.
  // An agent credential cannot read the activity stream. MC_TOKEN and the
  // dashboard session still can.
  { method: "POST", path: /^\/api\/ingest$/, scope: "status:write" },
  { method: "GET", path: /^\/api\/memory$/, scope: "memory:read" },
  { method: "POST", path: /^\/api\/memory$/, scope: "memory:write" },
  { method: "GET", path: /^\/api\/messages$/, scope: "messages:read" },
  { method: "POST", path: /^\/api\/messages\/reply$/, scope: "messages:write" },
  { method: "GET", path: /^\/api\/progress$/, scope: "progress:read" },
  { method: "GET", path: /^\/api\/progress\/digest$/, scope: "progress:read" },
  { method: "GET", path: /^\/api\/brief$/, scope: "progress:read" },
  { method: "GET", path: /^\/api\/brief\/alerts$/, scope: "progress:read" },
  // POST /api/brief/alerts/evaluate stays off this table. The cron uses
  // MC_TOKEN, the same way POST /api/progress/ingest does. An agent
  // credential cannot send alerts.
  { method: "GET", path: /^\/api\/tasks$/, scope: "tasks:read" },
  { method: "POST", path: /^\/api\/tasks$/, scope: "tasks:write" },
  { method: "POST", path: /^\/api\/tasks\/claim$/, scope: "tasks:write" },
  { method: "PATCH", path: /^\/api\/tasks\/[^/]+$/, scope: "tasks:write" },
  // GET and POST stay off this table: the collector uses MC_TOKEN and the
  // dashboard uses the session. An agent credential can change a decision
  // only when it holds decisions:write.
  { method: "PATCH", path: /^\/api\/decisions\/[^/]+$/, scope: "decisions:write" },
  { method: "POST", path: /^\/api\/decisions\/[^/]+\/writeback$/, scope: "decisions:write" },
  // GET only. PATCH, POST /api/skills/sync, POST /api/skills/drift, and
  // GET /api/skill-bundles are operator routes: an agent must not be able to
  // turn a skill on, sync, file a drift report, or download the skill tree.
  // The lookahead keeps sync and drift off skills:read. A skill id of
  // "export" stays on this route: the bundle download is /api/skill-bundles.
  { method: "GET", path: /^\/api\/skills$/, scope: "skills:read" },
  { method: "GET", path: /^\/api\/skills\/(?!sync$|drift$)[^/]+$/, scope: "skills:read" },
  // Read-only: renders the pointer block, and POST only transforms the text sent.
  { method: "POST", path: /^\/api\/skills\/pointers$/, scope: "skills:read" },
];

export type Principal =
  | { kind: "legacy" }
  | { kind: "session" }
  | { kind: "dev-open" }
  | { kind: "oauth"; id: string }
  | { kind: "agent"; id: string; scopes: readonly string[] };

export type ScopeErrorBody = {
  error: string;
  code: "insufficient_scope";
  fix: string;
  retryable: false;
};

export function insufficientScopeBody(scope: string | null): ScopeErrorBody {
  if (scope) {
    return {
      error: `The credential does not have the ${scope} scope.`,
      code: "insufficient_scope",
      fix: `Use a credential that has the ${scope} scope`,
      retryable: false,
    };
  }
  return {
    error: "This route is not available to an agent credential.",
    code: "insufficient_scope",
    fix: "This route is not granted by any agent scope.",
    retryable: false,
  };
}

export type ScopeDecision = { ok: true } | { ok: false; status: 403; body: ScopeErrorBody };

/** True when this principal is not limited to the scopes on a credential. */
function unrestricted(principal: Principal): boolean {
  return principal.kind !== "agent";
}

/**
 * Allow only when the principal may use `scope`.
 * A null scope means the tool or route is not in the table.
 * Unrestricted principals (legacy token, dashboard session, OAuth, dev-open)
 * are allowed through a null scope so existing callers keep working.
 * An agent credential is denied.
 */
export function requireScope(principal: Principal, scope: Scope | null): ScopeDecision {
  if (scope === null) {
    if (unrestricted(principal)) return { ok: true };
    return { ok: false, status: 403, body: insufficientScopeBody(null) };
  }
  if (unrestricted(principal)) return { ok: true };
  if (principal.kind === "agent" && principal.scopes.includes(scope)) return { ok: true };
  return { ok: false, status: 403, body: insufficientScopeBody(scope) };
}

/**
 * Registered tools with the traces boundary: no agent scope grants them.
 * Unrestricted principals (legacy MC_TOKEN, dashboard session, OAuth,
 * dev-open) are allowed. An unknown name is still denied for every
 * principal, including those.
 */
const OPERATOR_TOOLS: ReadonlySet<string> = new Set(["list_activity"]);

/** Tool calls fail closed for every principal when the name is not mapped. */
export function authorizeTool(principal: Principal, tool: string): ScopeDecision {
  if (OPERATOR_TOOLS.has(tool)) return requireScope(principal, null);
  const scope = TOOL_SCOPES[tool];
  if (!scope) {
    return { ok: false, status: 403, body: insufficientScopeBody(null) };
  }
  return requireScope(principal, scope);
}

export function scopeForRoute(method: string, pathname: string): Scope | null {
  const hit = ROUTE_SCOPES.find((row) => row.method === method.toUpperCase() && row.path.test(pathname));
  return hit?.scope ?? null;
}

export function authorizeRoute(principal: Principal, method: string, pathname: string): ScopeDecision {
  return requireScope(principal, scopeForRoute(method, pathname));
}

type McpAuthShape = {
  clientId?: string;
  scopes?: string[];
  extra?: Record<string, unknown> | null;
};

/**
 * Classify the AuthInfo `verifyToken` returned.
 * OAuth's return value is unchanged (`extra.sub` set, no kind). Anything
 * we cannot classify is denied.
 */
export function principalFromMcpAuth(auth: McpAuthShape | null | undefined): Principal | null {
  if (!auth) return null;
  const extra = auth.extra ?? undefined;
  const kind = extra && typeof extra.kind === "string" ? extra.kind : undefined;
  if (kind === "agent") {
    return {
      kind: "agent",
      id: String(auth.clientId ?? ""),
      scopes: Array.isArray(auth.scopes) ? auth.scopes.map((s) => String(s)) : [],
    };
  }
  if (auth.clientId === "mc-token" || kind === "legacy") return { kind: "legacy" };
  if (extra && Object.prototype.hasOwnProperty.call(extra, "sub")) {
    const clientId = typeof auth.clientId === "string" ? auth.clientId : "";
    const sub = typeof extra.sub === "string" ? extra.sub : "";
    return { kind: "oauth", id: clientId || sub || "oauth" };
  }
  return null;
}

/**
 * Decide a JSON-RPC body. Non-tool methods are allowed once the caller is
 * authenticated. A tools/call whose name is missing or unmapped is denied.
 * An unreadable message is denied.
 */
export function evaluateMcpMessages(
  principal: Principal | null,
  parsed: unknown,
): { ok: true } | { ok: false; body: ScopeErrorBody } {
  if (!principal) return { ok: false, body: insufficientScopeBody(null) };
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") return { ok: false, body: insufficientScopeBody(null) };
    const method = (msg as { method?: unknown }).method;
    if (typeof method !== "string") return { ok: false, body: insufficientScopeBody(null) };
    if (method !== "tools/call") continue;
    const name = (msg as { params?: { name?: unknown } }).params?.name;
    if (typeof name !== "string" || name.length === 0) {
      return { ok: false, body: insufficientScopeBody(null) };
    }
    const decision = authorizeTool(principal, name);
    if (!decision.ok) return { ok: false, body: decision.body };
  }
  return { ok: true };
}
