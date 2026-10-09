import { secretsMatch } from "./authcrypto";

/**
 * Shared-secret auth for agents reporting in.
 *
 * Accepts `Authorization: Bearer <MC_TOKEN>` always.
 * The `?key=<MC_TOKEN>` query form is accepted ONLY when the caller
 * explicitly opts in via `{ allowQueryKey: true }` (some MCP/connector
 * clients can't set custom headers). URLs — including query strings —
 * routinely end up in server logs, browser history, and proxies, so
 * putting a secret in a query parameter is opt-in and discouraged.
 *
 * If MC_TOKEN is unset:
 *   - outside production (local dev / demo mode): everything is allowed.
 *   - in production: everything is denied (fail closed).
 */
export async function isAuthorized(
  req: Request,
  opts?: { allowQueryKey?: boolean },
): Promise<boolean> {
  const token = process.env.MC_TOKEN;
  if (!token) {
    return process.env.NODE_ENV !== "production";
  }
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ") && (await secretsMatch(header.slice(7), token))) {
    return true;
  }
  if (opts?.allowQueryKey === true) {
    try {
      const url = new URL(req.url);
      const key = url.searchParams.get("key");
      if (key && (await secretsMatch(key, token))) return true;
    } catch {
      // ignore
    }
  }
  return false;
}
