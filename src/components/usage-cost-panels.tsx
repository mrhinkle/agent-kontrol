import React from "react";
import type { ShadowCostSummary, UsageSummary } from "@/lib/usage-types";

const dollars = (value: number | null) => value === null ? "Not available" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const timestamp = (value: string | null) => !value ? "Never collected" : Number.isFinite(Date.parse(value))
  ? `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC` : "Unavailable";
const format = (n: number) => n.toLocaleString("en-US");
const unpricedNote = (s: ShadowCostSummary) => [
  s.unpriced_requests && `${format(s.unpriced_requests)} request(s) not priced: ${[
    s.unpriced.unknown_model && `${format(s.unpriced.unknown_model)} unknown model`,
    s.unpriced.missing_model && `${format(s.unpriced.missing_model)} no model`,
    s.unpriced.missing_tokens && `${format(s.unpriced.missing_tokens)} no token counts`,
  ].filter(Boolean).join(", ")}.`,
  s.excluded_api_requests && `${format(s.excluded_api_requests)} API-billed request(s) left out; they are metered spend.`,
  s.unclassified_requests && `Includes ${format(s.unclassified_requests)} request(s) with no recorded payment method.`,
].filter(Boolean).join(" ");

/** Estimate only. Kept out of provider billing and every paid total. */
function ShadowValue({ shadow, vendor }: { shadow: ShadowCostSummary; vendor: string }) {
  return (
    <div>
      <p className="text-xs text-gray-400">API-equivalent value (estimate)</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-sky-300">{shadow.unavailable_reason === "no_token_feed" ? "Unavailable" : dollars(shadow.usd)}</p>
      <p className="mt-1 text-xs text-gray-400">
        {shadow.unavailable_reason === "no_token_feed"
          ? `No ${vendor} token feed yet, so there is nothing to price. `
          : `Not a charge. ${vendor} API list prices checked ${shadow.rates_checked_at}; cache writes at the 5-minute rate, so this is a lower bound. `}
        {unpricedNote(shadow)}
      </p>
    </div>
  );
}

