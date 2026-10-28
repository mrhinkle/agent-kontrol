"use client";

import { useCallback, useEffect, useState } from "react";
import { DecisionList } from "@/components/DecisionQueue";
import type { Decision } from "@/lib/decisions";

export default function DecisionsPage() {
  const [rows, setRows] = useState<Decision[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/decisions?status=open");
    const body = (await res.json().catch(() => ({}))) as { decisions?: Decision[]; error?: string };
    if (!res.ok) {
      setError(body.error ?? "Failed to load decisions.");
      setRows([]);
      return;
    }
    setRows(body.decisions ?? []);
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
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    if (!res.ok) {
      if (body.code === "stale") setError("This decision changed. Reload to see the latest.");
      else if (body.code === "conflict") setError("This decision is already decided or withdrawn.");
      else setError(body.error ?? "Could not update the decision.");
    }
    await load();
  }

  async function onRetry(decision: Decision) {
    setError(null);
    const res = await fetch(`/api/decisions/${decision.id}/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_updated_at: decision.updated_at }),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    if (!res.ok) {
      if (body.code === "stale") setError("This decision changed. Reload to see the latest.");
      else setError(body.error ?? "Could not write the decision back.");
    }
    await load();
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-1">Decisions</h1>
      <p className="text-sm text-gray-400 mb-4">Oldest open item first. Decide, defer, or withdraw.</p>
      {error ? <p className="text-sm text-red-400 mb-3">{error}</p> : null}
      {rows == null ? (
        <p className="text-sm text-gray-500">Loading decisions…</p>
      ) : (
        <DecisionList decisions={rows} onResolve={onResolve} onRetry={onRetry} />
      )}
    </div>
  );
}
