"use client";

import React, { type FormEvent } from "react";
import { decisionSourceHref, readOptions } from "@/lib/decision-format";
import type { Decision } from "@/lib/decisions";

const input =
  "bg-[#0a0f1c] border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#2563eb] w-full";

export function DecisionCard({
  decision,
  onResolve,
  onRetry,
}: {
  decision: Decision;
  onResolve?: (id: number, body: Record<string, unknown>) => void;
  onRetry?: (decision: Decision) => void;
}) {
  const href = decisionSourceHref(decision);
  const options = readOptions(decision.options);
  const open = decision.status === "open" || decision.status === "deferred";

  function send(event: FormEvent<HTMLFormElement>, status: "decided" | "deferred") {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const option = String(data.get("option_id") ?? "");
    const body: Record<string, unknown> = {
      status,
      expected_updated_at: decision.updated_at,
    };
    if (status === "decided") {
      body.decision = String(data.get("decision") ?? "");
      if (option) body.option_id = option;
    } else {
      body.defer_until = String(data.get("defer_until") ?? "");
    }
    onResolve?.(decision.id, body);
  }

  return (
    <article className="rounded-xl border border-white/10 bg-[#101828] p-4 mb-4">
      <header className="flex items-baseline justify-between gap-3 mb-2">
        <h2 className="text-base font-semibold">{decision.title}</h2>
        <span className="text-xs text-gray-400 shrink-0">Age {decision.age_days} days</span>
      </header>
      {href ? (
        <a className="text-sm text-[#2563eb] underline" href={href}>
          source
        </a>
      ) : null}
      {decision.why ? (
        <p className="text-sm text-gray-300 mt-3">
          <span className="text-gray-500">Why </span>
          {decision.why}
        </p>
      ) : null}
      {options.length > 0 ? (
        <ul className="mt-3 text-sm">
          {options.map((option) => (
            <li key={option.id}>
              {option.label}
              {decision.recommended === option.id ? " (recommended)" : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {decision.decision ? <p className="text-sm mt-3">{decision.decision}</p> : null}
      {decision.writeback === "not_written" ? (
        <p className="text-sm text-[#f44800] mt-3">
          not written back{" "}
          <button
            type="button"
            className="underline"
            onClick={() => onRetry?.(decision)}
          >
            Retry write-back
          </button>
        </p>
      ) : null}
      {open ? (
        <div className="mt-4 grid gap-3">
          <form className="grid gap-2" onSubmit={(event) => send(event, "decided")}>
            <label className="text-xs text-gray-400" htmlFor={`decision-${decision.id}`}>
              Decision text
            </label>
            <textarea id={`decision-${decision.id}`} name="decision" className={`${input} min-h-16`} />
            {options.length > 0 ? (
              <select name="option_id" className={input} defaultValue="">
                <option value="">No option</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
            <button type="submit" className="justify-self-start rounded-lg bg-[#f44800] px-3 py-2 text-sm font-semibold">
              Decide
            </button>
          </form>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => send(event, "deferred")}>
            <label className="text-xs text-gray-400" htmlFor={`defer-${decision.id}`}>
              Defer until
              <input id={`defer-${decision.id}`} name="defer_until" type="date" className={`${input} mt-1`} />
            </label>
            <button type="submit" className="rounded-lg border border-white/15 px-3 py-2 text-sm">
              Defer
            </button>
          </form>
          <button
            type="button"
            className="justify-self-start text-sm text-gray-300 underline"
            onClick={() =>
              onResolve?.(decision.id, {
                status: "withdrawn",
                expected_updated_at: decision.updated_at,
              })
            }
          >
            Withdraw
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function DecisionList({
  decisions,
  onResolve,
  onRetry,
}: {
  decisions: Decision[];
  onResolve?: (id: number, body: Record<string, unknown>) => void;
  onRetry?: (decision: Decision) => void;
}) {
  if (decisions.length === 0) {
    return <p className="text-sm text-gray-400">No open decisions.</p>;
  }
  return (
    <div>
      {decisions.map((decision) => (
        <DecisionCard key={decision.id} decision={decision} onResolve={onResolve} onRetry={onRetry} />
      ))}
    </div>
  );
}
