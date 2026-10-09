"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DEFAULT_USAGE_WINDOW,
  USAGE_WINDOWS,
  type UsageTimeWindow,
} from "@/lib/usage-window";
import type { UsageSummary } from "@/lib/usage-types";

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
        <h2 className="mono text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
          {title}
        </h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = "text-gray-100",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: string;
}) {
  return (
    <div>
      <div className="mono text-[10px] uppercase tracking-[0.12em] text-gray-500">{label}</div>
      <div className={`mt-0.5 text-2xl font-semibold tabular-nums leading-none ${tone}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

function usd(n: number, digits = 2): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default function UsagePage() {
  const [win, setWin] = useState<UsageTimeWindow>(DEFAULT_USAGE_WINDOW);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({ window: win });
        const res = await fetch(`/api/usage?${q}`, { cache: "no-store" });
        if (!res.ok) throw new Error(await res.text());
        const json = (await res.json()) as UsageSummary;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) {
          setData(null);
          setError((e as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [win]);

  const setupRequired = Boolean(data?.setup_required);
  const empty =
    Boolean(data) &&
    !data!.demo &&
    !setupRequired &&
    (data!.fleet?.rows ?? 0) === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-wide">Usage and Costs</h1>
          <p className="mt-1 text-sm text-gray-500">
            Paid (card/credits) vs shadow (Codex list-price). Agents push; this page never opens Hermes DBs.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="mono text-[11px] text-gray-500">
            {data?.window && (
              <>
                {data.window.since.slice(0, 10)} → {data.window.until.slice(0, 10)} UTC
              </>
            )}
            {data?.collected_at && (
              <span className="ml-3">collected {new Date(data.collected_at).toLocaleString()}</span>
            )}
          </span>
          <div className="flex overflow-hidden rounded-lg border border-white/10">
            {USAGE_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
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
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <span className="font-semibold">Demo data</span> — <span className="mono">DATABASE_URL</span> is unset.
          Showing synthetic Usage and Costs fixtures, not production Neon. Production never serves this path when the
          database is configured.
        </div>
      )}

      {loading && <div className="text-sm text-gray-500">Loading usage ledger…</div>}
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {setupRequired && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-6 text-sm text-amber-50">
          <p className="text-base font-semibold text-amber-100">Usage and Costs isn&apos;t set up yet</p>
          <p className="mt-2 text-amber-100/90">
            Run <span className="mono">supabase/schema.sql</span> on production Neon, then install the collector on the
            Mini (<span className="mono">agents/usage-collector/install.sh</span>).
          </p>
          <p className="mt-3 mono text-[11px] text-amber-200/70">
            {data?.setup_message ??
              "Usage and Costs isn't set up yet: run supabase/schema.sql, then install the collector"}
          </p>
        </div>
      )}

      {empty && (
        <div className="rounded-xl border border-white/10 bg-[#101828] px-5 py-8 text-center text-sm text-gray-400">
          <p className="text-base font-medium text-gray-200">No usage collected yet</p>
          <p className="mt-2 max-w-lg mx-auto">
            Tables are ready. Install the usage collector on the machine that runs Hermes so its sessions start landing in this window.
          </p>
        </div>
      )}

      {data && !setupRequired && !empty && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#101828] p-4">
              <span className="absolute inset-y-0 left-0 w-[3px] bg-[#f44800]" aria-hidden />
              <Stat
                label="Agent-attributed paid"
                value={usd(data.fleet.paid_cost_usd)}
                sub="Hermes-attributed card/credits (excludes provider_api rows)"
                tone="text-[#ff9a3c]"
              />
            </div>
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#101828] p-4">
              <span className="absolute inset-y-0 left-0 w-[3px] bg-[#2563eb]" aria-hidden />
              <Stat
                label="Codex shadow (not charged)"
                value={usd(data.fleet.shadow_cost_usd)}
                sub="Included tokens at list prices — not a card charge"
                tone="text-sky-300"
              />
            </div>
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#101828] p-4">
              <span className="absolute inset-y-0 left-0 w-[3px] bg-emerald-500" aria-hidden />
              <Stat
                label="Cache hit rate"
                value={pct(data.fleet.cache_hit_rate)}
                sub={`${data.fleet.cache_read_tokens.toLocaleString()} cache-read / ${(data.fleet.input_tokens + data.fleet.cache_read_tokens).toLocaleString()} total in`}
              />
            </div>
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#101828] p-4">
              <span className="absolute inset-y-0 left-0 w-[3px] bg-violet-500" aria-hidden />
              <Stat
                label="Subscription fees"
                value={usd(data.fleet.subscription_fees_usd)}
                sub="Phase 2 calendar recognition — placeholders now"
              />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="By profile">
              <table className="w-full text-sm">
                <thead>
                  <tr className="mono text-[10px] uppercase tracking-wider text-gray-500">
                    <th className="pb-2 text-left font-medium">Profile</th>
                    <th className="pb-2 text-right font-medium">Paid</th>
                    <th className="pb-2 text-right font-medium">Shadow</th>
                    <th className="pb-2 text-right font-medium">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_profile.slice(0, 12).map((b) => (
                    <tr key={b.key} className="border-t border-white/5">
                      <td className="py-1.5 font-medium">{b.label}</td>
                      <td className="py-1.5 text-right tabular-nums text-[#ff9a3c]">{usd(b.paid_cost_usd)}</td>
                      <td className="py-1.5 text-right tabular-nums text-sky-300">{usd(b.shadow_cost_usd)}</td>
                      <td className="py-1.5 text-right tabular-nums text-gray-500">{b.rows}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel title="By model">
              <table className="w-full text-sm">
                <thead>
                  <tr className="mono text-[10px] uppercase tracking-wider text-gray-500">
                    <th className="pb-2 text-left font-medium">Model</th>
                    <th className="pb-2 text-right font-medium">Paid</th>
                    <th className="pb-2 text-right font-medium">Shadow</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_model.slice(0, 12).map((b) => (
                    <tr key={b.key} className="border-t border-white/5">
                      <td className="py-1.5 mono text-[12px]">{b.label}</td>
                      <td className="py-1.5 text-right tabular-nums text-[#ff9a3c]">{usd(b.paid_cost_usd)}</td>
                      <td className="py-1.5 text-right tabular-nums text-sky-300">{usd(b.shadow_cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="By cron job"
              right={<span className="mono text-[10px] text-gray-600">name from jobs.json</span>}
            >
              {data.by_cron.length === 0 ? (
                <p className="text-sm text-gray-500">No cron-tagged sessions in this window.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="mono text-[10px] uppercase tracking-wider text-gray-500">
                      <th className="pb-2 text-left font-medium">Job</th>
                      <th className="pb-2 text-right font-medium">Paid</th>
                      <th className="pb-2 text-right font-medium">Shadow</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_cron.slice(0, 10).map((b) => (
                      <tr key={b.key} className="border-t border-white/5">
                        <td className="py-1.5 mono text-[12px]">{b.label}</td>
                        <td className="py-1.5 text-right tabular-nums">{usd(b.paid_cost_usd)}</td>
                        <td className="py-1.5 text-right tabular-nums">{usd(b.shadow_cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title="OpenRouter account">
              <div className="space-y-3 text-sm">
                <Stat
                  label="Activity paid (provider_api)"
                  value={
                    data.openrouter?.activity_paid_usd != null
                      ? usd(data.openrouter.activity_paid_usd)
                      : "—"
                  }
                />
                <Stat
                  label="Credits remaining"
                  value={
                    data.openrouter?.credits_remaining != null
                      ? usd(data.openrouter.credits_remaining)
                      : "—"
                  }
                />
                <Stat
                  label="Reconcile Δ vs Hermes OR rows"
                  value={
                    data.openrouter?.reconcile_delta_pct != null
                      ? `${data.openrouter.reconcile_delta_pct.toFixed(2)}%`
                      : "—"
                  }
                  sub={data.openrouter?.note}
                />
              </div>
            </Panel>
          </div>

          <Panel title="Top sessions">
            <table className="w-full text-sm">
              <thead>
                <tr className="mono text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="pb-2 text-left font-medium">Profile</th>
                  <th className="pb-2 text-left font-medium">Session</th>
                  <th className="pb-2 text-left font-medium">Model</th>
                  <th className="pb-2 text-right font-medium">Paid</th>
                  <th className="pb-2 text-right font-medium">Shadow</th>
                </tr>
              </thead>
              <tbody>
                {data.top_sessions.map((s) => (
                  <tr key={`${s.profile}-${s.session_id}-${s.model}`} className="border-t border-white/5">
                    <td className="py-1.5">{s.profile}</td>
                    <td className="py-1.5 mono text-[11px] text-gray-400">
                      {s.session_id.slice(0, 22)}
                      {s.cron_job_name ? (
                        <span className="ml-2 text-violet-300">{s.cron_job_name}</span>
                      ) : s.cron_job_id ? (
                        <span className="ml-2 text-violet-300">cron:{s.cron_job_id.slice(0, 8)}</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 mono text-[11px]">{s.model}</td>
                    <td className="py-1.5 text-right tabular-nums text-[#ff9a3c]">{usd(s.paid_cost_usd)}</td>
                    <td className="py-1.5 text-right tabular-nums text-sky-300">{usd(s.shadow_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <p className="text-xs text-gray-600">
            Shadow cost is <em>not</em> charged to a card — it is the list-price value of Codex included tokens. See{" "}
            <Link href="https://github.com/mrhinkle/mission-control-ops/issues/12" className="underline">
              issue #12
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
