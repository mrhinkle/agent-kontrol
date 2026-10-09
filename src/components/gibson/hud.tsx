"use client";

/**
 * DOM-side building blocks for the Gibson HUD (roster, panels, key, tooltip).
 * Kept apart from src/app/gibson/page.tsx so the page reads as layout + state.
 */

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  AGENT_STATUS_COLORS,
  AGENT_STATUS_LABELS,
  NEUTRAL,
  PLATFORM_KEY,
  STATUS_COLORS,
  STATUS_LABELS,
  platformLabel,
  type GibsonAgentOrb,
  type GibsonBanner,
  type GibsonFloor,
  type GibsonFloorStatus,
  type GibsonHoverInfo,
  type GibsonPlatformShape,
  type GibsonSceneModel,
  type GibsonTower,
} from "@/lib/gibson-types";
import type { AgentStatus } from "@/lib/types";

export function ago(value: string | null): string {
  if (!value) return "never";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function abs(value: string | null): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Re-render every 30s so relative times stay honest between polls. */
export function useTick(ms = 30_000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function PlatformGlyph({ shape, size = 12, color = NEUTRAL.glyph }: { shape: GibsonPlatformShape; size?: number; color?: string }) {
  const common = { fill: "none", stroke: color, strokeWidth: 1.6, strokeLinejoin: "round" as const };
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0">
      {shape === "diamond" && <path d="M6 1 L11 6 L6 11 L1 6 Z" {...common} />}
      {shape === "cube" && <rect x="1.8" y="1.8" width="8.4" height="8.4" {...common} />}
      {shape === "pyramid" && <path d="M6 1.4 L11 10.4 L1 10.4 Z" {...common} />}
      {shape === "sphere" && <circle cx="6" cy="6" r="4.4" {...common} />}
      {shape === "hex" && <path d="M6 1 L10.4 3.5 L10.4 8.5 L6 11 L1.6 8.5 L1.6 3.5 Z" {...common} />}
    </svg>
  );
}

export function StatusDot({ status, reducedMotion }: { status: AgentStatus; reducedMotion: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${status === "active" && !reducedMotion ? "pulse-dot" : ""}`}
      style={{
        backgroundColor: status === "offline" ? "transparent" : AGENT_STATUS_COLORS[status],
        boxShadow: status === "offline" ? `inset 0 0 0 1.5px ${AGENT_STATUS_COLORS.offline}` : undefined,
      }}
      aria-hidden
    />
  );
}

export function StatusPill({ status }: { status: AgentStatus }) {
  const c = AGENT_STATUS_COLORS[status];
  return (
    <span
      className="mono inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: status === "done" || status === "offline" ? "#c3cde4" : c, backgroundColor: `${c}22`, boxShadow: `inset 0 0 0 1px ${c}66` }}
    >
      {AGENT_STATUS_LABELS[status]}
    </span>
  );
}

const TONE: Record<string, { fg: string; bg: string; ring: string }> = {
  red: { fg: "#ff9aac", bg: "#ff3b5c22", ring: "#ff3b5c88" },
  amber: { fg: "#ffd27a", bg: "#ffb02022", ring: "#ffb02088" },
  cyan: { fg: "#8be6ff", bg: "#19d2ff1a", ring: "#19d2ff66" },
  gray: { fg: "#aab4cc", bg: "#ffffff0d", ring: "#ffffff26" },
  green: { fg: "#8ff5cf", bg: "#2ee6a61a", ring: "#2ee6a666" },
};

const LEVEL_TONE: Record<GibsonBanner["level"], keyof typeof TONE> = {
  nominal: "green",
  attention: "amber",
  critical: "red",
  unknown: "gray",
};

export function StatusBanner({
  banner,
  onItem,
}: {
  banner: GibsonBanner;
  onItem: (key: GibsonBanner["items"][number]["key"]) => void;
}) {
  const tone = TONE[LEVEL_TONE[banner.level]];
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-center gap-1.5" role="status" aria-live="polite">
      <span
        className="mono rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]"
        style={{ color: tone.fg, backgroundColor: tone.bg, boxShadow: `inset 0 0 0 1px ${tone.ring}` }}
      >
        {banner.level === "critical" ? "● " : banner.level === "attention" ? "▲ " : ""}
        {banner.headline}
      </span>
      {banner.items.filter((item) => item.tone === "red" || item.tone === "amber").map((item) => {
        const t = TONE[item.tone];
        const inner = <>{item.label}</>;
        const cls =
          "mono rounded-full px-2 py-1 text-[10.5px] transition-colors hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#19d2ff]";
        const style = { color: t.fg, backgroundColor: t.bg, boxShadow: `inset 0 0 0 1px ${t.ring}` };
        return item.key === "needs-you" ? (
          <Link key={item.key} href="/progress" className={cls} style={style} title="Open the Progress board">
            {inner} on Progress →
          </Link>
        ) : (
          <button key={item.key} type="button" onClick={() => onItem(item.key)} className={cls} style={style}>
            {inner}
          </button>
        );
      })}
    </div>
  );
}

export function Roster({
  model,
  selectedOrbId,
  onSelect,
  onHoverOrb,
  rowRef,
  reducedMotion,
}: {
  model: GibsonSceneModel;
  selectedOrbId: string | null;
  onSelect: (id: string) => void;
  onHoverOrb: (id: string | null) => void;
  rowRef: (id: string, el: HTMLButtonElement | null) => void;
  reducedMotion: boolean;
}) {
  const c = model.counts.byStatus;
  return (
    <nav aria-label="Agents" className="flex min-h-0 flex-col">
      <div className="border-b border-white/10 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-100">
          Agents <span className="text-gray-500">({model.counts.agents})</span>
        </h2>
        <p className="mono mt-1 text-[11px] text-gray-400">
          {(["active", "waiting", "failed", "done", "offline"] as AgentStatus[])
            .filter((s) => c[s] > 0)
            .map((s, i) => (
              <span key={s}>
                {i > 0 && " · "}
                <span style={{ color: s === "done" || s === "offline" ? "#aab4cc" : AGENT_STATUS_COLORS[s] }}>{c[s]}</span>{" "}
                {AGENT_STATUS_LABELS[s].toLowerCase()}
              </span>
            ))}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {model.machines.map((m) => (
          <section key={m.machine} className="pb-1">
            <h3 className="mono px-4 pb-1 pt-3 text-[10px] uppercase tracking-[0.18em] text-gray-500">
              {m.machine} · {m.count}
            </h3>
            {model.orbs
              .filter((o) => o.machine === m.machine)
              .map((o) => {
                const selected = o.id === selectedOrbId;
                return (
                  <button
                    key={o.id}
                    ref={(el) => rowRef(o.id, el)}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(o.id)}
                    onMouseEnter={() => onHoverOrb(o.id)}
                    onMouseLeave={() => onHoverOrb(null)}
                    onFocus={() => onHoverOrb(o.id)}
                    onBlur={() => onHoverOrb(null)}
                    className={`flex w-full items-start gap-2.5 border-l-2 px-4 py-2 text-left transition-colors hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none ${
                      selected ? "border-white bg-white/[0.07]" : "border-transparent"
                    }`}
                  >
                    <span className="mt-1 flex items-center gap-1.5">
                      <StatusDot status={o.status} reducedMotion={reducedMotion} />
                      <PlatformGlyph shape={o.shape} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-[13px] leading-snug text-gray-100">{o.label}</span>
                      <span className="mono mt-0.5 block truncate text-[10.5px] text-gray-400">
                        <span style={{ color: o.status === "done" || o.status === "offline" ? "#9aa6c2" : AGENT_STATUS_COLORS[o.status] }}>
                          {AGENT_STATUS_LABELS[o.status].toUpperCase()}
                        </span>
                        {" · "}
                        {o.currentTask ? `#${o.currentTask.id} ${o.currentTask.title}` : o.project ?? "no project"}
                      </span>
                    </span>
                  </button>
                );
              })}
          </section>
        ))}
      </div>
    </nav>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mono text-[10px] uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className="mt-0.5 break-words text-[13px] text-gray-200">{children}</dd>
    </div>
  );
}

