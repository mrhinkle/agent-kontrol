"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DemoBanner, TimeAgo } from "@/components/ui";
import { formatDuration, type TraceSummary } from "@/lib/traces";

export default function TracesPage() {
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const res = await fetch(`/api/traces${errorsOnly ? "?errors=1" : ""}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!live) return;
        setTraces(body.traces);
        setDemo(Boolean(body.demo));
        setError(null);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }
    load();
    const t = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [errorsOnly]);

  return (
    <div>
      {demo && <DemoBanner />}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Traces</h1>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          Only traces with errors
        </label>
      </div>
      {error && !traces && <div className="text-sm text-red-400">Failed to load: {error}</div>}
      {!traces && !error && <div className="animate-pulse text-sm text-gray-500">Loading traces…</div>}
      {traces && traces.length === 0 && (
        <div className="rounded-lg border border-white/10 p-6 text-sm text-gray-400">
          No traces yet. Install the Claude Code hook (it emits traces automatically), or point any OpenTelemetry exporter at{" "}
          <span className="mono">/api/v1/traces</span>. See the Help page “Telemetry and traces”.
        </div>
      )}
      {traces && traces.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Trace</th>
                <th className="px-3 py-2 text-right font-medium">Spans</th>
                <th className="px-3 py-2 text-right font-medium">Errors</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => {
                const dur = t.ended_at ? Date.parse(t.ended_at) - Date.parse(t.started_at) : null;
                return (
                  <tr key={t.trace_id} className="border-t border-white/5 hover:bg-white/[0.03]">
                    <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                      <TimeAgo iso={t.started_at} />
                    </td>
                    <td className="px-3 py-2">{t.agent_id}</td>
                    <td className="px-3 py-2">
                      <Link href={`/traces/${t.trace_id}`} className="text-[#9dbcff] hover:underline">
                        {t.root_name}
                      </Link>
                      <span className="mono ml-2 text-[11px] text-gray-600">{t.trace_id.slice(0, 8)}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.span_count}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${t.error_count ? "text-[#ff5c77]" : "text-gray-500"}`}>{t.error_count}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-400">
                      {formatDuration(dur)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
