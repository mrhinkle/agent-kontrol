"use client";

import { useState } from "react";
import type { ScopeMode, SkillScope } from "./skills-types";

const field =
  "min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0a0f1c] px-3 py-2 text-sm text-gray-200 outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70 disabled:opacity-40 sm:max-w-xs";

export function SkillScopeControl({
  skillId,
  scope,
  lanes,
  pending,
  onChange,
}: {
  skillId: string;
  scope: SkillScope;
  lanes: readonly string[];
  pending: boolean;
  onChange: (scope: SkillScope) => void;
}) {
  const [draft, setDraft] = useState("");
  const groupName = `scope-${skillId}`;
  const options = uniqueLanes(lanes, scope.lanes);

  function setMode(mode: ScopeMode) {
    onChange({ mode, lanes: [...scope.lanes] });
  }

  function toggleLane(lane: string) {
    const has = scope.lanes.includes(lane);
    const next = has ? scope.lanes.filter((item) => item !== lane) : [...scope.lanes, lane];
    onChange({ mode: "selected", lanes: next });
  }

  function addLane() {
    const lane = draft.trim();
    if (!lane || scope.lanes.includes(lane)) {
      if (lane && scope.lanes.includes(lane)) setDraft("");
      return;
    }
    onChange({ mode: "selected", lanes: [...scope.lanes, lane] });
    setDraft("");
  }

  return (
    <fieldset disabled={pending} className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-0 p-0">
      <legend className="p-0 text-xs text-gray-500">Scope</legend>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div role="radiogroup" aria-label="Scope" className="flex flex-wrap items-center gap-x-1 gap-y-1">
          {(
            [
              ["all", "All lanes"],
              ["selected", "Selected lanes"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-gray-200 md:min-h-8"
            >
              <input
                type="radio"
                name={groupName}
                value={value}
                checked={scope.mode === value}
                onChange={() => setMode(value)}
                className="h-4 w-4 accent-[#2563eb] focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70"
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      {scope.mode === "selected" && (
        <div className="mt-1 basis-full">
          <div className="flex flex-wrap gap-2">
            {options.map((lane) => (
              <label
                key={lane}
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/5 px-3 text-xs text-gray-200 ring-1 ring-white/10 md:min-h-8"
              >
                <input
                  type="checkbox"
                  checked={scope.lanes.includes(lane)}
                  onChange={() => toggleLane(lane)}
                  className="h-4 w-4 accent-[#2563eb] focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70"
                />
                <span className="mono">{lane}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={draft}
              placeholder="add lane"
              aria-label="Add lane"
              autoComplete="off"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addLane();
                }
              }}
              className={field}
            />
            <button
              type="button"
              onClick={addLane}
              disabled={!draft.trim()}
              className="min-h-11 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-gray-200 hover:bg-white/10 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70 md:min-h-8"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}

function uniqueLanes(options: readonly string[], selected: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lane of [...options, ...selected]) {
    const trimmed = lane.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
