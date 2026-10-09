"use client";

import { useEffect, useState } from "react";
import type { FleetResponse } from "@/lib/types";

const POLL_MS = 7000;

export function useFleet(): { data: FleetResponse | null; error: string | null } {
  const [data, setData] = useState<FleetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/fleet", { cache: "no-store" });
        if (!res.ok) throw new Error(`fleet API ${res.status}`);
        const json = (await res.json()) as FleetResponse;
        if (alive) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return { data, error };
}
