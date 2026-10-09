"use client";

import { useCallback, useEffect, useState } from "react";
import type { TimeWindow } from "@/lib/progress-config";
import type { ProgressResponse } from "@/lib/progress-types";

/**
 * The collector ticks every 15 minutes, so polling faster than a minute only
 * costs battery. /api/progress is s-maxage=60 for the same reason.
 */
const POLL_MS = 60_000;

export function useProgress(window: TimeWindow): {
  data: ProgressResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(`/api/progress?window=${window}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`progress API ${res.status}`);
        const json = (await res.json()) as ProgressResponse;
        if (!alive) return;
        setData(json);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [window, nonce]);

  return { data, error, loading, refresh };
}
