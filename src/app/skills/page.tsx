"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SkillRow } from "@/components/SkillRow";
import { SkillUpstreamHeader } from "@/components/SkillUpstreamHeader";
import { filterSkills, laneOptions, RUNTIME_FILTERS, skillsQuery } from "@/components/SkillHelpers";
import { useSkills } from "@/components/use-skills";

const field =
  "rounded-lg border border-white/10 bg-[#101828] px-3 py-2 text-sm text-gray-200 outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70";

export default function SkillsPage() {
  return (
    <Suspense fallback={<div className="text-gray-500 text-sm animate-pulse">Loading the skills…</div>}>
      <SkillsList />
    </Suspense>
  );
}

function SkillsList() {
  const params = useSearchParams();
  const router = useRouter();
  const initialQ = params.get("q") ?? "";
  const initialRuntime = normalizeRuntime(params.get("runtime"));
  const [qInput, setQInput] = useState(initialQ);
  const [runtime, setRuntime] = useState(initialRuntime);
  const [q, setQ] = useState(initialQ.trim());
  const { data, error, reload, mutateSkill, holdSkill } = useSkills({ q, runtime });

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(qInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [qInput]);

  useEffect(() => {
    const path = `/skills${skillsQuery({ q, runtime })}`;
    if (path === window.location.pathname + window.location.search) return;
    router.replace(path, { scroll: false });
  }, [q, runtime, router]);

  const skills = data?.skills ?? [];
  const visible = filterSkills(skills, qInput);
  const lanes = laneOptions(skills);

  return (
    <div className="max-w-full">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Skills</h1>
        <input
          type="search"
          value={qInput}
          onChange={(event) => setQInput(event.target.value)}
          placeholder="search skills..."
          aria-label="Search skills"
          className={`${field} w-full min-w-0 sm:w-64`}
        />
        <label className="flex items-center gap-2 text-xs text-gray-500">
          Runtime
          <select
            value={runtime}
            aria-label="Runtime"
            onChange={(event) => setRuntime(normalizeRuntime(event.target.value))}
            className={field}
          >
            {RUNTIME_FILTERS.map((item) => (
              <option key={item} value={item}>
                {item === "all" ? "All" : item}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!data && error && <div className="text-red-400 text-sm">Failed to load skills: {error}</div>}
      {!data && !error && <div className="text-gray-500 text-sm animate-pulse">Loading the skills…</div>}

      {data && (
        <>
          {error && <div className="mb-3 text-red-400 text-sm">Failed to load skills: {error}</div>}
          <SkillUpstreamHeader upstream={data.upstream} onSynced={() => void reload()} />
          <div className="mt-4 grid gap-3">
            {visible.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                runtime={runtime}
                lanes={lanes}
                mutateSkill={mutateSkill}
                holdSkill={holdSkill}
              />
            ))}
            {visible.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-[#101828] px-4 py-8 text-sm text-gray-500">
                {skills.length === 0 ? "No skills yet." : "No skills match."}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function normalizeRuntime(value: string | null): string {
  if (value && (RUNTIME_FILTERS as readonly string[]).includes(value)) return value;
  return "all";
}
