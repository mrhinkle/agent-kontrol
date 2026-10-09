"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useFleet } from "@/components/use-fleet";
import { ConversationDrawer } from "@/components/ConversationDrawer";
import { DemoBanner, PlatformBadge, STATUS_STYLES, StatusChip, TimeAgo } from "@/components/ui";
import { buildFeed } from "@/lib/feed";
import { sessionTitle } from "@/lib/history";
import type { AgentStatus, Event, FleetAgent } from "@/lib/types";

const FEED_LIMIT = 25;

function MailboxBadges({ agent }: { agent: FleetAgent }) {
  const pending = agent.pending_messages ?? 0;
  const unread = agent.unread_replies ?? 0;
  if (pending === 0 && unread === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {pending > 0 && (
        <span
          className="rounded-full bg-[#ffb020]/10 px-2 py-0.5 text-[#ffcf70] ring-1 ring-[#ffb020]/30"
          title={`${pending} message${pending === 1 ? "" : "s"} you sent that the agent hasn't picked up yet. Agents read messages at their next check-in.`}
        >
          📬 {pending} waiting for agent
        </span>
      )}
      {unread > 0 && (
        <span
          className="rounded-full bg-[#2ee6a6]/10 px-2 py-0.5 text-[#7ff3c8] ring-1 ring-[#2ee6a6]/30"
          title={`${unread} repl${unread === 1 ? "y" : "ies"} from the agent you haven't opened. Open the conversation to read ${unread === 1 ? "it" : "them"}.`}
        >
          💬 {unread} new repl{unread === 1 ? "y" : "ies"}
        </span>
      )}
    </div>
  );
}