export function AgentPanel({
  orb,
  onClose,
  onShowTower,
}: {
  orb: GibsonAgentOrb;
  onClose: () => void;
  onShowTower: (towerId: string) => void;
}) {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-base font-semibold text-white">{orb.label}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusPill status={orb.status} />
            <span className="mono inline-flex items-center gap-1.5 text-[11px] text-gray-300">
              <PlatformGlyph shape={orb.shape} /> {platformLabel(orb.platform)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close agent details"
          className="-mr-1 -mt-1 rounded-md px-2 py-1 text-lg leading-none text-gray-400 hover:bg-white/5 hover:text-white"
        >
          ×
        </button>
      </div>

      <section className="mt-4 rounded-lg border border-white/10 bg-black/25 p-3">
        <h3 className="mono text-[10px] uppercase tracking-wider text-gray-500">
          {orb.currentTask ? "Current task" : orb.status === "active" || orb.status === "waiting" ? "Working on" : "Last session"}
        </h3>
        {orb.assignedTask && (
          <p className="mt-1 text-[12px] text-gray-400">
            Still assigned <span className="mono text-gray-500">#{orb.assignedTask.id}</span> {orb.assignedTask.title}{" "}
            <span className="text-gray-500">(agent is {orb.status === "offline" ? "offline" : "idle"})</span>
          </p>
        )}
        {orb.currentTask && (
          <p className="mt-1 text-[13px] text-gray-100">
            <span className="mono text-gray-500">#{orb.currentTask.id}</span> {orb.currentTask.title}{" "}
            <span className="mono text-[10px] uppercase" style={{ color: STATUS_COLORS[orb.currentTask.status] }}>
              {STATUS_LABELS[orb.currentTask.status]}
            </span>
          </p>
        )}
        {orb.summary ? (
          <p className="mt-1 text-[13px] leading-relaxed text-gray-300">{orb.summary}</p>
        ) : (
          <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
            No summary reported. Hooks show this agent is alive; a summary appears once it calls{" "}
            <span className="mono">report_status</span>.
          </p>
        )}
      </section>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <Field label="Machine">{orb.machine}</Field>
        <Field label="Project">{orb.project ?? "—"}</Field>
        <Field label="Started">
          <span title={abs(orb.sessionStartedAt)}>{orb.sessionStartedAt ? ago(orb.sessionStartedAt) : "—"}</span>
        </Field>
        <Field label="Last seen">
          <span title={abs(orb.lastSeenAt)}>{ago(orb.lastSeenAt)}</span>
        </Field>
        <div className="col-span-2">
          <Field label="Session">
            <span className="mono block truncate text-[11px] text-gray-400" title={orb.sessionId ?? undefined}>
              {orb.sessionId ?? "—"}
            </span>
          </Field>
        </div>
        {(orb.pendingMessages > 0 || orb.unreadReplies > 0) && (
          <div className="col-span-2">
            <Field label="Messages">
              {orb.unreadReplies > 0 && (
                <span className="block">
                  {orb.unreadReplies} unread repl{orb.unreadReplies === 1 ? "y" : "ies"} from this agent (open it on Fleet)
                </span>
              )}
              {orb.pendingMessages > 0 && (
                <span className="block">
                  {orb.pendingMessages} message{orb.pendingMessages === 1 ? "" : "s"} you sent, not yet picked up
                </span>
              )}
            </Field>
          </div>
        )}
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/history?agent=${encodeURIComponent(orb.id)}`}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-gray-100 hover:border-white/30 hover:bg-white/5"
        >
          Open in History →
        </Link>
        {orb.towerId && (
          <button
            type="button"
            onClick={() => onShowTower(orb.towerId as string)}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-gray-100 hover:border-white/30 hover:bg-white/5"
          >
            Show {orb.project} tower
          </button>
        )}
      </div>

      {orb.jobs.length > 1 && (
        <section className="mt-5">
          <h3 className="mono pb-1 text-[10px] uppercase tracking-wider text-gray-500">Recent sessions</h3>
          <ul className="divide-y divide-white/5">
            {orb.jobs.slice(1).map((j) => (
              <li key={j.sessionId} className="py-2">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate text-gray-300">{j.project ?? "no project"}</span>
                  <span className="mono shrink-0 text-[10px] uppercase text-gray-500">{j.status}</span>
                  <span className="mono shrink-0 text-[10px] text-gray-500" title={abs(j.startedAt)}>
                    {ago(j.startedAt)}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[12px] text-gray-500">{j.summary ?? "no summary reported"}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FloorRow({ floor, selected, onSelect }: { floor: GibsonFloor; selected: boolean; onSelect: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex w-full items-center gap-2.5 border-l-2 px-2 py-2 text-left hover:bg-white/5 ${selected ? "border-white bg-white/5" : "border-transparent"}`}
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: STATUS_COLORS[floor.status] }} />
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-gray-200">{floor.title}</span>
        <span className="mono shrink-0 text-[10px] uppercase text-gray-400">{STATUS_LABELS[floor.status]}</span>
      </button>
      {selected && (
        <div className="mb-2 ml-2 rounded-lg border border-white/10 bg-black/25 p-3 text-[12px]">
          <p className="line-clamp-5 whitespace-pre-line leading-relaxed text-gray-400">{floor.description || "No description."}</p>
          <dl className="mono mt-2 grid grid-cols-2 gap-2 text-[10.5px] text-gray-300">
            <div>task #{floor.taskId}</div>
            <div>{platformLabel(floor.platform)}</div>
            <div className="truncate">{floor.assignedAgent ?? "unassigned"}</div>
            <div>{floor.costUsd !== null ? `$${floor.costUsd.toFixed(2)}` : "no cost"}</div>
          </dl>
        </div>
      )}
    </div>
  );
}

