"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFleet } from "@/components/use-fleet";
import { DemoBanner, StatusChip, TimeAgo } from "@/components/ui";
import { Pager } from "@/components/Pager";
import { isBackground } from "@/lib/events";
import { filterEvents, historySessions, paginate, sessionSpan, shortId, type HistorySession } from "@/lib/history";
import type { Event, FleetAgent } from "@/lib/types";

const SESSIONS_PER_PAGE = 10;
const EVENTS_PER_PAGE = 25;

export default function HistoryPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div className="text-gray-500 text-sm animate-pulse">Loading history…</div>}>
      <History />
    </Suspense>
  );
}

function History() {
  const { data, error } = useFleet();
  const params = useSearchParams();
  const router = useRouter();
  const agentId = params.get("agent") || null;

  function setAgent(id: string | null) {
    router.replace(id ? `/history?agent=${encodeURIComponent(id)}` : "/history", { scroll: false });
  }

  if (error && !data) return <div className="text-red-400 text-sm">Failed to load: {error}</div>;
  if (!data) return <div className="text-gray-500 text-sm animate-pulse">Loading history…</div>;

  const agents = [...data.agents].sort((a, b) => (a.display_name ?? a.id).localeCompare(b.display_name ?? b.id));
  const selected = agentId ? agents.find((a) => a.id === agentId) ?? null : null;

  return (
    <div>
      {data.demo && <DemoBanner />}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">History</h1>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          Agent
          <select
            value={agentId ?? ""}
            onChange={(e) => setAgent(e.target.value || null)}
            className="rounded-md border border-white/10 bg-[#101828] px-2 py-1 text-sm text-gray-200 focus:border-white/30 focus:outline-none"
          >
            <option value="">All agents ({agents.length})</option>
            {agentId && !selected && <option value={agentId}>{agentId} (not reporting)</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name ?? a.id}
              </option>
            ))}
          </select>
        </label>
        {agentId && (
          <button type="button" onClick={() => setAgent(null)} className="text-xs text-gray-500 underline-offset-2 hover:text-gray-300 hover:underline">
            Show all agents
          </button>
        )}
        {error && <span className="text-xs text-amber-400">Refresh failed ({error}); showing last good data.</span>}
      </div>

      {agentId && !selected ? (
        <div className="rounded-lg border border-white/10 bg-[#101828] px-4 py-6 text-sm text-gray-400">
          No agent with id <span className="mono text-gray-200">{agentId}</span> is in the fleet right now. It may have been renamed or
          stopped reporting.{" "}
          <Link href="/history" className="text-gray-200 underline underline-offset-2">
            Show all agents
          </Link>
        </div>
      ) : (
        // Re-mount on filter change so both lists start at page 1.
        <HistoryLists key={agentId ?? "all"} agents={agents} events={data.events} agentId={agentId} onAgent={setAgent} />
      )}
    </div>
  );
}

