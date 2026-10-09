"use client";

import { useMemo, useRef, useState } from "react";
import type { HistoryPoint } from "@/lib/progress-types";

/**
 * Cumulative issues created vs closed. The gap between the two lines is the
 * backlog — progress is the lines converging, and that reads at a glance in a
 * way a burn-down never could here, because scope isn't fixed: it's discovered
 * daily.
 */

const W = 720;
const H = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 46 };

interface Series {
  date: string;
  created: number;
  closed: number;
}

function collapse(history: HistoryPoint[], repo: string | null): Series[] {
  const byDate = new Map<string, { created: number; closed: number }>();
  for (const p of history) {
    if (repo && p.repo !== repo) continue;
    const cur = byDate.get(p.date) ?? { created: 0, closed: 0 };
    cur.created += p.total_issues_created;
    cur.closed += p.total_issues_closed;
    byDate.set(p.date, cur);
  }
  return [...byDate.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function niceTicks(min: number, max: number, count = 3): number[] {
  if (max <= min) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max; v += step) out.push(v);
  return out;
}

export function BacklogChart({
  history,
  repo,
  emptyHint,
}: {
  history: HistoryPoint[];
  repo: string | null;
  emptyHint?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const series = useMemo(() => collapse(history, repo), [history, repo]);

  const geom = useMemo(() => {
    if (series.length < 2) return null;
    const values = series.flatMap((s) => [s.created, s.closed]);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    // Pad the range so neither line sits on an axis.
    const span = Math.max(hi - lo, 1);
    const yMin = Math.max(0, lo - span * 0.12);
    const yMax = hi + span * 0.12;

    const x = (i: number) =>
      PAD.left + (i / (series.length - 1)) * (W - PAD.left - PAD.right);
    const y = (v: number) =>
      PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

    const line = (key: "created" | "closed") =>
      series.map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");

    const area =
      series.map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(s.created).toFixed(1)}`).join(" ") +
      " " +
      series
        .map((s, i) => `L${x(series.length - 1 - i).toFixed(1)},${y(series[series.length - 1 - i].closed).toFixed(1)}`)
        .join(" ") +
      " Z";

    return { x, y, yMin, yMax, line, area, ticks: niceTicks(yMin, yMax) };
  }, [series]);

  if (!geom) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg border border-dashed border-white/10 px-6 text-center text-sm text-gray-500">
        {emptyHint ?? "Not enough history yet — the graph fills in as the collector runs."}
      </div>
    );
  }

  const idx = hover ?? series.length - 1;
  const point = series[idx];
  const backlog = point.created - point.closed;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = (px - PAD.left) / (W - PAD.left - PAD.right);
    const i = Math.round(t * (series.length - 1));
    setHover(Math.min(series.length - 1, Math.max(0, i)));
  }

  // De-duplicated: with only two or three points these collapse onto the same
  // index, and rendering them as separate keyed nodes collides.
  const labelIdx = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="mono text-gray-500">{point.date}</span>
        <span className="mono text-gray-400">
          backlog <span className="font-semibold text-white tabular-nums">{backlog.toLocaleString()}</span>
        </span>
        <span className="mono text-gray-600">
          {point.created.toLocaleString()} created · {point.closed.toLocaleString()} closed
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Cumulative issues created versus closed over time. The gap between the lines is the open backlog."
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {geom.ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={geom.y(t)}
              y2={geom.y(t)}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={geom.y(t) + 3.5}
              textAnchor="end"
              className="mono"
              fontSize={10}
              fill="#6b7280"
            >
              {t >= 1000 ? `${(t / 1000).toFixed(1)}k` : Math.round(t)}
            </text>
          </g>
        ))}

        {/* the gap is the backlog */}
        <path d={geom.area} fill="#f44800" fillOpacity={0.12} />
        <path d={geom.line("created")} fill="none" stroke="#f44800" strokeWidth={1.75} />
        <path d={geom.line("closed")} fill="none" stroke="#34d399" strokeWidth={1.75} />

        <line
          x1={geom.x(idx)}
          x2={geom.x(idx)}
          y1={PAD.top}
          y2={H - PAD.bottom}
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <circle cx={geom.x(idx)} cy={geom.y(point.created)} r={3} fill="#f44800" />
        <circle cx={geom.x(idx)} cy={geom.y(point.closed)} r={3} fill="#34d399" />

        {labelIdx.map((i, n) => (
          <text
            key={i}
            x={geom.x(i)}
            y={H - 8}
            textAnchor={n === 0 ? "start" : n === labelIdx.length - 1 ? "end" : "middle"}
            className="mono"
            fontSize={10}
            fill="#6b7280"
          >
            {series[i].date.slice(5)}
          </text>
        ))}
      </svg>

      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-gray-500 mono">
        <span className="inline-flex items-center gap-1.5">
          <i className="h-0.5 w-3 rounded-full bg-[#f44800]" /> created (cumulative)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="h-0.5 w-3 rounded-full bg-[#34d399]" /> closed (cumulative)
        </span>
        <span className="text-gray-600">the gap is the backlog — converging is progress</span>
      </div>
    </div>
  );
}