function AgentCard({ agent, events }: { agent: FleetAgent; events: Event[] }) {
  const s = agent.current_session;
  const name = agent.display_name ?? agent.id;
  const headline = s ? sessionTitle(s, agent.platform, events) : null;
  // With no open session, say how the last one ended (why a FAILED agent failed).
  const last = s ? null : agent.recent_sessions[0] ?? null;
  const lastHeadline = last ? sessionTitle(last, agent.platform, events) : null;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-[#101828] p-4 transition-colors hover:border-white/20">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* Full name, wrapped — never truncated. */}
          <div className="break-words font-medium leading-snug" title={agent.id}>
            {name}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2">
            <PlatformBadge platform={agent.platform} />
            {agent.machine && <span className="mono text-[11px] text-gray-600">{agent.machine}</span>}
          </div>
        </div>
        <div className="shrink-0">
          <StatusChip status={agent.derived_status} />
        </div>
      </div>

      <MailboxBadges agent={agent} />

      {s && headline ? (
        <div className="text-sm">
          {headline.source === "summary" ? (
            <div className="line-clamp-3 text-gray-300" title={headline.title}>
              {headline.title}
            </div>
          ) : headline.source === "event" ? (
            <div className="text-gray-400">
              <div className="line-clamp-2" title={headline.title}>
                {headline.title}
              </div>
              <div className="mt-0.5 text-[11px] text-gray-600">No summary yet. This is the latest instruction it received.</div>
            </div>
          ) : (
            <div className="text-[12px] text-gray-500">
              No summary yet. The agent is checking in but hasn&apos;t described its work. A summary appears once its hooks
              or a <span className="mono">report_status</span> call report one.
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            {s.project && <span className="mono whitespace-nowrap rounded bg-[#7aa5ff]/10 px-1.5 text-[#9dbcff]">{s.project}</span>}
            <span>
              started <TimeAgo iso={s.started_at} />
            </span>
          </div>
        </div>
      ) : last && lastHeadline ? (
        <div className="text-sm">
          <div className="text-[11px] uppercase tracking-wider text-gray-600">
            Last session · {last.status}
            {" · "}
            <TimeAgo iso={last.ended_at ?? last.updated_at} />
          </div>
          <div
            className={`mt-0.5 line-clamp-2 ${last.status === "failed" ? "text-[#ff8da0]" : lastHeadline.source === "fallback" ? "text-gray-600" : "text-gray-400"}`}
            title={lastHeadline.title}
          >
            {lastHeadline.title}
          </div>
        </div>
      ) : (
        <div className="text-sm italic text-gray-600">No open session</div>
      )}

      <div className="mt-auto">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>
            last seen <TimeAgo iso={agent.last_seen_at} />
          </span>
          <Link href={`/history?agent=${encodeURIComponent(agent.id)}`} className="hover:text-gray-300">
            History →
          </Link>
        </div>
        <ConversationDrawer agent={agent} />
      </div>
    </div>
  );
}

function EventRow({ e, count, agent }: { e: Event; count: number; agent: FleetAgent | undefined }) {
  const name = agent ? agent.display_name ?? agent.id : e.agent_id;
  const tone = STATUS_STYLES[agent?.derived_status ?? "offline"] ?? STATUS_STYLES.offline;
  return (
    <div className="grid grid-cols-[4rem_minmax(0,14rem)_minmax(0,1fr)] items-baseline gap-x-3 border-b border-white/5 py-1.5 text-sm last:border-0 max-sm:grid-cols-[4rem_minmax(0,1fr)]">
      <span className="mono text-xs text-gray-600">
        <TimeAgo iso={e.created_at} />
      </span>
      {/* Agent names wrap instead of being cut off. */}
      <span className="mono break-words text-xs text-gray-300">
        <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${tone.dot}`} aria-hidden />
        {name}
      </span>
      <span className="min-w-0 break-words text-gray-300 max-sm:col-span-2 max-sm:pl-[4.75rem]">
        <span className="mono mr-2 text-xs text-gray-500">{e.kind}</span>
        {e.title ?? ""}
        {count > 1 && (
          <span className="mono ml-2 rounded bg-white/5 px-1.5 text-[11px] text-gray-500" title={`${count} identical events in a row`}>
            ×{count}
          </span>
        )}
      </span>
    </div>
  );
}

export default function FleetPage() {
  const { data, error } = useFleet();
  const [showBackground, setShowBackground] = useState(false);

  // Keep the server's order (most recently seen first). Re-sorting by status would
  // move cards under the cursor while someone is typing in a conversation.
  const agents = data?.agents ?? [];
  const feed = useMemo(() => buildFeed(data?.events ?? [], { showBackground, limit: FEED_LIMIT }), [data, showBackground]);

  if (error && !data) return <div className="text-sm text-red-400">Failed to load fleet: {error}</div>;
  if (!data) return <div className="animate-pulse text-sm text-gray-500">Contacting the fleet…</div>;

  const byId = new Map(data.agents.map((a) => [a.id, a]));
  const count = (st: AgentStatus) => data.agents.filter((a) => a.derived_status === st).length;
  const working = count("active");
  const needsYou = count("waiting");
  const failed = count("failed");

  return (
    <div>
      {data.demo && <DemoBanner />}

      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-1">
        <h1 className="text-lg font-semibold">Fleet</h1>
        <div className="text-sm text-gray-500">
          <span className="font-semibold text-[#2ee6a6]">{working}</span> working ·{" "}
          <span className="font-semibold text-[#ffb020]">{needsYou}</span> need{needsYou === 1 ? "s" : ""} you
          {failed > 0 && (
            <>
              {" "}
              · <span className="font-semibold text-[#ff5c77]">{failed}</span> failed
            </>
          )}{" "}
          · {data.agents.length} agents
        </div>
        {error && <span className="text-xs text-amber-400">Refresh failed ({error}); showing last good data.</span>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => (
          <AgentCard key={a.id} agent={a} events={data.events} />
        ))}
        {agents.length === 0 && (
          <div className="col-span-full text-sm text-gray-500">
            No agents have reported in yet. Wire up a Claude Code hook or connect the MCP server — see the README.
          </div>
        )}
      </div>

      <div className="mb-2 mt-10 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Live activity</h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500">
          <input type="checkbox" checked={showBackground} onChange={(e) => setShowBackground(e.target.checked)} className="accent-[#2ee6a6]" />
          Show heartbeats &amp; telemetry{!showBackground && feed.hidden > 0 ? ` (${feed.hidden} hidden)` : ""}
        </label>
      </div>
      <div className="rounded-xl border border-white/10 bg-[#101828] px-4 py-2">
        {feed.items.map((it) => (
          <EventRow key={it.event.id} e={it.event} count={it.count} agent={byId.get(it.event.agent_id)} />
        ))}
        {feed.items.length === 0 && (
          <div className="py-2 text-sm text-gray-600">
            {feed.hidden > 0 ? "Only heartbeats and telemetry lately. Nothing else to show." : "No activity yet."}
          </div>
        )}
      </div>
    </div>
  );
}
