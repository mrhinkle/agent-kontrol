"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BacklogChart } from "@/components/BacklogChart";
import { useFleet } from "@/components/use-fleet";
import { useProgress } from "@/components/use-progress";
import { STATUS_STYLES, TimeAgo } from "@/components/ui";
import { LANE_BOT_PREFIX, REPOS, WINDOWS, type TimeWindow } from "@/lib/progress-config";
import type { Alert, ProgressResponse, RepoProgress } from "@/lib/progress-types";
import {
  SORTS,
  SYNC_STALE_AFTER_MS,
  backlogSeries,
  formatSpan,
  matchesFilter,
  sortRepos,
  type FilterKey,
  type Freshness,
  type RepoState,
  type SortKey,
} from "@/lib/progress-sort";

/* ------------------------------------------------------------- primitives */

function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-fg/10 bg-panel ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-fg/10 px-4 py-2.5">
        <h2 className="mono text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">{title}</h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Signed number where positive is the bad direction. */
function NetBacklog({ value, className = "" }: { value: number | null; className?: string }) {
  if (value === null) return <span className={`text-gray-500 ${className}`} title="Not measured">—</span>;
  const tone = value > 0 ? "text-error" : value < 0 ? "text-emerald-400" : "text-gray-300";
  return (
    <span className={`tabular-nums ${tone} ${className}`}>
      {value > 0 ? "+" : ""}
      {value}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="mono text-[10px] uppercase tracking-[0.12em] text-gray-500">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums leading-none">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ zone 1: cards */

const FRESHNESS: Record<Freshness, { label: string; chip: string; stripe: string }> = {
  moving: { label: "moving", chip: "bg-success/10 text-success", stripe: "bg-success" },
  cooling: { label: "cooling", chip: "bg-warn/10 text-warn", stripe: "bg-warn" },
  stale: { label: "stale", chip: "bg-error/10 text-error", stripe: "bg-error" },
  idle: { label: "quiet", chip: "bg-fg/5 text-gray-500", stripe: "bg-gray-600" },
  unknown: { label: "no scan", chip: "bg-fg/5 text-gray-500", stripe: "bg-gray-600" },
};

/** Daily backlog line. Rising is drawn in the error color, falling in success. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="h-8" aria-hidden />;
  const w = 120;
  const h = 32;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`);
  const delta = values[values.length - 1] - values[0];
  const tone = delta > 0 ? "stroke-error" : delta < 0 ? "stroke-success" : "stroke-muted-dim";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-[120px]" role="img" aria-label={`Backlog ${delta > 0 ? "up" : delta < 0 ? "down" : "flat"} ${Math.abs(delta)} over ${values.length} days`}>
      <polyline points={pts.join(" ")} fill="none" className={tone} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r={2.25} className={tone.replace("stroke", "fill")} />
    </svg>
  );
}

function RepoCard({ r, state, spark }: { r: RepoProgress; state: RepoState; spark: number[] }) {
  const f = FRESHNESS[state.freshness];
  const blockedPct = r.blocked_ratio === null ? null : Math.round(r.blocked_ratio * 100);
  const stalled = state.oldestStalled;

  return (
    <div className="relative flex flex-col overflow-hidden rounded-xl border border-fg/10 bg-panel shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-fg/20">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${f.stripe}`} aria-hidden />
      <div className="flex flex-1 flex-col p-4 pl-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <a
              href={`https://github.com/${r.repo}`}
              target="_blank"
              rel="noreferrer"
              className="break-words font-semibold tracking-wide hover:text-accent"
            >
              {r.label}
            </a>
            <div className="mt-0.5 break-all text-[11px] text-gray-500">{r.repo}</div>
          </div>
          <span
            className={`mono shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${f.chip}`}
            title={
              state.idleMs === null
                ? "No activity scan recorded for this repository"
                : `No push, PR or issue update for ${formatSpan(state.idleMs)} as of the last activity check`
            }
          >
            {f.label}
            {state.idleMs !== null && state.freshness !== "moving" && ` · ${formatSpan(state.idleMs)}`}
          </span>
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="flex items-end gap-5">
            <div>
              <div className="mono text-[10px] uppercase tracking-[0.12em] text-gray-500">shipped</div>
              <div className="text-[30px] font-semibold tabular-nums leading-none">
                {r.merged_prs ?? "—"} <span className="text-xs font-normal text-gray-500">PRs</span>
              </div>
            </div>
            <div className="pb-0.5">
              <div className="mono text-[10px] uppercase tracking-[0.12em] text-gray-500">net backlog</div>
              <NetBacklog value={r.net_backlog} className="text-lg font-semibold leading-none" />
            </div>
          </div>
          <Sparkline values={spark} />
        </div>

        <dl className="mt-3 space-y-1.5 border-t border-fg/10 pt-3 text-[12px]">
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">closed / opened</dt>
            <dd className="mono tabular-nums text-gray-300">
              {r.issues_closed ?? "—"} / {r.issues_opened ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">open</dt>
            <dd className="mono tabular-nums text-gray-300">
              {r.open_issues ?? "—"} issues · {r.open_prs ?? "—"} PR{r.open_prs === 1 ? "" : "s"}
            </dd>
          </div>
          {(blockedPct !== null || r.blocked_label) && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">blocked</dt>
              <dd className={`mono tabular-nums ${state.overBlocked ? "font-semibold text-error" : "text-gray-300"}`}>
                {blockedPct === null ? "unavailable" : `${blockedPct}%`}
                {state.overBlocked && " ⚠"}
              </dd>
            </div>
          )}
        </dl>

        {stalled && (
          <a
            href={stalled.url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 block rounded border border-warn/25 bg-warn/5 px-2.5 py-1.5 text-[11.5px] leading-snug hover:border-warn/50"
          >
            <span className="mono text-warn">#{stalled.number} idle {formatSpan(stalled.idle_hours * 3600_000)}</span>
            <span className="text-gray-300"> · {stalled.title}</span>
            {r.stalled_prs.length > 1 && <span className="text-gray-500"> (+{r.stalled_prs.length - 1} more)</span>}
          </a>
        )}

        <div className="mt-auto pt-2 text-[10px] text-gray-500">
          Metrics {r.last_collected_at ? <TimeAgo iso={r.last_collected_at} /> : "not collected"}
          {r.metrics_complete === false && " · partial"}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------- zone 0: summary strip */

function SummaryStrip({ data, rows, win }: { data: ProgressResponse; rows: { repo: RepoProgress; state: RepoState }[]; win: TimeWindow }) {
  const t = data.totals;
  const count = (f: Freshness[]) => rows.filter((x) => f.includes(x.state.freshness)).length;
  const oldest = rows
    .flatMap((x) => (x.state.oldestStalled ? [{ pr: x.state.oldestStalled, repo: x.repo }] : []))
    .sort((a, b) => b.pr.idle_hours - a.pr.idle_hours)[0];
  return (
    <div className="grid gap-px overflow-hidden rounded-xl border border-fg/10 bg-fg/10 sm:grid-cols-2 lg:grid-cols-5">
      <div className="bg-panel p-4">
        <Stat label={`shipped · ${win}`} value={t.merged_prs ?? "—"} sub="pull requests merged" />
      </div>
      <div className="bg-panel p-4">
        <Stat label="issues closed" value={t.issues_closed ?? "—"} sub={`${t.issues_opened ?? "—"} opened`} />
      </div>
      <div className="bg-panel p-4">
        <Stat label="net backlog" value={<NetBacklog value={t.net_backlog} />} sub="opened minus closed" />
      </div>
      <div className="bg-panel p-4">
        <Stat
          label="repositories"
          value={
            <span>
              <span className="text-success">{count(["moving"])}</span>
              <span className="text-base font-normal text-gray-500"> moving · </span>
              <span className="text-error">{count(["stale"])}</span>
              <span className="text-base font-normal text-gray-500"> stale</span>
            </span>
          }
          sub={`${count(["cooling"])} cooling · ${count(["idle", "unknown"])} quiet`}
        />
      </div>
      <div className="bg-panel p-4">
        {oldest ? (
          <Stat
            label="longest-waiting PR"
            value={<span className="text-warn">{formatSpan(oldest.pr.idle_hours * 3600_000)}</span>}
            sub={
              <a href={oldest.pr.url} target="_blank" rel="noreferrer" className="hover:text-accent">
                {oldest.repo.short} #{oldest.pr.number} · {oldest.pr.title}
              </a>
            }
          />
        ) : (
          <Stat label="longest-waiting PR" value="—" sub="no stalled PRs flagged" />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- zone 3: breakdown */

function Bar({ label, value, max, color }: { label: string; value: number | null; max: number; color: string }) {
  const pct = max > 0 && value !== null ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="mono w-14 shrink-0 text-[11px] text-gray-500">{label}</span>
      <span className="h-3 flex-1 overflow-hidden rounded-sm bg-fg/5">
        <span className="block h-full rounded-sm" style={{ width: `${Math.max(pct, value !== null && value > 0 ? 2 : 0)}%`, background: color }} />
      </span>
      <span className="mono w-8 shrink-0 text-right text-[12px] tabular-nums text-gray-300">{value ?? "—"}</span>
    </div>
  );
}

function Breakdown({ data }: { data: ProgressResponse }) {
  const t = data.totals;
  const max = Math.max(t.merged_prs ?? 0, t.issues_closed ?? 0, t.issues_opened ?? 0, 1);
  const lanes = Object.entries(t.lane_mix).sort((a, b) => b[1] - a[1]);
  const rounds = data.repos.filter((r) => r.review_rounds !== null);
  const meanRounds = rounds.length
    ? rounds.reduce((a, r) => a + (r.review_rounds ?? 0), 0) / rounds.length
    : null;
  const noVerdict = rounds.length
    ? rounds.reduce((a, r) => a + (r.no_verdict_rate ?? 0), 0) / rounds.length
    : null;

  return (
    <div className="space-y-2.5">
      <Bar label="merged" value={t.merged_prs} max={max} color="var(--color-accent)" />
      <Bar label="closed" value={t.issues_closed} max={max} color="var(--color-success)" />
      <Bar label="opened" value={t.issues_opened} max={max} color="var(--color-error)" />

      <div className="flex items-baseline justify-between gap-2 border-t border-fg/10 pt-3 text-[12px]">
        <span className="text-gray-500">net backlog</span>
        <NetBacklog value={t.net_backlog} className="mono text-base font-semibold" />
      </div>

      <div className="flex justify-between gap-2 text-[12px]">
        <span className="text-gray-500">reviews</span>
        <span className="mono tabular-nums text-gray-300">
          {meanRounds === null ? "—" : `${meanRounds.toFixed(1)} rounds/PR`}
          {noVerdict !== null && ` · ${Math.round(noVerdict * 100)}% no verdict`}
        </span>
      </div>

      <div className="flex justify-between gap-3 text-[12px]">
        <span className="shrink-0 text-gray-500">by lane</span>
        <span className="mono text-right tabular-nums text-gray-300">
          {lanes.length === 0
            ? "—"
            : lanes
                .map(([k, v]) => { const key = k.endsWith("[bot]") ? k.slice(0, -5) : k; return `${key.startsWith(LANE_BOT_PREFIX) ? key.slice(LANE_BOT_PREFIX.length) : key} ${v}`; })
                .join(" · ")}
        </span>
      </div>
      {t.lane_mix.unattributed ? (
        <p className="text-[11px] leading-relaxed text-gray-500">
          {t.lane_mix.unattributed} merged PRs are <span className="text-gray-400">unattributed</span> — that repo
          commits under one vendor-neutral bot, so Grok vs Claude vs Codex isn&apos;t recoverable there yet. Counted, not
          guessed.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------- zone 4: needs you */

function AlertRow({ a }: { a: Alert }) {
  const color = a.level === "bad" ? "text-error" : "text-warn";
  const body = (
    <>
      <span className={`shrink-0 ${color}`}>⚠</span>
      <span className="text-[12.5px] leading-snug text-gray-300 group-hover:text-fg">{a.message}</span>
    </>
  );
  return a.url ? (
    <a href={a.url} target="_blank" rel="noreferrer" className="group flex items-start gap-2">
      {body}
    </a>
  ) : (
    <div className="flex items-start gap-2">{body}</div>
  );
}

function NeedsYou({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) {
    return (
      <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1 text-center">
        <span className="text-emerald-400">✓</span>
        <p className="text-sm text-gray-400">No alerts from the available metrics.</p>
        <p className="text-[11px] text-gray-600">Check coverage above for unmeasured repositories.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-2.5">
      {alerts.map((a) => (
        <li key={a.id}>
          <AlertRow a={a} />
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------- zone 5: fleet */

function FleetStrip({ spend }: { spend: number | null }) {
  const { data } = useFleet();
  const vitals = process.env.NEXT_PUBLIC_HERMES_VITALS_URL;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-fg/10 bg-panel px-4 py-3 text-[12px]">
      <span className="mono text-[10px] uppercase tracking-[0.14em] text-gray-500">fleet</span>

      {data?.agents.length ? (
        data.agents.slice(0, 6).map((a) => {
          const s = STATUS_STYLES[a.derived_status] ?? STATUS_STYLES.offline;
          return (
            <span key={a.id} className="inline-flex items-center gap-1.5 text-gray-400" title={a.derived_status}>
              <span
                className={`h-1.5 w-1.5 rounded-full ${s.dot} ${a.derived_status === "active" ? "pulse-dot" : ""}`}
              />
              <span className="mono">{a.display_name ?? a.id}</span>
            </span>
          );
        })
      ) : (
        <span className="text-gray-600">no agents reporting</span>
      )}

      <span className="ml-auto flex items-center gap-4">
        {spend !== null && (
          <span className="mono tabular-nums text-gray-400">${spend.toFixed(2)} spent</span>
        )}
        {vitals && (
          <a href={vitals} target="_blank" rel="noreferrer" className="mono text-gray-500 hover:text-gray-300">
            hermes vitals ↗
          </a>
        )}
        <Link href="/gibson" className="mono text-accent/80 hover:text-accent">
          the gibson ↗
        </Link>
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- the page */

export default function ProgressPage() {
  const [win, setWin] = useState<TimeWindow>("24h");
  const [chartRepo, setChartRepo] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("attention");
  const [filter, setFilter] = useState<FilterKey>("all");
  const { data, error, loading } = useProgress(win);
  // Re-render each minute so idle times and the sync banner do not freeze.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const rows = useMemo(() => (data ? sortRepos(data.repos, sort, now) : []), [data, sort, now]);
  const shown = rows.filter((x) => matchesFilter(x.state, filter));
  const syncAge = data?.last_sync ? now - Date.parse(data.last_sync) : null;
  const syncStale = Boolean(data && !data.demo && (syncAge === null || syncAge > SYNC_STALE_AFTER_MS));
  const visibleChartRepo = data?.repos.some((repo) => repo.repo === chartRepo) ? chartRepo : null;

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h1 className="text-xl font-semibold tracking-wide">Progress</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Open PRs or activity in the past 24 hours, across all watched repositories.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="mono text-[11px] text-gray-500">
            {error ? (
              <span className="text-red-400">error: {error}</span>
            ) : data?.last_sync ? (
              <>
                last sync <TimeAgo iso={data.last_sync} />
              </>
            ) : loading ? (
              "loading…"
            ) : (
              "never collected"
            )}
          </span>
          <div className="flex overflow-hidden rounded-lg border border-fg/10">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWin(w)}
                className={`mono px-2.5 py-1 text-[11px] transition-colors ${
                  w === win ? "bg-accent/15 font-semibold text-accent" : "text-gray-400 hover:bg-fg/5"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>

      {syncStale && (
        <div role="alert" className="rounded-lg border border-error/40 bg-error/10 px-4 py-3 text-[13px] text-gray-200">
          <p className="font-semibold text-error">
            {data?.last_sync ? (
              <>
                The collector last reported <TimeAgo iso={data.last_sync} />. Every number below is frozen at that point.
              </>
            ) : (
              "The collector has never reported."
            )}
          </p>
          <p className="mt-1 text-gray-400">
            Merges, closes and activity since then are not counted, so shipped work will read as zero. Check the
            collector host&apos;s <span className="mono">mc-progress-collector.log</span>; an expired{" "}
            <span className="mono">gh</span> login is the usual cause.
          </p>
        </div>
      )}

      {data?.demo && (
        <div className="rounded-lg border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm text-accent">
          Demo mode — no database connected. These are synthetic numbers, held still. Set{" "}
          <span className="mono">DATABASE_URL</span> and run <span className="mono">scripts/collect-progress.sh</span> to
          go live.
        </div>
      )}

      {data && !data.demo && !data.window_complete && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2.5 text-[12.5px] text-warn">
          Totals are partial: some metrics are missing, more than two hours old, or don&apos;t cover the full {win}.
          Unmeasured values appear as —. Each card shows when its metrics were collected.
        </div>
      )}

      {data?.coverage && (
        <div className="rounded-lg border border-fg/10 bg-panel px-4 py-3 text-[12px] text-gray-400">
          <p><span className="font-semibold text-gray-200">{data.coverage.shown_repos} repositories shown</span> · {data.coverage.checked_repos} of {data.coverage.eligible_repos} checked in the past 2 hours · {data.coverage.tracked_repos} retained</p>
          <p className="mt-1">Activity includes pushes and PR or issue updates. The chart&apos;s time window changes metrics, not which repositories appear. Explicit pins stay visible.</p>
          {data.coverage.discovery_errors.length > 0 && <p className="mt-2 text-amber-300">Repository discovery unavailable for {data.coverage.discovery_errors.join(", ")}; coverage may be incomplete.</p>}
          {data.coverage.incomplete.length > 0 && (
            <details className="mt-2 text-amber-300">
              <summary className="cursor-pointer">{data.coverage.incomplete.length} repositories need a fresh activity scan; additional active repos may be missing</summary>
              <ul className="mt-2 space-y-1">
                {data.coverage.incomplete.map((repo) => <li key={repo.repo}>{repo.repo} — {repo.status === "legacy" ? "awaiting activity scan" : repo.status}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* zone 0 */}
      {data && <SummaryStrip data={data} rows={rows} win={win} />}

      {/* zone 1 */}
      {data && data.repos.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex overflow-hidden rounded-lg border border-fg/10 bg-panel" role="group" aria-label="Filter repositories">
            {(
              [
                { key: "all", label: `All ${rows.length}` },
                { key: "moving", label: `Moving ${rows.filter((x) => matchesFilter(x.state, "moving")).length}` },
                { key: "stale", label: `Going stale ${rows.filter((x) => matchesFilter(x.state, "stale")).length}` },
              ] as { key: FilterKey; label: string }[]
            ).map((o) => (
              <button
                key={o.key}
                onClick={() => setFilter(o.key)}
                aria-pressed={filter === o.key}
                className={`px-3 py-1 text-[12px] transition-colors ${
                  filter === o.key ? "bg-accent/10 font-semibold text-accent" : "text-gray-500 hover:bg-fg/5 hover:text-fg"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[12px] text-gray-500">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-fg/10 bg-panel px-2 py-1 text-[12px] text-fg"
            >
              {SORTS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data
          ? shown.map(({ repo, state }) => (
              <RepoCard key={repo.repo} r={repo} state={state} spark={backlogSeries(data.history, repo.repo)} />
            ))
          : REPOS.map((r) => (
              <div key={r.repo} className="h-[196px] animate-pulse rounded-xl border border-fg/10 bg-panel" />
            ))}
      </div>
      {data && data.repos.length === 0 && <p className="text-sm text-gray-400">No qualifying repositories in the available observations.</p>}
      {data && data.repos.length > 0 && shown.length === 0 && (
        <p className="text-sm text-gray-400">Nothing in this filter right now.</p>
      )}

      {/* zone 2 */}
      <Panel
        title="backlog over time"
        right={
          <div className="flex flex-wrap justify-end gap-1">
            {[{ repo: null, label: "all" }, ...(data?.repos ?? []).map((r) => ({ repo: r.repo, label: r.short }))].map((o) => (
              <button
                key={o.label}
                onClick={() => setChartRepo(o.repo)}
                className={`mono rounded px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                  visibleChartRepo === o.repo ? "bg-fg/10 text-fg" : "text-gray-500 hover:text-gray-300"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        }
      >
        <BacklogChart
          history={data?.history ?? []}
          repo={visibleChartRepo}
          emptyHint={
            data && !data.demo
              ? "The collector needs two daily snapshots before this can draw a line. Check back tomorrow."
              : undefined
          }
        />
      </Panel>

      {/* zones 3 + 4 */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={`last ${win}`}>
          {data ? (
            <Breakdown data={data} />
          ) : (
            <div className="h-[160px] animate-pulse rounded bg-fg/5" />
          )}
        </Panel>
        <Panel
          title="needs you"
          right={
            data && data.alerts.length > 0 ? (
              <span className="mono text-[11px] text-error">{data.alerts.length}</span>
            ) : null
          }
        >
          {data ? <NeedsYou alerts={data.alerts} /> : <div className="h-[160px] animate-pulse rounded bg-fg/5" />}
        </Panel>
      </div>

      {/* zone 5 */}
      <FleetStrip spend={data?.totals.spend_usd ?? null} />

      <p className="pt-1 text-[11px] leading-relaxed text-gray-600">
        <span className="text-gray-500">net backlog</span> is issues opened minus issues closed in the window — positive
        means the queue grew. It is the headline here because merge counts alone can report a triumph on a day every
        backlog got deeper.
      </p>
    </div>
  );
}
