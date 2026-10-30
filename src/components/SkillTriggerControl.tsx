"use client";

import { useEffect, useRef } from "react";
import { isCronNonEmpty, TRIGGER_OPTIONS } from "./SkillHelpers";
import type { Trigger } from "./skills-types";

const field =
  "min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0a0f1c] px-3 py-2 text-sm text-gray-200 outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70 disabled:opacity-40 sm:max-w-xs";

export function SkillTriggerControl({
  skillId,
  trigger,
  schedule,
  pending,
  onTrigger,
  onSchedule,
  onSaveSchedule,
  focusSchedule,
}: {
  skillId: string;
  trigger: Trigger;
  schedule: string;
  pending: boolean;
  onTrigger: (next: Trigger) => void;
  onSchedule: (value: string) => void;
  onSaveSchedule: () => void;
  focusSchedule: boolean;
}) {
  const cronRef = useRef<HTMLInputElement>(null);
  const groupName = `trigger-${skillId}`;

  useEffect(() => {
    if (focusSchedule) cronRef.current?.focus();
  }, [focusSchedule]);

  return (
    <fieldset disabled={pending} className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-0 p-0">
      <legend className="p-0 text-xs text-gray-500">Trigger</legend>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div role="radiogroup" aria-label="Trigger" className="flex flex-wrap items-center gap-x-1 gap-y-1">
          {TRIGGER_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-gray-200 md:min-h-8"
            >
              <input
                type="radio"
                name={groupName}
                value={option.value}
                checked={trigger === option.value}
                onChange={() => onTrigger(option.value)}
                className="h-4 w-4 accent-[#f44800] focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70"
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>
      {trigger === "scheduled" && (
        <div className="mt-1 flex basis-full flex-wrap items-center gap-2">
          <input
            ref={cronRef}
            type="text"
            value={schedule}
            placeholder="0 7 * * *"
            aria-label="Cron schedule"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onSchedule(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSaveSchedule();
              }
            }}
            className={`${field} mono`}
          />
          <button
            type="button"
            onClick={onSaveSchedule}
            disabled={!isCronNonEmpty(schedule)}
            className="min-h-11 rounded-lg bg-[#f44800] px-3 text-sm font-semibold text-white hover:bg-[#ff5a10] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70 md:min-h-8"
          >
            Save
          </button>
        </div>
      )}
    </fieldset>
  );
}
