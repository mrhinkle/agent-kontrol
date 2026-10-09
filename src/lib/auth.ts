import { secretsMatch } from "./authcrypto";

/**
 * Shared-secret auth for agents reporting in.
 * Accepts either `Authorization: Bearer <MC_TOKEN>` or `?key=<MC_TOKEN>`
 * (some MCP/connector clients can't set custom headers — treat such URLs
 * as secrets; responses are never cached).
 * If MC_TOKEN is unset, everything is allowed (local dev / demo mode).
 */
export async function isAuthorized(req: Request): Promise<boolean> {
  const token = process.env.MC_TOKEN;
  if (!token) return true;
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ") && (await secretsMatch(header.slice(7), token))) {
    return true;
  }
  try {
    const url = new URL(req.url);
    const key = url.searchParams.get("key");
    if (key && (await secretsMatch(key, token))) return true;
  } catch {
    // ignore
  }
  return false;
}
