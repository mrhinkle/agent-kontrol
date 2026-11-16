"use client";

import { useState } from "react";
import { TimeAgo } from "@/components/ui";
import { SkillSyncFeedback, skillSyncView } from "./SkillSyncFeedback";
import { shortSha } from "./SkillHelpers";
import type { SkillSyncView, SkillUpstream } from "./skills-types";

const control =
  "rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/10 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70";

export function SkillUpstreamHeader({ upstream, onSynced }: { upstream: SkillUpstream; onSynced: () => void }) {
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<SkillSyncView | null>(null);

  async function sync() {
    setPending(true);
    setView(null);
    try {
      const res = await fetch("/api/skills/sync", { method: "POST" });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setView(skillSyncView(false, res.status, body));
        return;
      }
      setView(skillSyncView(true, res.status, body));
      onSynced();
    } catch (e) {
      setView({ kind: "request-error", message: e instanceof Error ? e.message : "Sync failed" });
    } finally {
      setPending(false);
    }
  }

  const driftHot = upstream.driftCount > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-gray-400">
      <p>
        Upstream: <span className="text-gray-200">{upstream.source}</span> @{" "}
        <span className="mono text-gray-200" title={upstream.sha ?? undefined}>
          {shortSha(upstream.sha)}
        </span>{" "}
        (synced <TimeAgo iso={upstream.syncedAt} />)
      </p>
      <button type="button" className={control} onClick={() => void sync()} disabled={pending}>
        {pending ? "Syncing…" : "Sync now"}
      </button>
      <SkillSyncFeedback view={view} />
      <span className={driftHot ? "font-medium text-[#ffb020]" : "text-gray-600"}>Drift: {upstream.driftCount}</span>
    </div>
  );
}
