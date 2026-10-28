"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SkillRow } from "@/components/SkillRow";
import { SkillUpstreamHeader } from "@/components/SkillUpstreamHeader";
import { categoryOptions, filterSkills, laneOptions, RUNTIME_FILTERS, skillsQuery, UNCATEGORIZED } from "@/components/SkillHelpers";
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
  const [category, setCategory] = useState(params.get("category")?.trim() || "all");
  const { data, error, reload, mutateSkill, holdSkill } = useSkills({ q, runtime, category });
  // Keep every category seen so far: filtering by one must not remove the others from the menu.
  const seenCategories = useRef(new Map<string, string>());
  for (const label of categoryOptions(data?.skills ?? [])) seenCategories.current.set(label.toLowerCase(), label);
  if (category !== "all" && category !== UNCATEGORIZED && !seenCategories.current.has(category.toLowerCase())) {
    seenCategories.current.set(category.toLowerCase(), category);
  }
  const categories = [...seenCategories.current.values()].sort((a, b) => a.localeCompare(b));

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(qInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [qInput]);

  useEffect(() => {
    const path = `/skills${skillsQuery({ q, runtime, category })}`;
    if (path === window.location.pathname + window.location.search) return;
    router.replace(path, { scroll: false });
  }, [q, runtime, category, router]);

  // Back/Forward changes the URL without remounting; pull the controls back in line with it.
  const paramQ = params.get("q") ?? "";
  const paramRuntime = normalizeRuntime(params.get("runtime"));
  const paramCategory = params.get("category")?.trim() || "all";
  useEffect(() => {
    setQInput((cur) => (cur.trim() === paramQ.trim() ? cur : paramQ));
    setQ(paramQ.trim());
    setRuntime(paramRuntime);
    setCategory(paramCategory);
  }, [paramQ, paramRuntime, paramCategory]);

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
        <label className="flex items-center gap-2 text-xs text-gray-500">
          Category
          <select value={category} aria-label="Category" onChange={(event) => setCategory(event.target.value)} className={`${field} max-w-[14rem]`}>
            <option value="all">All</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
            <option value={UNCATEGORIZED}>Uncategorized</option>
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
