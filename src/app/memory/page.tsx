"use client";

import { useEffect, useState } from "react";
import { DemoBanner, TimeAgo } from "@/components/ui";
import type { MemoryItem } from "@/lib/types";

export default function MemoryPage() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [demo, setDemo] = useState(false);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/memory?query=${encodeURIComponent(query)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const json = await res.json();
        if (controller.signal.aborted) return; // stale response — ignore
        setItems(json.items ?? []);
        setDemo(Boolean(json.demo));
        setLoaded(true);
      } catch {
        // aborted or network error — keep current results
      }
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query]);

  return (
    <div>
      {demo && <DemoBanner />}
      <div className="flex items-center gap-4 mb-5">
        <h1 className="text-lg font-semibold">Shared memory</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes…"
          className="bg-[#101828] border border-white/10 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-[#2563eb] w-64"
        />
      </div>

      <div className="grid gap-3">
        {items.map((m) => (
          <div key={m.id} className="rounded-xl border border-white/10 bg-[#101828] p-4">
            <div className="flex items-center gap-3 text-xs text-gray-500 mb-1.5 flex-wrap">
              {m.key && <span className="mono text-[#7aa5ff]">{m.key}</span>}
              {m.tags.map((t) => (
                <span key={t} className="rounded-full bg-white/5 px-2 py-0.5 mono">
                  #{t}
                </span>
              ))}
              <span className="ml-auto">
                {m.agent_id ?? "unknown"} · <TimeAgo iso={m.updated_at} />
              </span>
            </div>
            <div className="text-sm text-gray-300 whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
        {loaded && items.length === 0 && (
          <div className="text-gray-600 text-sm">
            Nothing here yet. Agents write notes with the <span className="mono">remember</span> MCP tool.
          </div>
        )}
      </div>
    </div>
  );
}
