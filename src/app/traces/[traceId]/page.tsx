"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DemoBanner } from "@/components/ui";
import { buildWaterfall, formatDuration, type SpanRow } from "@/lib/traces";

const KIND_COLOR: Record<string, string> = {
  session: "bg-[#5c6f96]",
  turn: "bg-[#7f9cff]",
  tool: "bg-[#2ee6a6]",
  model: "bg-[#c78bff]",
  other: "bg-[#8f98ab]",
};

export default function TraceDetail({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = use(params);
  const [spans, setSpans] = useState<SpanRow[] | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const res = await fetch(`/api/traces/${traceId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(res.status === 404 ? "Trace not found (it may have been pruned)" : `HTTP ${res.status}`);
        const body = await res.json();
        if (!live) return;
        setSpans(body.spans);
        setDemo(Boolean(body.demo));
        setError(null);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }
    load();
    const t = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [traceId]);

  const wf = useMemo(() => buildWaterfall(spans ?? []), [spans]);
  const chosen = spans?.find((s) => s.span_id === selected) ?? null;
  const errors = spans?.filter((s) => s.status === "error").length ?? 0;

  return (
    <div>
      {demo && <DemoBanner />}
      <div className="mb-4 text-sm">
        <Link href="/traces" className="text-gray-400 hover:text-gray-200">
          ← Traces
        </Link>
      </div>
      {error && <div className="text-sm text-red-400">{error}</div>}
      {!spans && !error && <div className="animate-pulse text-sm text-gray-500">Loading trace…</div>}
      {spans && (
        <>
          <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="text-lg font-semibold">{wf.rows[0]?.span.name ?? "Trace"}</h1>
            <span className="mono text-xs text-gray-500">{traceId}</span>
            <span className="text-xs text-gray-400">
              {spans.length} spans · {formatDuration(wf.totalMs)} · {errors} {errors === 1 ? "error" : "errors"}
            </span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <div role="list" className="min-w-[640px]">
              {wf.rows.map((r) => (
                <button
                  key={r.span.span_id}
                  role="listitem"
                  onClick={() => setSelected(r.span.span_id === selected ? null : r.span.span_id)}
                  className={`grid w-full grid-cols-[minmax(160px,260px)_1fr_72px] items-center gap-3 border-b border-white/5 px-3 py-1.5 text-left text-sm last:border-b-0 hover:bg-white/[0.04] ${
                    selected === r.span.span_id ? "bg-white/[0.06]" : ""
                  }`}
                >
                  <span className="truncate" style={{ paddingLeft: `${Math.min(r.depth, 8) * 14}px` }}>
                    <span className={r.span.status === "error" ? "text-[#ff5c77]" : ""}>{r.span.name}</span>
                  </span>
                  <span className="relative h-3 rounded bg-white/5">
                    <span
                      className={`absolute top-0 h-3 rounded ${r.span.status === "error" ? "bg-[#ff3b5c]" : KIND_COLOR[r.span.kind] ?? KIND_COLOR.other} ${r.open ? "animate-pulse" : ""}`}
                      style={{ left: `${r.offsetPct}%`, width: `${Math.min(r.widthPct, 100 - r.offsetPct)}%` }}
                    />
                  </span>
                  <span className="text-right text-xs tabular-nums text-gray-400">{formatDuration(r.durationMs)}</span>
                </button>
              ))}
            </div>
          </div>
          {chosen && (
            <div className="mt-4 rounded-lg border border-white/10 p-4 text-sm">
              <div className="mb-2 font-medium">{chosen.name}</div>
              <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
                <dt className="text-gray-500">Kind</dt>
                <dd>{chosen.kind}</dd>
                <dt className="text-gray-500">Status</dt>
                <dd>
                  {chosen.status}
                  {chosen.status_message ? `: ${chosen.status_message}` : ""}
                </dd>
                <dt className="text-gray-500">Span id</dt>
                <dd className="mono">{chosen.span_id}</dd>
                <dt className="text-gray-500">Started</dt>
                <dd>{new Date(chosen.started_at).toLocaleString()}</dd>
                {chosen.model && (
                  <>
                    <dt className="text-gray-500">Model</dt>
                    <dd>{chosen.model}</dd>
                  </>
                )}
                {(chosen.input_tokens !== null || chosen.output_tokens !== null) && (
                  <>
                    <dt className="text-gray-500">Tokens</dt>
                    <dd>
                      {chosen.input_tokens ?? 0} in · {chosen.output_tokens ?? 0} out
                    </dd>
                  </>
                )}
                {chosen.cost_usd !== null && (
                  <>
                    <dt className="text-gray-500">Cost</dt>
                    <dd>${chosen.cost_usd.toFixed(4)}</dd>
                  </>
                )}
                {Object.entries(chosen.attributes).filter(([k]) => k !== "agentkontrol.span.kind").map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="truncate text-gray-500">{k}</dt>
                    <dd className="break-words">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
    </div>
  );
}
