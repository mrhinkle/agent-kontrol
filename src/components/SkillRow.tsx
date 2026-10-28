"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PlatformMark, platformMeta, TimeAgo } from "@/components/ui";
import {
  applyOptimisticSkillPatch,
  dimSkillRow,
  formatVersion,
  isCronNonEmpty,
  readApiError,
  runtimePlatformId,
  showClaudeOnlyFlag,
  skillDetailPath,
  categoryLabel,
  reconcileSkill,
} from "./SkillHelpers";
import { SkillScopeControl } from "./SkillScopeControl";
import { SkillTriggerControl } from "./SkillTriggerControl";
import type { SkillPatch, SkillScope, SkillSummary, Trigger } from "./skills-types";

export function SkillRow({
  skill,
  runtime,
  lanes,
  mutateSkill,
  holdSkill,
}: {
  skill: SkillSummary;
  runtime: string;
  lanes: readonly string[];
  mutateSkill: (id: string, next: SkillSummary) => void;
  holdSkill: (id: string, held: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const errorTimer = useRef<number | null>(null);
  const [visualScheduled, setVisualScheduled] = useState(false);
  const [focusSchedule, setFocusSchedule] = useState(false);
  const [cronText, setCronText] = useState(skill.schedule ?? "");
  const [cronDirty, setCronDirty] = useState(false);

  const unsavedSchedule = visualScheduled && skill.trigger !== "scheduled";
  const displayTrigger: Trigger = visualScheduled ? "scheduled" : skill.trigger;
  const flagged = showClaudeOnlyFlag(skill.runtimes, runtime);
  const dimmed = dimSkillRow(skill.runtimes, runtime);

  useEffect(() => {
    if (!cronDirty) setCronText(skill.schedule ?? "");
  }, [skill.schedule, cronDirty]);

  useEffect(() => {
    holdSkill(skill.id, pending || unsavedSchedule);
  }, [holdSkill, pending, skill.id, unsavedSchedule]);

  useEffect(() => {
    return () => holdSkill(skill.id, false);
  }, [holdSkill, skill.id]);

  useEffect(() => {
    return () => {
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    };
  }, []);

  function clearError() {
    setRowError(null);
    if (errorTimer.current !== null) {
      window.clearTimeout(errorTimer.current);
      errorTimer.current = null;
    }
  }

  function flashError(message: string) {
    setRowError(`Couldn't save — reverted. ${message}`);
    if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => {
      setRowError(null);
      errorTimer.current = null;
    }, 6000);
  }

  async function persist(patch: SkillPatch) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    // Hold before the request so an in-flight poll cannot replace this row.
    holdSkill(skill.id, true);
    clearError();
    const previous = skill;
    const touchesTrigger = patch.trigger !== undefined;
    const optimistic = applyOptimisticSkillPatch([skill], skill.id, patch)[0];
    mutateSkill(skill.id, optimistic);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        mutateSkill(skill.id, previous);
        if (touchesTrigger) {
          setCronDirty(false);
          setVisualScheduled(false);
        }
        flashError(readApiError(body, `HTTP ${res.status}`));
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      mutateSkill(skill.id, reconcileSkill(optimistic, body));
      if (touchesTrigger) {
        setCronDirty(false);
        setVisualScheduled(false);
      }
    } catch (e) {
      mutateSkill(skill.id, previous);
      if (touchesTrigger) {
        setCronDirty(false);
        setVisualScheduled(false);
      }
      flashError(e instanceof Error ? e.message : "network error");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function onTrigger(next: Trigger) {
    if (pendingRef.current) return;
    clearError();
    if (next === "scheduled") {
      const existing = (skill.schedule ?? "").trim();
      // No cron yet: keep the radio selected locally and PATCH only when Save has text.
      if (!existing) {
        setVisualScheduled(true);
        setCronText("");
        setCronDirty(false);
        setFocusSchedule(true);
        holdSkill(skill.id, true);
        return;
      }
      setVisualScheduled(false);
      void persist({ trigger: "scheduled", schedule: existing });
      return;
    }
    setVisualScheduled(false);
    void persist({ trigger: next });
  }

  function onSaveSchedule() {
    const schedule = cronText.trim();
    if (!isCronNonEmpty(schedule) || pendingRef.current) return;
    void persist({ trigger: "scheduled", schedule });
  }

  function onScope(scope: SkillScope) {
    if (pendingRef.current) return;
    clearError();
    void persist({ scope });
  }

  return (
    <article className={`rounded-xl border border-white/10 bg-[#101828] p-4 ${dimmed ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={skillDetailPath(skill.id)} className="mono font-medium text-gray-100 hover:text-white">
              {skill.name}
            </Link>
            <SkillRuntimeChips runtimes={skill.runtimes} />
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-gray-400 ring-1 ring-white/10" title="Category">
              {categoryLabel(skill.category)}
            </span>
            {flagged && (
              <span className="inline-flex items-center rounded-full bg-[#ffb020]/15 px-2 py-0.5 text-[11px] font-medium text-[#ffb020] ring-1 ring-[#ffb020]/40">
                claude only — hidden from codex/grok
              </span>
            )}
          </div>
        </div>
        <span className="mono shrink-0 text-sm text-gray-400">{formatVersion(skill.version)}</span>
      </div>
      {skill.description && <p className="mt-1 text-sm text-gray-400">{skill.description}</p>}

      <SkillTriggerControl
        skillId={skill.id}
        trigger={displayTrigger}
        schedule={cronText}
        pending={pending}
        focusSchedule={focusSchedule}
        onTrigger={onTrigger}
        onSchedule={(value) => {
          clearError();
          setCronDirty(true);
          setCronText(value);
          setFocusSchedule(false);
        }}
        onSaveSchedule={onSaveSchedule}
      />
      <SkillScopeControl skillId={skill.id} scope={skill.scope} lanes={lanes} pending={pending} onChange={onScope} />

      {rowError && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {rowError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>
          Last run:{" "}
          {skill.lastRun ? (
            <>
              <TimeAgo iso={skill.lastRun.at} /> by <span className="mono text-gray-300">{skill.lastRun.agent}</span>
            </>
          ) : (
            "never"
          )}
        </span>
        <span className="mono">
          {skill.triggerCount7d} {skill.triggerCount7d === 1 ? "trigger" : "triggers"} · 7d
        </span>
        <Link href={skillDetailPath(skill.id)} className="ml-auto text-gray-300 hover:text-white">
          Details
        </Link>
      </div>
    </article>
  );
}

function SkillRuntimeChips({ runtimes }: { runtimes: readonly string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {runtimes.map((runtime) => {
        const platform = runtimePlatformId(runtime) ?? runtime;
        const meta = platformMeta(platform);
        return (
          <span
            key={runtime}
            title={meta.label}
            className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-gray-300 ring-1 ring-white/10"
          >
            <PlatformMark platform={platform} size={12} />
            <span className="mono">{runtime}</span>
          </span>
        );
      })}
    </span>
  );
}
