import Link from "next/link";
import type { RunMetrics } from "@/lib/run-store";
import { DemoBanner } from "./ui";

const number = (n: number | null) => n === null ? "Unavailable" : n.toLocaleString("en-US");
const duration = (ms: number | null) => ms === null ? "Unavailable" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;

export function RunDashboard({ metrics }: { metrics: RunMetrics | null }) {
  if (!metrics) return <p role="status" className="rounded-xl border border-amber-400/20 bg-[#101828] p-5 text-sm text-amber-200">Run metrics are unavailable. Refresh to try again.</p>;
  const { totals, runs, models } = metrics;
  return (
    <section className="space-y-4" aria-labelledby="run-metrics">
      {metrics.demo ? <DemoBanner /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="run-metrics" className="text-lg font-medium text-white">Run observability</h2>
          <p className="mt-1 text-xs text-gray-400">Completed dispatcher invocations in the last 24 hours.</p>
        </div>
        <form action="/observability"><button type="submit" className="rounded-md border border-white/20 px-3 py-2 text-sm text-gray-200 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]">Refresh</button></form>
      </div>
      {metrics.truncated ? <p role="status" className="text-sm text-amber-200">Showing the most recent 1,000 stored records. These metrics cover that sample.</p> : null}
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Completed runs", number(totals.completed_runs)],
          ["Run duration · p50", duration(totals.p50_duration_ms)],
          ["Run duration · p95", duration(totals.p95_duration_ms)],
          ["Failed runs", number(totals.failed_runs)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/10 bg-[#101828] p-4"><dt className="text-xs text-gray-400">{label}</dt><dd className="mt-2 text-xl font-semibold text-white">{value}</dd></div>
        ))}
      </dl>
      <p className="text-xs leading-relaxed text-gray-400">Run duration measures the CLI process, including startup and tool work. Individual model-request latency is unavailable in this feed. Complete token reports: {totals.complete_usage_runs} of {totals.completed_runs} runs; {totals.runs_with_usage} have at least some usage data.</p>
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-[#101828]">
        <table className="w-full text-left text-sm">
          <caption className="px-4 py-3 text-left font-medium text-gray-200">Reported model usage · dispatcher runs</caption>
          <thead className="border-y border-white/10 text-xs text-gray-400"><tr><th scope="col" className="px-4 py-3">Model</th><th scope="col" className="px-4 py-3">Runs</th><th scope="col" className="px-4 py-3">Input tokens</th><th scope="col" className="px-4 py-3">Output tokens</th></tr></thead>
          <tbody className="divide-y divide-white/5 text-gray-300">
            {models.map((m) => <tr key={m.model}><th scope="row" className="px-4 py-3 font-normal">{m.model}</th><td className="px-4 py-3">{m.runs}</td><td className="px-4 py-3">{number(m.input_tokens)}</td><td className="px-4 py-3">{number(m.output_tokens)}</td></tr>)}
            {!models.length ? <tr><td colSpan={4} className="px-4 py-5 text-gray-400">No per-run model usage reported yet. Missing counts remain unavailable.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-[#101828]">
        <table className="w-full text-left text-sm">
          <caption className="px-4 py-3 text-left font-medium text-gray-200">Recent completed invocations</caption>
          <thead className="border-y border-white/10 text-xs text-gray-400"><tr><th scope="col" className="px-4 py-3">Platform</th><th scope="col" className="px-4 py-3">Role</th><th scope="col" className="px-4 py-3">Outcome</th><th scope="col" className="px-4 py-3">Duration</th><th scope="col" className="px-4 py-3">Usage</th></tr></thead>
          <tbody className="divide-y divide-white/5 text-gray-300">
            {runs.slice(0, 30).map(({ event_id, run, platform }) => <tr key={event_id}><th scope="row" className="px-4 py-3 font-normal">{platform}</th><td className="px-4 py-3">{run.role}</td><td className={`px-4 py-3 ${run.outcome === "completed" ? "text-emerald-300" : "text-red-300"}`}>{run.outcome}{run.error_class ? <span className="mt-1 block text-xs text-gray-400">{run.error_class.replaceAll("_", " ")}</span> : null}</td><td className="whitespace-nowrap px-4 py-3">{duration(run.duration_ms)}</td><td className="px-4 py-3">{run.usage_complete ? "Complete" : run.model_usage.length ? "Partial" : "Unavailable"}</td></tr>)}
            {!runs.length ? <tr><td colSpan={5} className="px-4 py-5 text-gray-400">No completed dispatcher invocations recorded in this window. The updated dispatcher must be activated before it reports runs.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-gray-400">Reported input includes available cached input; cache counters are breakdowns. Partial reports can undercount usage. Resumed-session totals are excluded from run usage. Hermes session snapshots and their cumulative model ledger are separate: <Link href="/usage" className="text-[#19d2ff] hover:underline">open Usage and Costs</Link>.</p>
    </section>
  );
}