export function TowerPanel({
  tower,
  agents,
  selectedTaskId,
  onSelectTask,
  onSelectAgent,
  onClose,
}: {
  tower: GibsonTower;
  agents: GibsonAgentOrb[];
  selectedTaskId: number | null;
  onSelectTask: (id: number) => void;
  onSelectAgent: (id: string) => void;
  onClose: () => void;
}) {
  const open = tower.floors.filter((f) => f.status !== "done").reverse();
  const done = tower.floors.filter((f) => f.status === "done").reverse();
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mono text-[10px] uppercase tracking-wider text-gray-500">Project tower</p>
          <h2 className="break-words text-base font-semibold text-white">{tower.label}</h2>
          <p className="mono mt-1 text-[11px] text-gray-400">
            {open.length} open · {done.length} done (7d) · {agents.length} agent{agents.length === 1 ? "" : "s"} on it
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close tower details" className="-mr-1 -mt-1 rounded-md px-2 py-1 text-lg leading-none text-gray-400 hover:bg-white/5 hover:text-white">
          ×
        </button>
      </div>
      {agents.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {agents.map((a) => (
            <button key={a.id} type="button" onClick={() => onSelectAgent(a.id)} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-gray-200 hover:border-white/30">
              <StatusDot status={a.status} reducedMotion /> {a.label}
            </button>
          ))}
        </div>
      )}
      <h3 className="mono px-2 pb-1 pt-4 text-[10px] uppercase tracking-[0.2em] text-gray-500">Open floors</h3>
      {open.length === 0 && <p className="px-2 text-[12px] text-gray-500">No open tasks.</p>}
      {open.map((f) => (
        <FloorRow key={f.taskId} floor={f} selected={f.taskId === selectedTaskId} onSelect={() => onSelectTask(f.taskId)} />
      ))}
      <h3 className="mono px-2 pb-1 pt-4 text-[10px] uppercase tracking-[0.2em] text-gray-500">Built (done, last 7 days)</h3>
      {done.length === 0 && <p className="px-2 text-[12px] text-gray-500">Nothing completed recently.</p>}
      {done.map((f) => (
        <FloorRow key={f.taskId} floor={f} selected={f.taskId === selectedTaskId} onSelect={() => onSelectTask(f.taskId)} />
      ))}
    </div>
  );
}

function KeyToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-white/5 ${active ? "bg-white/10 text-white" : "text-gray-300"}`}
    >
      {children}
    </button>
  );
}

export function LegendPanel({
  model,
  statusFilter,
  platformFilter,
  onToggleStatus,
  onTogglePlatforms,
  onClear,
}: {
  model: GibsonSceneModel;
  statusFilter: GibsonFloorStatus[];
  platformFilter: string[];
  onToggleStatus: (s: GibsonFloorStatus) => void;
  onTogglePlatforms: (platforms: string[]) => void;
  onClear: () => void;
}) {
  const presentPlatforms = new Set(model.orbs.map((o) => o.platform));
  return (
    <div className="space-y-5 p-4 text-[12px]">
      <section>
        <h2 className="text-sm font-semibold text-gray-100">How to read this</h2>
        <ul className="mt-2 space-y-1.5 leading-relaxed text-gray-400">
          <li><span className="text-gray-200">Agents</span> stand on the outer ring, grouped by machine. <span className="text-gray-200">Color = status</span>, <span className="text-gray-200">shape = platform</span>.</li>
          <li><span className="text-gray-200">Towers</span> are projects. Each <span className="text-gray-200">floor</span> is a task: dim floors at the base are done (last 7 days); glowing floors on top are open.</li>
          <li>A <span className="text-gray-200">dashed line</span> joins an agent to the tower it is working on. A <span style={{ color: STATUS_COLORS.review }}>cyan arc</span> is a review handoff. A tall <span style={{ color: AGENT_STATUS_COLORS.failed }}>beacon</span> marks an agent that failed or is waiting on you.</li>
        </ul>
      </section>

      <section>
        <h3 className="mono pb-1 text-[10px] uppercase tracking-[0.18em] text-gray-500">Agent status (color)</h3>
        <ul className="space-y-1">
          {(["active", "waiting", "failed", "done", "offline"] as AgentStatus[]).map((s) => (
            <li key={s} className="flex items-center gap-2 px-2 text-gray-300">
              <StatusDot status={s} reducedMotion />
              <span className="flex-1">
                {AGENT_STATUS_LABELS[s]}
                <span className="text-gray-500">
                  {s === "active" ? " — pulsing" : s === "done" ? " — dimmed" : s === "offline" ? " — outline, silent >15m" : s === "failed" || s === "waiting" ? " — beacon" : ""}
                </span>
              </span>
              <span className="mono text-gray-500">{model.counts.byStatus[s]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mono pb-1 text-[10px] uppercase tracking-[0.18em] text-gray-500">Task floors (click to filter)</h3>
        <div className="grid grid-cols-2 gap-0.5">
          {(Object.keys(STATUS_COLORS) as GibsonFloorStatus[]).map((s) => (
            <KeyToggle key={s} active={statusFilter.includes(s)} onClick={() => onToggleStatus(s)}>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: STATUS_COLORS[s] }} /> {STATUS_LABELS[s]}
            </KeyToggle>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mono pb-1 text-[10px] uppercase tracking-[0.18em] text-gray-500">Platform (shape, click to filter)</h3>
        <div className="space-y-0.5">
          {PLATFORM_KEY.map((k) => {
            const platforms = k.platforms.length > 0 ? k.platforms : [...presentPlatforms].filter((p) => !PLATFORM_KEY.some((x) => x.platforms.includes(p)));
            if (k.shape === "hex" && platforms.length === 0) return null;
            const active = platforms.length > 0 && platforms.every((p) => platformFilter.includes(p));
            return (
              <KeyToggle key={k.shape} active={active} onClick={() => onTogglePlatforms(platforms)}>
                <PlatformGlyph shape={k.shape} size={13} /> {k.label}
              </KeyToggle>
            );
          })}
        </div>
      </section>

      {(statusFilter.length > 0 || platformFilter.length > 0) && (
        <button type="button" onClick={onClear} className="rounded-full border border-white/20 px-3 py-1 text-[11px] text-gray-200 hover:bg-white/10">
          × Clear filters
        </button>
      )}

      <section>
        <h3 className="mono pb-1 text-[10px] uppercase tracking-[0.18em] text-gray-500">Controls</h3>
        <ul className="mono space-y-1 text-[11px] text-gray-400">
          <li>Drag to orbit · right-drag to pan · scroll to zoom</li>
          <li>Hover for details · click an agent or tower to open it</li>
          <li><Kbd>↑</Kbd> <Kbd>↓</Kbd> cycle agents · <Kbd>Esc</Kbd> close</li>
          <li><Kbd>F</Kbd> fit · <Kbd>R</Kbd> reset · <Kbd>+</Kbd> <Kbd>−</Kbd> zoom</li>
        </ul>
      </section>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-white/20 bg-white/5 px-1 text-[10px] text-gray-200">{children}</kbd>;
}

export function GibsonTooltip({ info }: { info: GibsonHoverInfo }) {
  const flipLeft = typeof window !== "undefined" && info.clientX > window.innerWidth - 320;
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-[19rem] rounded-lg border border-white/15 bg-[#0a0f1c]/95 px-3 py-2 shadow-xl backdrop-blur"
      style={{
        left: flipLeft ? info.clientX - 14 : info.clientX + 16,
        top: info.clientY + 16,
        transform: flipLeft ? "translateX(-100%)" : undefined,
        borderLeft: `3px solid ${info.accent ?? "#5c6f96"}`,
      }}
      role="tooltip"
    >
      <p className="text-[13px] font-medium leading-snug text-white">{info.label}</p>
      <p className="mono mt-0.5 text-[10.5px] uppercase tracking-wider text-gray-400">{info.sub}</p>
      {info.detail && <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-gray-300">{info.detail}</p>}
      {info.kind !== "floor" && <p className="mono mt-1 text-[10px] text-gray-500">click for details</p>}
    </div>
  );
}
