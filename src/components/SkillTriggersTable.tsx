import { TimeAgo } from "@/components/ui";
import type { SkillTriggerEvent, TriggerRunStatus } from "./skills-types";

export function SkillTriggersTable({ triggers }: { triggers: readonly SkillTriggerEvent[] }) {
  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-[#101828]">
      <h2 className="px-4 pt-4 text-sm font-semibold uppercase tracking-wider text-gray-400">Recent triggers</h2>
      {triggers.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-500">No triggers yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-gray-500">
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Lane</th>
                <th className="px-3 py-2 font-medium">Start / end</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((trigger, index) => (
                <tr key={`${trigger.at}-${trigger.agent}-${index}`} className="border-t border-white/5">
                  <td className="px-4 py-2 text-gray-300">
                    <TimeAgo iso={trigger.at} />
                  </td>
                  <td className="mono px-3 py-2 text-gray-200">{trigger.agent}</td>
                  <td className="mono px-3 py-2 text-gray-300">{trigger.lane ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-300">
                    {trigger.started ? "yes" : "no"} / {trigger.ended ? "yes" : "no"}
                  </td>
                  <td className="px-4 py-2">
                    <TriggerStatus status={trigger.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TriggerStatus({ status }: { status: TriggerRunStatus }) {
  if (status === "stalled") {
    return (
      <span className="mono inline-flex items-center rounded-full bg-[#ff3b5c]/15 px-2 py-0.5 text-[11px] font-semibold text-[#ff5c77] ring-1 ring-[#ff3b5c]/45">
        STALLED
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#2ee6a6]">
        <span aria-hidden className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#19d2ff]" />
        running
      </span>
    );
  }
  return (
    <span className="mono text-[11px] font-semibold uppercase tracking-wider text-[#8b9bc0]" title="done">
      ✓ done
    </span>
  );
}
