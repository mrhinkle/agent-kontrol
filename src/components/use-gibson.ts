"use client";

import { useEffect, useRef, useState } from "react";
import { aggregate, type ProgressPayload, type TasksPayload } from "@/lib/gibson-derive";
import type { GibsonSceneModel } from "@/lib/gibson-types";
import type { FleetResponse } from "@/lib/types";

const POLL_MS = 7000;
/** Progress is collected every 15 min and served s-maxage=60; no point polling faster. */
const PROGRESS_POLL_MS = 60_000;
const PROGRESS_TIMEOUT_MS = 5_000;

/**
 * Polls the same endpoints the Fleet, Tasks and Progress pages read and derives
 * the scene model (src/lib/gibson-derive.ts). A progress outage is non-fatal:
 * the banner reports it instead of claiming NOMINAL.
 */
export function useGibson(): { model: GibsonSceneModel | null; error: string | null } {
  const [model, setModel] = useState<GibsonSceneModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progressRef = useRef<{ data: ProgressPayload | null; at: number }>({ data: null, at: 0 });

  useEffect(() => {
    let alive = true;
    let inFlight = false;

    async function loadProgress(): Promise<ProgressPayload | null> {
      const cached = progressRef.current;
      if (cached.at && Date.now() - cached.at < PROGRESS_POLL_MS) return cached.data;
      // Bounded: a stuck progress request must never stall the fleet/tasks poll.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PROGRESS_TIMEOUT_MS);
      try {
        const res = await fetch("/api/progress?window=24h", { cache: "no-store", signal: abort.signal });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { alerts?: unknown[] };
        progressRef.current = { data: { alerts: Array.isArray(json.alerts) ? json.alerts : [] }, at: Date.now() };
      } catch {
        progressRef.current = { data: null, at: Date.now() };
      } finally {
        clearTimeout(timer);
      }
      return progressRef.current.data;
    }

    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const [fleetResponse, tasksResponse, progress] = await Promise.all([
          fetch("/api/fleet", { cache: "no-store" }),
          fetch("/api/tasks?status=all&limit=400", { cache: "no-store" }),
          loadProgress(),
        ]);
        if (!fleetResponse.ok) throw new Error(`fleet API ${fleetResponse.status}`);
        if (!tasksResponse.ok) throw new Error(`tasks API ${tasksResponse.status}`);
        const [fleet, tasks] = (await Promise.all([fleetResponse.json(), tasksResponse.json()])) as [
          FleetResponse,
          TasksPayload,
        ];
        if (alive) {
          setModel(aggregate({ fleet, tasks, progress }));
          setError(null);
        }
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : "Failed to load Gibson data");
      } finally {
        inFlight = false;
      }
    }

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  return { model, error };
}
