"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FleetAgent, Message } from "@/lib/types";
import { deliveryStateFor, type DeliveryState } from "@/lib/message-helpers";

/**
 * Per-agent conversation drawer — self-contained so Fleet page edits stay small.
 * Polls conversation history on the same cadence as the fleet refresh when open.
 */

const POLL_MS = 7000;

function stateLabel(s: DeliveryState): string {
  if (s === "queued") return "queued";
  if (s === "delivered") return "delivered";
  return "replied";
}

function stateClass(s: DeliveryState): string {
  if (s === "queued") return "text-amber-300";
  if (s === "delivered") return "text-[#7aa5ff]";
  return "text-emerald-300";
}

export function ConversationDrawer({ agent }: { agent: FleetAgent }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/messages?agent_id=${encodeURIComponent(agent.id)}&conversation=true`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (res.status === 503 || json.setup_required) {
        setSetupRequired(true);
        setLoadError(json.message ?? json.error ?? "Two-way messaging isn't set up yet");
        return;
      }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSetupRequired(false);
      setLoadError(null);
      setMessages((json.messages ?? []) as Message[]);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [agent.id]);

  // Mark as read when drawer opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      await load();
      try {
        await fetch("/api/messages", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agent.id }),
        });
      } catch {
        /* ignore — badge clears on next fleet poll once migration is live */
      }
    })();
    const t = setInterval(() => {
      if (alive) void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, agent.id, load]);

  const threadStates = useMemo(() => {
    const map = new Map<number, DeliveryState>();
    for (const m of messages) {
      map.set(m.id, deliveryStateFor(m, messages));
    }
    return map;
  }, [messages]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setSendState("sending");
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agent.id, body, created_by: "Operator" }),
      });
      const json = await res.json();
      if (res.status === 503 || json.setup_required) {
        setSetupRequired(true);
        setLoadError(json.message ?? "Two-way messaging isn't set up yet");
        setSendState("error");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setText("");
      setSendState("sent");
      setTimeout(() => setSendState("idle"), 2000);
      await load();
    } catch {
      setSendState("error");
    }
  }

  const unread = agent.unread_replies ?? 0;
  const pending = agent.pending_messages ?? 0;

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-[#0a0f1c] px-2.5 py-1.5 text-xs text-gray-300 hover:border-white/20 transition-colors"
      >
        <span className="font-medium">
          {open ? "Hide conversation" : "Conversation"}
        </span>
        <span className="flex items-center gap-2 mono text-[11px]">
          {pending > 0 && (
            <span className="text-[#ff7a40]" title="waiting for agent">
              📬 {pending}
            </span>
          )}
          {unread > 0 && (
            <span className="text-emerald-300" title="unread replies">
              💬 {unread}
            </span>
          )}
          <span className="text-gray-600">{open ? "▾" : "▸"}</span>
        </span>
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-white/10 bg-[#0a0f1c] p-2.5 flex flex-col gap-2">
          {setupRequired ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-50">
              <div className="font-semibold text-amber-100">Two-way messaging isn&apos;t set up yet</div>
              <p className="mt-1 text-amber-200/80">
                Run <span className="mono">supabase/migrations/20261005_messages_two_way.sql</span> against
                the live database, then reopen this drawer.
              </p>
              {loadError && <p className="mt-1 mono text-[10px] text-amber-200/60">{loadError}</p>}
            </div>
          ) : (
            <>
              <div className="max-h-48 overflow-y-auto flex flex-col gap-1.5 pr-0.5">
                {messages.length === 0 && !loadError && (
                  <div className="text-[11px] text-gray-600 italic py-1">No messages yet.</div>
                )}
                {loadError && !setupRequired && (
                  <div className="text-[11px] text-red-400">{loadError}</div>
                )}
                {messages.map((m) => {
                  const inbound = (m.direction ?? "inbound") === "inbound";
                  const state = threadStates.get(m.id) ?? "queued";
                  return (
                    <div
                      key={m.id}
                      className={`rounded-md px-2 py-1.5 text-[11px] leading-snug ${
                        inbound
                          ? "bg-[#152038] text-gray-200 self-end ml-6"
                          : "bg-[#13281f] text-emerald-50 self-start mr-6"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="mono text-[10px] text-gray-500">
                          {inbound ? m.created_by ?? "Operator" : m.created_by ?? agent.display_name ?? agent.id}
                        </span>
                        {inbound && (
                          <span className={`mono text-[10px] ${stateClass(state)}`}>
                            {stateLabel(state)}
                          </span>
                        )}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{m.body}</div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void send();
                  }}
                  placeholder={`Message ${agent.display_name ?? agent.id}…`}
                  className="flex-1 bg-[#101828] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-[#2563eb]"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sendState === "sending" || !text.trim()}
                  className="text-xs px-2.5 py-1.5 rounded-lg bg-[#f44800] hover:bg-[#ff5a10] disabled:opacity-40 text-white font-semibold transition-colors"
                >
                  {sendState === "sending" ? "…" : sendState === "sent" ? "Sent ✓" : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
