"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { deriveAttention, type AttentionItem, type AttentionTone } from "@/lib/attention";
import { DemoPill } from "@/components/ui";
import type { FleetResponse, Task } from "@/lib/types";

const POLL_MS = 15_000;
const PROGRESS_POLL_MS = 60_000;
const PROGRESS_TIMEOUT_MS = 5_000;

const TONE: Record<AttentionTone, { fg: string; bg: string; ring: string }> = {
  red: { fg: "#ff9db0", bg: "#ff3b5c22", ring: "#ff3b5c88" },
  amber: { fg: "#ffd27a", bg: "#ffb02022", ring: "#ffb02088" },
  cyan: { fg: "#8be6ff", bg: "#19d2ff1a", ring: "#19d2ff66" },
};

interface Snapshot {
  demo: boolean;
  items: AttentionItem[];
}

/**
 * Polls fleet, tasks and (slowly) progress and reduces them to the header pills.
 * Lighter cadence than the pages themselves; a page's own poll is the fresh one.
 */
function useAttention(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const progressRef = useRef<{ count: number | null; at: number }>({ count: null, at: 0 });

  useEffect(() => {
    let alive = true;
    let inFlight = false;

    async function loadProgress(): Promise<number | null> {
      const cached = progressRef.current;
      if (cached.at && Date.now() - cached.at < PROGRESS_POLL_MS) return cached.count;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PROGRESS_TIMEOUT_MS);
      try {
        const res = await fetch("/api/progress?window=24h", { cache: "no-store", signal: abort.signal });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { alerts?: unknown[] };
        progressRef.current = { count: Array.isArray(json.alerts) ? json.alerts.length : 0, at: Date.now() };
      } catch {
        progressRef.current = { count: null, at: Date.now() };
      } finally {
        clearTimeout(timer);
      }
      return progressRef.current.count;
    }

    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const [fleetRes, tasksRes, progressAlerts] = await Promise.all([
          fetch("/api/fleet", { cache: "no-store" }),
          fetch("/api/tasks?status=all&limit=200", { cache: "no-store" }),
          loadProgress(),
        ]);
        if (!fleetRes.ok) throw new Error(`fleet API ${fleetRes.status}`);
        const fleet = (await fleetRes.json()) as FleetResponse;
        const tasks = tasksRes.ok ? ((await tasksRes.json()) as { tasks?: Task[] }).tasks ?? [] : [];
        if (alive) setSnap({ demo: fleet.demo, items: deriveAttention({ agents: fleet.agents, tasks, progressAlerts }) });
      } catch {
        // Keep the last good strip; the page body reports its own errors.
      } finally {
        inFlight = false;
      }
    }

    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return snap;
}

export function AttentionStrip() {
  const snap = useAttention();
  if (!snap) return null;
  return (
    <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto sm:justify-end" role="status" aria-live="polite" aria-label="Attention">
      {snap.items.map((item) => {
        const t = TONE[item.tone];
        return (
          <Link
            key={item.key}
            href={item.href}
            title={item.title}
            className="mono whitespace-nowrap rounded-full px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider transition-[filter] hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#19d2ff]"
            style={{ color: t.fg, backgroundColor: t.bg, boxShadow: `inset 0 0 0 1px ${t.ring}` }}
          >
            {item.tone === "red" ? "● " : item.tone === "amber" ? "▲ " : ""}
            {item.label}
          </Link>
        );
      })}
      {snap.items.length === 0 && (
        <span className="mono flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-gray-500" title="No failures, nobody waiting on you">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#2ee6a6]" />
          clear
        </span>
      )}
      {snap.demo && <DemoPill />}
    </div>
  );
}