function ShadowByModel({ shadow }: { shadow: ShadowCostSummary }) {
  if (!shadow.by_model.length) return null;
  return (
    <details className="mt-4 rounded-lg border border-fg/10 p-3">
      <summary className="cursor-pointer text-sm font-medium text-gray-200">API-equivalent value by model (estimate)</summary>
      <table className="mt-3 w-full text-sm tabular-nums">
        <thead><tr className="text-gray-400"><th className="py-1 text-left font-medium">Model</th><th className="py-1 text-right font-medium">Requests</th><th className="py-1 text-right font-medium">Estimate</th></tr></thead>
        <tbody>{shadow.by_model.map((m) => (
          <tr key={m.model} className="border-t border-fg/5"><td className="py-1 mono text-[12px]">{m.model}</td><td className="py-1 text-right">{format(m.requests)}</td><td className="py-1 text-right text-sky-300">{dollars(m.usd)}</td></tr>
        ))}</tbody>
      </table>
      <p className="mt-2 text-xs text-gray-400">Rate table {shadow.rate_version}. Source: <a className="underline" href={shadow.by_model[0].source_url}>{shadow.by_model[0].source_url}</a>{shadow.unknown_models.length ? `. Not priced: ${shadow.unknown_models.join(", ")}` : ""}</p>
    </details>
  );
}

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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(data.providers ?? []).map((provider) => (
            <article key={provider.account_id} className="rounded-xl border border-fg/10 bg-panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{provider.label}</h3>
                <span className={`rounded-sm px-2 py-0.5 text-xs ${provider.coverage === "complete" ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-200"}`}>
                  {provider.coverage === "complete" ? "Complete report" : provider.coverage === "partial" ? "Partial period" : provider.coverage === "unverified" ? "Unverified coverage" : "Not connected"}
                </span>
              </div>
              <div className="mt-3 text-3xl font-semibold tabular-nums text-warn">{dollars(provider.cost_usd)}</div>
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
          <details className="rounded-xl border border-fg/10 bg-panel p-4">
            <summary className="cursor-pointer text-sm font-medium text-gray-200">Daily provider costs</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead><tr className="text-gray-400"><th className="py-2 text-left">Day (UTC)</th>{data.providers.map((p) => <th key={p.account_id} className="py-2 text-right">{p.label}</th>)}</tr></thead>
                <tbody>{[...(data.providers[0]?.daily ?? [])].reverse().map((day) => (
                  <tr key={day.date} className="border-t border-fg/5"><td className="py-2">{day.date}</td>{data.providers!.map((p) => <td key={p.account_id} className="text-right">{dollars(p.daily.find((d) => d.date === day.date)?.cost_usd ?? null)}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        )}
      </section>
      {data.grok && (
        <section aria-labelledby="grok-cost-heading" className="rounded-xl border border-fg/10 bg-panel p-4">
          <h2 id="grok-cost-heading" className="text-base font-semibold">Grok subscription and routed usage</h2>
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div><p className="text-xs text-gray-400">Recorded subscription fees</p><p className="mt-1 text-2xl font-semibold tabular-nums">{dollars(data.grok.subscription_fees_usd)}</p><p className="mt-1 text-xs text-gray-400">{data.grok.fee_records ? `${data.grok.fee_records} verified payment record(s) in the selected rolling window` : "No verified fee records in this window"}</p></div>
            <div><p className="text-xs text-gray-400">Grok through OpenRouter</p><p className="mt-1 text-2xl font-semibold tabular-nums">{dollars(data.grok.openrouter_cost_usd)}</p><p className="mt-1 text-xs text-gray-400">Included in OpenRouter above for the completed UTC days.{data.grok.openrouter_coverage !== "complete" && " Observed charges only; period total is not verified."}</p></div>
            <div><p className="text-xs text-gray-400">Local Grok usage</p><p className="mt-1 text-2xl font-semibold">Unavailable</p><p className="mt-1 text-xs text-gray-400">Local records may include inherited or rolled-up usage, so they cannot establish a reliable total.</p></div>
            {data.grok.shadow && <ShadowValue shadow={data.grok.shadow} vendor="xAI" />}
          </div>
          <p className="mt-4 text-xs text-gray-400">Grok API billing, subscription payments and OpenRouter charges remain separate. No subscription price is assumed.</p>
        </section>
      )}
      {local && (
        <section aria-labelledby="claude-usage-heading" className="rounded-xl border border-fg/10 bg-panel p-4">
          <h2 id="claude-usage-heading" className="text-base font-semibold">Claude subscription and local usage</h2>
          <p className="mt-1 text-xs text-gray-400">Recorded fees and Claude Code observations in the selected rolling window. Local usage covers scanned machines; claude.ai and other devices are not included.</p>
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div><p className="text-xs text-gray-400">Recorded subscription fees</p><p className="mt-1 text-2xl font-semibold tabular-nums">{dollars(local.subscription_fees_usd)}</p><p className="mt-1 text-xs text-gray-400">{local.fee_records ? `${local.fee_records} fee record(s), by payment date` : "No verified fee records in this window"}</p></div>
            <div><p className="text-xs text-gray-400">Observed Claude Code requests</p><p className="mt-1 text-2xl font-semibold tabular-nums">{local.requests ? format(local.requests) : "No observations"}</p><p className="mt-1 text-xs text-gray-400">{format(local.billing_modes.subscription)} subscription · {format(local.billing_modes.api)} API · {format(local.billing_modes.unknown)} unclassified</p></div>
            <div><p className="text-xs text-gray-400">Input / output tokens</p><p className="mt-1 text-lg font-semibold tabular-nums">{format(local.input_tokens)} / {format(local.output_tokens)}</p><p className="mt-1 text-xs text-gray-400">Cache: {format(local.cache_read_tokens)} read · {format(local.cache_write_tokens)} written</p></div>
            {local.shadow
              ? <ShadowValue shadow={local.shadow} vendor="Anthropic" />
              : <div><p className="text-xs text-gray-400">API-equivalent value (estimate)</p><p className="mt-1 text-2xl font-semibold tabular-nums text-sky-300">Not available</p></div>}
          </div>
          {local.shadow && <ShadowByModel shadow={local.shadow} />}
          {local.reported_estimate_usd !== null && <p className="mt-3 text-xs text-gray-400">Claude Code also reported its own estimate of {dollars(local.reported_estimate_usd)} for some requests. This is not a charge.</p>}
          <p className="mt-4 text-xs text-gray-400">Subscription fees, API costs, and API-equivalent value are kept separate. The estimate is what these tokens would cost on the metered API; it is not billed, and local tokens do not establish extra-usage charges.</p>
          <ul className="mt-3 space-y-1 text-xs text-gray-400">
            {local.machines.map((machine) => <li key={machine.account_id} className="break-words">{machine.account_id.replace("claude-code:", "")} · {machine.status === "complete" ? "scan complete" : "partial or unverified scan"} · collected {timestamp(machine.collected_at)}{machine.since && machine.until ? ` · ${machine.since.slice(0, 10)} to ${machine.until.slice(0, 10)}` : ""}</li>)}
            {!local.machines.length && <li>No local collection received.</li>}
          </ul>
        </section>
      )}
    </div>
  );
}
