import { RUNTIME_KEYS, shortSha, showHermesClaudeOnlyNote } from "./SkillHelpers";
import type { RuntimeCompatibility } from "./skills-types";

export function SkillCompatibility({ runtimes, sha }: { runtimes: RuntimeCompatibility; sha: string }) {
  const note = showHermesClaudeOnlyNote(runtimes);
  return (
    <section className="min-w-0 rounded-xl border border-white/10 bg-[#101828] p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Compatibility</h2>
      <ul className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {RUNTIME_KEYS.map((key) => (
          <li key={key}>
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-gray-300 md:min-h-8">
              <input
                type="checkbox"
                checked={runtimes[key]}
                disabled
                readOnly
                aria-readonly="true"
                onChange={() => {}}
                className="h-4 w-4 accent-[#2563eb]"
              />
              <span className="mono">{key}</span>
              {key === "hermes" && !runtimes.hermes && note && (
                <span className="text-xs text-[#ffb020]">(Claude-only tools)</span>
              )}
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-gray-400">
        Pinned SHA:{" "}
        <span className="mono text-gray-200" title={sha}>
          {shortSha(sha)}
        </span>
      </p>
    </section>
  );
}
