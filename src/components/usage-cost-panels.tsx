import React from "react";
import type { ShadowCostSummary, UsageSummary } from "@/lib/usage-types";
import { effectiveHidden, hideableCards } from "@/lib/usage-hidden-cards";

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
function ShadowValue({ shadow, vendor, action }: { shadow: ShadowCostSummary; vendor: string; action?: React.ReactNode }) {
  return (
    <div>
      <CardLabel text="API-equivalent value (estimate)" action={action} />
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

/** Card caption with an optional hide control beside it. */
function CardLabel({ text, action }: { text: string; action?: React.ReactNode }) {
  if (!action) return <p className="text-xs text-gray-400">{text}</p>;
  return <div className="flex items-start justify-between gap-2"><p className="text-xs text-gray-400">{text}</p>{action}</div>;
}

export type SetCardsHidden = (cards: string[], hidden: boolean) => void;

function HideButton({ card, label, onSetHidden }: { card: string; label: string; onSetHidden: SetCardsHidden }) {
  return (
    <button
      type="button"
      onClick={() => onSetHidden([card], true)}
      aria-label={`Hide ${label}: no data source connected`}
      title="Hide this box. It comes back on its own when data arrives, or with Show hidden."
      data-hide-card={card}
      className="mono shrink-0 rounded border border-fg/10 px-1.5 py-0.5 text-[10px] text-gray-500 transition-colors hover:border-fg/20 hover:text-fg"
    >
      Hide
    </button>
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

/**
 * `hidden` is the stored list of hidden card keys and `onSetHidden` saves a change.
 * A stored key hides a card only while that card has no data source
 * (see usage-hidden-cards.ts). Hiding is display only: the daily provider table
 * and every figure on the remaining cards are unchanged.
 */
export function UsageCostPanels({ data, hidden = [], onSetHidden }: { data: UsageSummary; hidden?: Iterable<string>; onSetHidden?: SetCardsHidden }) {
  const local = data.claude;
  const hideable = hideableCards(data);
  const hiddenNow = effectiveHidden(hidden, data);
  const shown = (card: string) => !hiddenNow.has(card);
  const hide = (card: string) => onSetHidden && hideable.has(card)
    ? <HideButton card={card} label={hideable.get(card)!} onSetHidden={onSetHidden} />
    : undefined;
  return (
    <div className="space-y-4">
      {hiddenNow.size > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-fg/10 bg-panel px-3 py-2 text-xs text-gray-400">
          <span>{hiddenNow.size === 1 ? "1 box" : `${hiddenNow.size} boxes`} with no data source hidden: {[...hiddenNow].map((k) => hideable.get(k)).join(", ")}. Totals are unchanged.</span>
          {onSetHidden && (
            <button type="button" data-show-hidden onClick={() => onSetHidden([...hiddenNow], false)} className="mono rounded border border-fg/10 px-2 py-0.5 text-[11px] text-gray-300 transition-colors hover:border-fg/20 hover:text-fg">
              Show {hiddenNow.size} hidden
            </button>
          )}
        </div>
      )}
      <section aria-labelledby="provider-cost-heading" className="space-y-3">
        <div>
          <h2 id="provider-cost-heading" className="text-base font-semibold text-gray-100">Provider billing</h2>
          <p className="mt-1 text-xs text-gray-400">
            {data.provider_window ? `Completed UTC days: ${data.provider_window.since.slice(0, 10)} through ${new Date(Date.parse(data.provider_window.until) - 1).toISOString().slice(0, 10)}. ` : "Complete UTC days. "}
            Provider costs may overlap agent-attributed usage below; they are separate views of the same activity.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(data.providers ?? []).filter((provider) => shown(`provider:${provider.account_id}`)).map((provider) => (
            <article key={provider.account_id} className="rounded-xl border border-fg/10 bg-panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{provider.label}</h3>
                <span className="flex items-center gap-2">
                {hide(`provider:${provider.account_id}`)}
                <span className={`rounded-sm px-2 py-0.5 text-xs ${provider.coverage === "complete" ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-200"}`}>
                  {provider.coverage === "complete" ? "Complete report" : provider.coverage === "partial" ? "Partial period" : provider.coverage === "unverified" ? "Unverified coverage" : "Not connected"}
                </span>
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
            {shown("grok:openrouter") && <div><CardLabel text="Grok through OpenRouter" action={hide("grok:openrouter")} /><p className="mt-1 text-2xl font-semibold tabular-nums">{dollars(data.grok.openrouter_cost_usd)}</p><p className="mt-1 text-xs text-gray-400">Included in OpenRouter above for the completed UTC days.{data.grok.openrouter_coverage !== "complete" && " Observed charges only; period total is not verified."}</p></div>}
            {shown("grok:local") && <div><CardLabel text="Local Grok CLI usage" action={hide("grok:local")} />
              {data.grok.local_usage_status === "unavailable"
                ? <><p className="mt-1 text-2xl font-semibold">Unavailable</p><p className="mt-1 text-xs text-gray-400">No Grok CLI collection received.</p></>
                : <><p className="mt-1 text-2xl font-semibold tabular-nums">{data.grok.model_calls ? `${format(data.grok.model_calls)} calls` : "No observations"}</p><p className="mt-1 text-xs text-gray-400">{format(data.grok.turns)} turn(s) · {format(data.grok.input_tokens)} input / {format(data.grok.output_tokens)} output · {format(data.grok.cache_read_tokens)} cache read{data.grok.local_usage_status === "partial" ? " · partial scan" : ""}</p></>}
            </div>}
            {data.grok.shadow && shown("grok:shadow") && <ShadowValue shadow={data.grok.shadow} vendor="xAI" action={hide("grok:shadow")} />}
          </div>
          {data.grok.shadow && <ShadowByModel shadow={data.grok.shadow} />}
          {data.grok.reported_estimate_usd !== null && <p className="mt-3 text-xs text-gray-400">The Grok CLI also recorded its own estimate of {dollars(data.grok.reported_estimate_usd)} for these turns. This is not a charge.</p>}
          {data.grok.local_usage_status !== "unavailable" && <p className="mt-3 text-xs text-gray-400">Grok records tokens per turn, not per call, so the long-prompt rate is judged on the average prompt per call. Each turn is counted once, even when a resumed session repeats it.</p>}
          <p className="mt-4 text-xs text-gray-400">Grok API billing, subscription payments and OpenRouter charges remain separate. No subscription price is assumed.</p>
          {data.grok.machines.length > 0 && <ul className="mt-3 space-y-1 text-xs text-gray-400">
            {data.grok.machines.map((machine) => <li key={machine.account_id} className="break-words">{machine.account_id.replace("grok-cli:", "")} · {machine.status === "complete" ? "scan complete" : "partial or unverified scan"} · collected {timestamp(machine.collected_at)}{machine.since && machine.until ? ` · ${machine.since.slice(0, 10)} to ${machine.until.slice(0, 10)}` : ""}</li>)}
          </ul>}
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
            {shown("claude:shadow") && (local.shadow
              ? <ShadowValue shadow={local.shadow} vendor="Anthropic" action={hide("claude:shadow")} />
              : <div><CardLabel text="API-equivalent value (estimate)" action={hide("claude:shadow")} /><p className="mt-1 text-2xl font-semibold tabular-nums text-sky-300">Not available</p></div>)}
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