function HistoryLists({
  agents,
  events,
  agentId,
  onAgent,
}: {
  agents: FleetAgent[];
  events: Event[];
  agentId: string | null;
  onAgent: (id: string | null) => void;
}) {
  const [sessionPage, setSessionPage] = useState(1);
  const [eventPage, setEventPage] = useState(1);
  const [hideBackground, setHideBackground] = useState(true);

  const sessions = useMemo(() => historySessions(agents, events, agentId), [agents, events, agentId]);
  const timeline = useMemo(() => filterEvents(events, { agentId, hideBackground }), [events, agentId, hideBackground]);
  const backgroundCount = useMemo(
    () => events.filter((e) => (!agentId || e.agent_id === agentId) && isBackground(e)).length,
    [events, agentId],
  );
  const names = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.display_name ?? a.id])), [agents]);
  const sPage = paginate(sessions, sessionPage, SESSIONS_PER_PAGE);
  const ePage = paginate(timeline, eventPage, EVENTS_PER_PAGE);
  const now = Date.now();

  // Polls can shrink a list; keep the saved page in step with the clamped one so a
  // later refresh can't silently jump the reader forward.
  useEffect(() => {
    if (sPage.page !== sessionPage) setSessionPage(sPage.page);
  }, [sPage.page, sessionPage]);
  useEffect(() => {
    if (ePage.page !== eventPage) setEventPage(ePage.page);
  }, [ePage.page, eventPage]);

  return (
    <>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-400">Sessions</h2>
      <div className="grid gap-2">
        {sPage.items.map((h) => (
          <SessionRow key={`${h.agentId}:${h.session.id}`} h={h} now={now} showAgent={!agentId} onAgent={onAgent} />
        ))}
        {sessions.length === 0 && <div className="text-sm text-gray-600">No sessions reported.</div>}
      </div>
      <Pager page={sPage} onPage={setSessionPage} noun="sessions" />

      <div className="mb-2 mt-8 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Event timeline</h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={hideBackground}
            onChange={(e) => {
              setHideBackground(e.target.checked);
              setEventPage(1);
            }}
            className="accent-[#2ee6a6]"
          />
          Hide heartbeats & telemetry{backgroundCount > 0 && hideBackground ? ` (${backgroundCount} hidden)` : ""}
        </label>
      </div>
      <ol className="relative pl-5 before:absolute before:bottom-0 before:left-1.5 before:top-0 before:w-px before:bg-white/10">
        {ePage.items.map((e) => (
          <li key={e.id} className="relative pb-4">
            <span className={`absolute -left-5 top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-[#0a0f1c] ${eventDot(e)}`} />
            <div className="mono text-xs text-gray-600">
              <TimeAgo iso={e.created_at} /> · {names[e.agent_id] ?? e.agent_id} · {e.kind}
            </div>
            <div className="text-sm text-gray-300">{e.title ?? <span className="text-gray-600">(no title)</span>}</div>
          </li>
        ))}
        {timeline.length === 0 && (
          <li className="text-sm text-gray-600">{backgroundCount > 0 ? "Only heartbeats and telemetry in this window." : "No events."}</li>
        )}
      </ol>
      <Pager page={ePage} onPage={setEventPage} noun="events" />
    </>
  );
}

function SessionRow({ h, now, showAgent, onAgent }: { h: HistorySession; now: number; showAgent: boolean; onAgent: (id: string) => void }) {
  const { session: s, title } = h;
  return (
    <div className="flex items-start gap-4 rounded-lg border border-white/10 bg-[#101828] px-4 py-3 text-sm">
      <div className="pt-0.5">
        <StatusChip status={s.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={`line-clamp-2 ${title.source === "summary" ? "text-gray-200" : title.source === "event" ? "text-gray-300" : "text-gray-400"}`}
          title={title.source === "summary" ? title.title : `${title.title} (no summary reported; ${title.source === "event" ? "from the session's first turn" : "inferred from platform and project"})`}
        >
          {title.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          {showAgent && (
            <button type="button" onClick={() => onAgent(h.agentId)} className="text-gray-400 hover:text-white" title="Show only this agent">
              {h.agentName}
            </button>
          )}
          {s.project && <span className="mono whitespace-nowrap rounded bg-[#7aa5ff]/10 px-1.5 text-[#9dbcff]">{s.project}</span>}
          <span>
            <time dateTime={s.started_at} title={s.started_at}>
              {startedLabel(s.started_at, now)}
            </time>
            {" · "}
            {sessionSpan(s, now)}
          </span>
          <span className="mono text-gray-600" title={s.id}>
            {shortId(s.id)}
          </span>
        </div>
      </div>
      <span className="shrink-0 text-xs text-gray-600">
        <TimeAgo iso={s.updated_at} />
      </span>
    </div>
  );
}

/** "started 2:02 PM" today, "started Oct 3, 9:15 AM" otherwise (viewer's local time). */
function startedLabel(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return `started ${time}`;
  return `started ${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function eventDot(e: Event): string {
  if (e.kind === "error" || e.kind === "failed") return "bg-[#ff3b5c]";
  if (e.kind === "milestone" || e.kind === "session_start") return "bg-[#2ee6a6]/80";
  if (isBackground(e)) return "bg-gray-700";
  return "bg-[#7f9cff]/70";
}
