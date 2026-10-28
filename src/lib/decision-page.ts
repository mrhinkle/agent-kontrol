/**
 * What /decisions shows. Open rows, plus decided rows whose GitHub comment
 * did not land, so Retry write-back stays on the page after a reload.
 */

import type { Decision } from "./decisions";

export function decisionsForPage(openRows: Decision[], decidedRows: Decision[]): Decision[] {
  const byId = new Map<number, Decision>();
  for (const row of openRows) byId.set(row.id, row);
  for (const row of decidedRows) {
    if (row.status === "decided" && row.writeback === "not_written") byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at) || a.id - b.id);
}

export async function loadDecisionPage(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: true; decisions: Decision[] } | { ok: false; error: string }> {
  let openRes: Response;
  let pendingRes: Response;
  try {
    [openRes, pendingRes] = await Promise.all([
      fetchImpl("/api/decisions?status=open"),
      fetchImpl("/api/decisions?status=decided&writeback=not_written&limit=100"),
    ]);
  } catch {
    return { ok: false, error: "Failed to load decisions." };
  }
  const openBody = (await openRes.json().catch(() => ({}))) as { decisions?: Decision[]; error?: string };
  if (!openRes.ok) return { ok: false, error: openBody.error ?? "Failed to load decisions." };
  const pendingBody = (await pendingRes.json().catch(() => ({}))) as { decisions?: Decision[]; error?: string };
  // A failed pending load must not look like an empty retry queue. The page
  // shows this error instead of hiding decided rows that still need write-back.
  if (!pendingRes.ok) {
    return { ok: false, error: pendingBody.error ?? "Failed to load decisions that still need write-back." };
  }
  const pending = Array.isArray(pendingBody.decisions) ? pendingBody.decisions : [];
  return { ok: true, decisions: decisionsForPage(openBody.decisions ?? [], pending) };
}
