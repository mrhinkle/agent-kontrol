"use client";

import Link from "next/link";
import { useState } from "react";
import { BacklogChart } from "@/components/BacklogChart";
import { useFleet } from "@/components/use-fleet";
import { useProgress } from "@/components/use-progress";
import { STATUS_STYLES, TimeAgo } from "@/components/ui";
import { LANE_BOT_PREFIX, REPOS, THRESHOLDS, WINDOWS, type TimeWindow } from "@/lib/progress-config";
import type { Alert, ProgressResponse, RepoProgress } from "@/lib/progress-types";

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
    <section className={`rounded-xl border border-white/10 bg-[#101828] ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
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
  const tone = value > 0 ? "text-[#ff7a40]" : value < 0 ? "text-emerald-400" : "text-gray-300";
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

function repoTone(r: RepoProgress): { stripe: string; note: string | null } {
  if (r.metrics_complete === false) return { stripe: "bg-gray-600", note: "partial metrics" };
  if (r.blocked_ratio !== null && r.blocked_ratio > THRESHOLDS.blockedRatio) {
    return { stripe: "bg-[#f44800]", note: "over blocked threshold" };
  }
  if (r.net_backlog !== null && r.net_backlog > 0) return { stripe: "bg-[#ff9a3c]", note: "backlog grew" };
  if (r.merged_prs === 0 && r.open_prs !== null && r.open_prs > 0) return { stripe: "bg-[#2563eb]", note: "nothing merged" };
  return { stripe: "bg-emerald-500", note: null };
}

function RepoCard({ r }: { r: RepoProgress }) {
  const tone = repoTone(r);
  const blockedPct = r.blocked_ratio === null ? null : Math.round(r.blocked_ratio * 100);
  const overBlocked = r.blocked_ratio !== null && r.blocked_ratio > THRESHOLDS.blockedRatio;

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#101828] transition-colors hover:border-white/20">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${tone.stripe}`} aria-hidden />
      <div className="p-4 pl-5">
        <div className="flex items-baseline justify-between gap-2">
          <a
            href={`https://github.com/${r.repo}`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 break-words font-semibold tracking-wide hover:text-white"
          >
            {r.label}
          </a>
          {tone.note && <span className="mono text-[10px] uppercase tracking-wider text-gray-500">{tone.note}</span>}
        </div>
        <div className="mt-1 break-all text-[11px] text-gray-400">{r.repo}</div>
        {r.activity && (
          <div className="mt-1 text-[11px] text-gray-400">
            {r.activity.reasons.map((reason) => reason === "open_prs" ? "Open PRs" : reason === "recent_activity" ? "Active in past 24h" : "Pinned").join(" · ")}
            {r.activity.status !== "fresh" && <span className="text-amber-300"> · {r.activity.status === "legacy" ? "Awaiting activity scan" : `Activity ${r.activity.status}`}</span>}
          </div>
        )}

        <div className="mt-3 flex items-end gap-5">
          <div>
            <div className="mono text-[10px] uppercase tracking-[0.12em] text-gray-500">net backlog</div>
            <NetBacklog value={r.net_backlog} className="text-[34px] font-semibold leading-none" />
          </div>
          <div className="pb-1">
            <div className="mono text-[10px] uppercase tracking-[0.12em] text-gray-500">shipped</div>
            <div className="text-lg font-semibold tabular-nums leading-none text-gray-200">
              {r.merged_prs ?? "—"} <span className="text-xs font-normal text-gray-500">PRs</span>
            </div>
          </div>
        </div>

        <dl className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-[12px]">
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">closed / opened</dt>
            <dd className="mono tabular-nums text-gray-300">
              {r.issues_closed ?? "—"} / {r.issues_opened ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">queue</dt>
            <dd className="mono tabular-nums text-gray-300">
              {r.open_issues ?? "—"} issues · {r.open_prs ?? "—"} PR{r.open_prs === 1 ? "" : "s"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">blocked</dt>
            <dd
              className={`mono tabular-nums ${
                overBlocked ? "font-semibold text-[#ff7a40]" : blockedPct === null ? "text-gray-600" : "text-gray-300"
              }`}
              title={blockedPct === null ? "Blocked work has not been measured or has no configured label" : undefined}
            >
              {blockedPct === null ? (r.blocked_label ? "unavailable" : "not tracked") : `${blockedPct}%`}
              {overBlocked && " ⚠"}
            </dd>
          </div>
        </dl>
        <div className="mt-2 text-[10px] text-gray-500">
          Metrics {r.last_collected_at ? <TimeAgo iso={r.last_collected_at} /> : "not collected"}
        </div>
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
      <span className="h-3 flex-1 overflow-hidden rounded-sm bg-white/5">
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
      <Bar label="merged" value={t.merged_prs} max={max} color="#2563eb" />
      <Bar label="closed" value={t.issues_closed} max={max} color="#34d399" />
      <Bar label="opened" value={t.issues_opened} max={max} color="#f44800" />

      <div className="flex items-baseline justify-between gap-2 border-t border-white/10 pt-3 text-[12px]">
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
  const color = a.level === "bad" ? "text-[#ff7a40]" : "text-[#f0b429]";
  const body = (
    <>
      <span className={`shrink-0 ${color}`}>⚠</span>
      <span className="text-[12.5px] leading-snug text-gray-300 group-hover:text-white">{a.message}</span>
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
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-white/10 bg-[#101828] px-4 py-3 text-[12px]">
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
        <Link href="/gibson" className="mono text-[#19d2ff]/80 hover:text-[#19d2ff]">
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
  const { data, error, loading } = useProgress(win);
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
          <div className="flex overflow-hidden rounded-lg border border-white/10">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWin(w)}
                className={`mono px-2.5 py-1 text-[11px] transition-colors ${
                  w === win ? "bg-[#f44800] font-semibold text-white" : "text-gray-400 hover:bg-white/5"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data?.demo && (
        <div className="rounded-lg border border-[#2563eb]/30 bg-[#2563eb]/10 px-4 py-2.5 text-sm text-[#9db9ff]">
          Demo mode — no database connected. These are synthetic numbers, held still. Set{" "}
          <span className="mono">DATABASE_URL</span> and run <span className="mono">scripts/collect-progress.sh</span> to
          go live.
        </div>
      )}

      {data && !data.demo && !data.window_complete && (
        <div className="rounded-lg border border-[#f0b429]/30 bg-[#f0b429]/10 px-4 py-2.5 text-[12.5px] text-[#f0d08a]">
          Totals are partial: some metrics are missing, more than two hours old, or don&apos;t cover the full {win}.
          Unmeasured values appear as —. Each card shows when its metrics were collected.
        </div>
      )}

      {data?.coverage && (
        <div className="rounded-lg border border-white/10 bg-[#101828] px-4 py-3 text-[12px] text-gray-400">
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

      {/* zone 1 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data
          ? data.repos.map((r) => <RepoCard key={r.repo} r={r} />)
          : REPOS.map((r) => (
              <div key={r.repo} className="h-[196px] animate-pulse rounded-xl border border-white/10 bg-[#101828]" />
            ))}
      </div>
      {data && data.repos.length === 0 && <p className="text-sm text-gray-400">No qualifying repositories in the available observations.</p>}

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
                  visibleChartRepo === o.repo ? "bg-white/10 text-white" : "text-gray-500 hover:text-gray-300"
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
            <div className="h-[160px] animate-pulse rounded bg-white/5" />
          )}
        </Panel>
        <Panel
          title="needs you"
          right={
            data && data.alerts.length > 0 ? (
              <span className="mono text-[11px] text-[#ff7a40]">{data.alerts.length}</span>
            ) : null
          }
        >
          {data ? <NeedsYou alerts={data.alerts} /> : <div className="h-[160px] animate-pulse rounded bg-white/5" />}
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
