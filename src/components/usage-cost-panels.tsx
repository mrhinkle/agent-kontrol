import React from "react";
import type { UsageSummary } from "@/lib/usage-types";

const dollars = (value: number | null) => value === null ? "Not available" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const timestamp = (value: string | null) => !value ? "Never collected" : Number.isFinite(Date.parse(value))
  ? `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC` : "Unavailable";
const format = (n: number) => n.toLocaleString("en-US");

export function UsageCostPanels({ data }: { data: UsageSummary }) {
  const local = data.claude;
  return (
    <div className="space-y-4">
      <section aria-labelledby="provider-cost-heading" className="space-y-3">
        <div>
          <h2 id="provider-cost-heading" className="text-base font-semibold text-gray-100">Provider billing</h2>
          <p className="mt-1 text-xs text-gray-400">
            {data.provider_window ? `Completed UTC days: ${data.provider_window.since.slice(0, 10)} through ${new Date(Date.parse(data.provider_window.until) - 1).toISOString().slice(0, 10)}. ` : "Complete UTC days. "}
            Provider costs may overlap agent-attributed usage below; they are separate views of the same activity.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {(data.providers ?? []).map((provider) => (
            <article key={provider.account_id} className="rounded-xl border border-white/10 bg-[#101828] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{provider.label}</h3>
                <span className={`rounded-full px-2 py-0.5 text-xs ${provider.coverage === "complete" ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-200"}`}>
                  {provider.coverage === "complete" ? "Complete report" : provider.coverage === "partial" ? "Partial period" : provider.coverage === "unverified" ? "Unverified coverage" : "Not connected"}
                </span>
              </div>
              <div className="mt-3 text-3xl font-semibold tabular-nums text-[#ff9a3c]">{dollars(provider.cost_usd)}</div>
              <p className="mt-1 text-xs text-gray-400">{provider.coverage === "complete" ? "Reported cost for this period" : "Observed cost only; period total is not verified"}</p>
              <p className="mt-3 text-xs leading-relaxed text-gray-400">{provider.note}</p>
              {provider.account_id === "openrouter-shared" && (
                <p className="mt-3 text-sm text-gray-300">Credit balance: <span className="tabular-nums">{dollars(provider.credits_remaining)}</span> <span className="text-xs text-gray-400">(latest collection)</span></p>
              )}
              <p className="mt-3 text-xs text-gray-400">Collected: {timestamp(provider.collected_at)}</p>
              {provider.data_refreshed_at && <p className="mt-1 text-xs text-gray-400">Provider refreshed: {timestamp(provider.data_refreshed_at)}</p>}
            </article>
          ))}
        </div>
        {data.providers?.some((p) => p.cost_usd !== null) && (
          <details className="rounded-xl border border-white/10 bg-[#101828] p-4">
            <summary className="cursor-pointer text-sm font-medium text-gray-200">Daily provider costs</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead><tr className="text-gray-400"><th className="py-2 text-left">Day (UTC)</th>{data.providers.map((p) => <th key={p.account_id} className="py-2 text-right">{p.label}</th>)}</tr></thead>
                <tbody>{[...(data.providers[0]?.daily ?? [])].reverse().map((day) => (
                  <tr key={day.date} className="border-t border-white/5"><td className="py-2">{day.date}</td>{data.providers!.map((p) => <td key={p.account_id} className="text-right">{dollars(p.daily.find((d) => d.date === day.date)?.cost_usd ?? null)}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        )}
      </section>
      {local && (
        <section aria-labelledby="claude-usage-heading" className="rounded-xl border border-white/10 bg-[#101828] p-4">
          <h2 id="claude-usage-heading" className="text-base font-semibold">Claude subscription and local usage</h2>
          <p className="mt-1 text-xs text-gray-400">Recorded fees and Claude Code observations in the selected rolling window. Local usage covers scanned machines; claude.ai and other devices are not included.</p>
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div><p className="text-xs text-gray-400">Recorded subscription fees</p><p className="mt-1 text-2xl font-semibold tabular-nums">{dollars(local.subscription_fees_usd)}</p><p className="mt-1 text-xs text-gray-400">{local.fee_records ? `${local.fee_records} fee record(s), by payment date` : "No verified fee records in this window"}</p></div>
            <div><p className="text-xs text-gray-400">Observed Claude Code requests</p><p className="mt-1 text-2xl font-semibold tabular-nums">{local.requests ? format(local.requests) : "No observations"}</p><p className="mt-1 text-xs text-gray-400">{format(local.billing_modes.subscription)} subscription · {format(local.billing_modes.api)} API · {format(local.billing_modes.unknown)} unclassified</p></div>
            <div><p className="text-xs text-gray-400">Input / output tokens</p><p className="mt-1 text-lg font-semibold tabular-nums">{format(local.input_tokens)} / {format(local.output_tokens)}</p><p className="mt-1 text-xs text-gray-400">Cache: {format(local.cache_read_tokens)} read · {format(local.cache_write_tokens)} written</p></div>
            <div><p className="text-xs text-gray-400">Reported token value (estimate)</p><p className="mt-1 text-2xl font-semibold tabular-nums text-sky-300">{dollars(local.reported_estimate_usd)}</p><p className="mt-1 text-xs text-gray-400">{format(local.unpriced_requests)} requests without an estimate. This is not a charge.</p></div>
          </div>
          <p className="mt-4 text-xs text-gray-400">Subscription fees, API costs, and token value are kept separate. Local tokens do not establish extra-usage charges.</p>
          <ul className="mt-3 space-y-1 text-xs text-gray-400">
            {local.machines.map((machine) => <li key={machine.account_id} className="break-words">{machine.account_id.replace("claude-code:", "")} · {machine.status === "complete" ? "scan complete" : "partial or unverified scan"} · collected {timestamp(machine.collected_at)}{machine.since && machine.until ? ` · ${machine.since.slice(0, 10)} to ${machine.until.slice(0, 10)}` : ""}</li>)}
            {!local.machines.length && <li>No local collection received.</li>}
          </ul>
        </section>
      )}
    </div>
  );
}
