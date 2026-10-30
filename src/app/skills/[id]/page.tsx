"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { CollapsibleMarkdown } from "@/components/Markdown";
import { SkillCompatibility } from "@/components/SkillCompatibility";
import { scopeLabel, skillSourceUrl, triggerLabel } from "@/components/SkillHelpers";
import { SkillTriggersTable } from "@/components/SkillTriggersTable";
import { useSkill } from "@/components/use-skills";

export default function SkillDetailPage() {
  const params = useParams();
  const id = skillId(params.id);
  const { data, error, loading, notFound } = useSkill(id);

  if (notFound) {
    return (
      <div>
        <Link href="/skills" className="text-sm text-gray-400 hover:text-gray-200">
          ‹ Skills
        </Link>
        <p className="mt-3 text-sm text-gray-300">Skill not found</p>
      </div>
    );
  }
  if (error) return <div className="text-red-400 text-sm">Failed to load skill: {error}</div>;
  if (loading || !data) return <div className="text-gray-500 text-sm animate-pulse">Loading the skill…</div>;

  const source = skillSourceUrl(data);
  const references = Array.isArray(data.references) ? data.references : [];
  const triggers = Array.isArray(data.triggers) ? data.triggers : [];

  return (
    <div className="max-w-full">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="min-w-0 text-lg font-semibold">
          <Link href="/skills" className="text-gray-400 hover:text-gray-200">
            ‹ Skills
          </Link>
          <span className="text-gray-600"> / </span>
          <span className="mono text-gray-100">{data.name}</span>
        </h1>
        {source && (
          <a
            href={source}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm text-[#7aa5ff] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70"
          >
            Open upstream source
          </a>
        )}
      </div>

      <div className="grid items-start gap-4 md:grid-cols-2">
        <section className="min-w-0 rounded-xl border border-white/10 bg-[#101828] p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-400">SKILL.md</h2>
          <CollapsibleMarkdown source={data.body ?? ""} className="text-sm leading-relaxed text-gray-300" />
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-gray-500">References:</h3>
          {references.length === 0 ? (
            <p className="mt-1 text-sm text-gray-600">None.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {references.map((reference) => (
                <li key={reference.path} className="mono break-all text-sm text-gray-300">
                  {reference.path}
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="min-w-0">
          <SkillCompatibility runtimes={data.runtimes} sha={data.sha} />
          <p className="mt-3 text-sm text-gray-400">
            Trigger: <span className="text-gray-200">{triggerLabel(data.trigger)}</span>
            {data.trigger === "scheduled" && data.schedule ? <span className="mono text-gray-300"> {data.schedule}</span> : null}
          </p>
          <p className="text-sm text-gray-400">
            Scope: <span className="text-gray-200">{scopeLabel(data.scope)}</span>
          </p>
        </div>
      </div>

      <SkillTriggersTable triggers={triggers} />
    </div>
  );
}

function skillId(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}
