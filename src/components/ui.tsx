"use client";

import { useEffect, useState } from "react";
import type { AgentStatus } from "@/lib/types";

/**
 * Agent status styles, shared by Fleet, History, Progress and the Gibson.
 * Hex values match AGENT_STATUS_COLORS in src/lib/gibson-types.ts (a unit test
 * keeps them in sync): green active, amber needs you, red failed, dim done.
 * Class strings stay literal so Tailwind can see them.
 */
export const STATUS_STYLES: Record<AgentStatus | string, { label: string; dot: string; text: string; ring: string }> = {
  active: { label: "ACTIVE", dot: "bg-[#2ee6a6]", text: "text-[#2ee6a6]", ring: "ring-[#2ee6a6]/40" },
  waiting: { label: "NEEDS YOU", dot: "bg-[#ffb020]", text: "text-[#ffb020]", ring: "ring-[#ffb020]/45" },
  failed: { label: "FAILED", dot: "bg-[#ff3b5c]", text: "text-[#ff5c77]", ring: "ring-[#ff3b5c]/45" },
  done: { label: "DONE", dot: "bg-[#5c6f96]", text: "text-[#8b9bc0]", ring: "ring-[#5c6f96]/35" },
  offline: { label: "OFFLINE", dot: "bg-[#3b4559]", text: "text-[#8f98ab]", ring: "ring-[#3b4559]/50" },
};

/**
 * Task status styles, in the same palette: green running, amber review (needs
 * you), red failed, dim done. Queued and claimed use Gibson's floor blues;
 * cancelled is neutral gray. Text colors keep at least 4.5:1 contrast on cards.
 */
export const TASK_STATUS_STYLES: Record<string, { label: string; dot: string; text: string; ring: string }> = {
  queued: { label: "QUEUED", dot: "bg-[#4a5f9e]", text: "text-[#aab6d6]", ring: "ring-[#4a5f9e]/50" },
  claimed: { label: "CLAIMED", dot: "bg-[#7f9cff]", text: "text-[#a3b8ff]", ring: "ring-[#7f9cff]/45" },
  running: { label: "RUNNING", dot: "bg-[#2ee6a6]", text: "text-[#2ee6a6]", ring: "ring-[#2ee6a6]/40" },
  review: { label: "IN REVIEW", dot: "bg-[#ffb020]", text: "text-[#ffb020]", ring: "ring-[#ffb020]/45" },
  done: { label: "DONE", dot: "bg-[#5c6f96]", text: "text-[#8b9bc0]", ring: "ring-[#5c6f96]/35" },
  failed: { label: "FAILED", dot: "bg-[#ff3b5c]", text: "text-[#ff5c77]", ring: "ring-[#ff3b5c]/45" },
  cancelled: { label: "CANCELLED", dot: "bg-[#4b5263]", text: "text-[#8f98ab]", ring: "ring-[#4b5263]/40" },
};

export function TaskStatusChip({ status }: { status: string }) {
  const s = TASK_STATUS_STYLES[status] ?? TASK_STATUS_STYLES.queued;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${s.ring} ${s.text} bg-white/5 mono`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot} ${status === "running" ? "pulse-dot" : ""}`} />
      {s.label}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.offline;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${s.ring} ${s.text} bg-white/5 mono`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${status === "active" ? "pulse-dot" : ""}`} />
      {s.label}
    </span>
  );
}

/**
 * Platform marks: a tinted tile with a two-letter glyph, so a card reads at a
 * glance without reproducing any vendor's logo. Unknown platforms get a neutral
 * tile with the first two letters of their id.
 */
export const PLATFORM_META: Record<string, { label: string; glyph: string; color: string }> = {
  "claude-code": { label: "Claude Code", glyph: "CL", color: "#d97757" },
  "cowork-cloud": { label: "Cowork · Cloud", glyph: "CW", color: "#d97757" },
  "cowork-local": { label: "Cowork · Local", glyph: "CW", color: "#d97757" },
  "chatgpt-work": { label: "ChatGPT Work", glyph: "GP", color: "#10a37f" },
  codex: { label: "Codex", glyph: "CX", color: "#10a37f" },
  grok: { label: "Grok", glyph: "GK", color: "#c9d1e3" },
  hermes: { label: "Hermes", glyph: "HE", color: "#a78bfa" },
  "cline-roo": { label: "Cline / Roo", glyph: "CR", color: "#5ec8ff" },
  any: { label: "Any platform", glyph: "\u2217", color: "#8b9bc0" },
};

export function platformMeta(platform: string): { label: string; glyph: string; color: string } {
  return PLATFORM_META[platform] ?? { label: platform, glyph: platform.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?", color: "#8b9bc0" };
}

export function PlatformMark({ platform, size = 16 }: { platform: string; size?: number }) {
  const m = platformMeta(platform);
  return (
    <span
      aria-hidden
      className="mono inline-flex shrink-0 items-center justify-center rounded-[4px] font-bold leading-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), color: m.color, backgroundColor: `${m.color}1f`, boxShadow: `inset 0 0 0 1px ${m.color}55` }}
    >
      {m.glyph}
    </span>
  );
}

export function PlatformBadge({ platform }: { platform: string }) {
  const m = platformMeta(platform);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500 mono" title={platform}>
      <PlatformMark platform={platform} size={14} />
      {m.label}
    </span>
  );
}

export function TimeAgo({ iso }: { iso: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <span className="text-gray-600">never</span>;
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  let label: string;
  if (secs < 60) label = "just now";
  else if (secs < 3600) label = `${Math.floor(secs / 60)}m ago`;
  else if (secs < 86400) label = `${Math.floor(secs / 3600)}h ago`;
  else label = `${Math.floor(secs / 86400)}d ago`;
  return <span title={iso}>{label}</span>;
}

/**
 * Demo mode lives in the header as a pill, not a banner on every page. The
 * tooltip holds the instructions; the Help pages have the long version.
 */
export function DemoPill() {
  return (
    <span
      className="mono whitespace-nowrap rounded-full bg-[#2563eb]/15 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[#9db9ff] ring-1 ring-inset ring-[#2563eb]/50"
      title="Demo mode: simulated data, no database connected. Set DATABASE_URL and MC_TOKEN to go live."
    >
      demo · simulated
    </span>
  );
}
