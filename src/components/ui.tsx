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

export function PlatformBadge({ platform }: { platform: string }) {
  const labels: Record<string, string> = {
    "claude-code": "Claude Code",
    "cowork-cloud": "Cowork · Cloud",
    "cowork-local": "Cowork · Local",
    "chatgpt-work": "ChatGPT Work",
    codex: "Codex",
    grok: "Grok",
    hermes: "Hermes",
    any: "Any platform",
  };
  return (
    <span className="text-[11px] uppercase tracking-wider text-gray-500 mono">
      {labels[platform] ?? platform}
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

export function DemoBanner() {
  return (
    <div className="mb-4 rounded-lg border border-[#2563eb]/30 bg-[#2563eb]/10 px-4 py-2.5 text-sm text-[#9db9ff]">
      Demo mode — no database connected yet. Set <span className="mono">DATABASE_URL</span> and{" "}
      <span className="mono">MC_TOKEN</span> to go live.
    </div>
  );
}
