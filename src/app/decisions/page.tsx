"use client";

import { useCallback, useEffect, useState } from "react";
import { DecisionList } from "@/components/DecisionQueue";
import { decisionAwaitingWriteback, decisionQueueVisible, decisionsForPage, loadDecisionPage } from "@/lib/decision-page";
import type { Decision } from "@/lib/decisions";

export default function DecisionsPage() {
  const [rows, setRows] = useState<Decision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async (keep?: Decision | null) => {
    const loaded = await loadDecisionPage();
    if (!loaded.ok) {
      setError(loaded.error);
      setLoadFailed(true);
      setRows(decisionAwaitingWriteback(keep) ? decisionsForPage([], [keep]) : []);
      return;
    }
    setLoadFailed(false);
    setRows(decisionAwaitingWriteback(keep) ? decisionsForPage(loaded.decisions, [keep]) : loaded.decisions);
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  async function onResolve(id: number, payload: Record<string, unknown>) {
    setError(null);
    const res = await fetch(`/api/decisions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string; decision?: Decision };
    if (!res.ok) {
      if (body.code === "stale") setError("This decision changed. Reload to see the latest.");
      else if (body.code === "writeback_in_progress") setError("A write-back is in progress for this decision.");
      else if (body.code === "conflict") setError("This decision is already decided or withdrawn.");
      else setError(body.error ?? "Could not update the decision.");
      await load();
      return;
    }
    await load(body.decision ?? null);
  }

  async function onRetry(decision: Decision) {
    setError(null);
    const res = await fetch(`/api/decisions/${decision.id}/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_updated_at: decision.updated_at,
        expected_revision: decision.revision,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string; decision?: Decision };
    if (!res.ok) {
      if (body.code === "stale") setError("This decision changed. Reload to see the latest.");
      else setError(body.error ?? "Could not write the decision back.");
      await load(decisionAwaitingWriteback(decision) ? decision : null);
      return;
    }
    await load(body.decision ?? null);
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-1">Decisions</h1>
      <p className="text-sm text-gray-400 mb-4">Oldest open item first. Decide, defer, or withdraw.</p>
      {error ? <p className="text-sm text-red-400 mb-3">{error}</p> : null}
      {rows == null ? (
        <p className="text-sm text-gray-500">Loading decisions…</p>
      ) : decisionQueueVisible(rows, loadFailed) ? (
        <DecisionList decisions={rows} onResolve={onResolve} onRetry={onRetry} />
      ) : null}
    </div>
  );
}
