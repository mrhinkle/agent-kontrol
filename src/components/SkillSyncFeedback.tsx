import React from "react";
import { countOf, readApiError } from "./SkillHelpers";
import type { SkillSyncDiagnostic, SkillSyncView } from "./skills-types";

/** Read a sync response. Fatal diagnostics are ordered ahead of notices. Source ids stay on each entry. */
export function skillSyncView(httpOk: boolean, httpStatus: number, body: unknown): SkillSyncView {
  if (!httpOk) return { kind: "request-error", message: readApiError(body, `Sync failed (${httpStatus})`) };
  const parsed = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const status = parsed.status === "failed" || parsed.status === "busy" ? parsed.status : "ok";
  return {
    kind: "result",
    result: {
      status,
      added: countOf(parsed.added),
      changed: countOf(parsed.changed),
      removed: countOf(parsed.removed),
      diagnostics: readDiagnostics(parsed.errors, status),
    },
  };
}

export function formatDiagnostic(item: SkillSyncDiagnostic): string {
  return item.source ? `${item.source}: ${item.message}` : item.message;
}

export function SkillSyncFeedback({ view }: { view: SkillSyncView | null }) {
  if (!view) return null;
  if (view.kind === "request-error") return <span className="text-xs text-red-400">{view.message}</span>;
  const { status, added, changed, removed, diagnostics } = view.result;
  const fatals = diagnostics.filter((item) => item.severity === "fatal");
  const notices = diagnostics.filter((item) => item.severity === "notice");
  const headline = fatals[0] ?? null;
  const counts = status === "ok" || status === "failed";
  return (
    <>
      {counts && (
        <span className="mono text-xs text-gray-300">
          +{added} ~{changed} −{removed}
        </span>
      )}
      {status === "busy" && <span className="text-xs text-[#ffb020]">A sync is already running.</span>}
      {status === "failed" && (
        <span className="text-xs text-red-400">Sync failed{headline ? `: ${formatDiagnostic(headline)}` : "."}</span>
      )}
      {status === "ok" && notices.length > 0 && (
        <ul aria-label="Sync notices" className="m-0 flex list-none flex-col gap-1 p-0">
          {notices.map((item, index) => (
            <li key={`${item.source}:${item.message}:${index}`} className="text-xs text-[#ffb020]">
              {formatDiagnostic(item)}
            </li>
          ))}
        </ul>
      )}
      {status === "failed" && diagnostics.length > 0 && (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer text-gray-300">
            {diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}
            {notices.length > 0 ? ` (${notices.length} notice${notices.length === 1 ? "" : "s"})` : ""}
          </summary>
          <ul aria-label="Sync diagnostics" className="m-0 list-none p-0">
            {diagnostics.map((item, index) => (
              <li key={`${item.severity}:${item.source}:${item.message}:${index}`} data-severity={item.severity}>
                {formatDiagnostic(item)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function readDiagnostics(value: unknown, status: "ok" | "failed" | "busy"): SkillSyncDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const fatals: SkillSyncDiagnostic[] = [];
  const untagged: SkillSyncDiagnostic[] = [];
  const notices: SkillSyncDiagnostic[] = [];
  let tagged = false;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.message !== "string" || record.message.length === 0) continue;
    const source = typeof record.source === "string" ? record.source : "";
    if (record.severity === "notice") {
      tagged = true;
      notices.push({ source, message: record.message, severity: "notice" });
    } else if (record.severity === "fatal") {
      tagged = true;
      fatals.push({ source, message: record.message, severity: "fatal" });
    } else {
      untagged.push({ source, message: record.message, severity: status === "ok" ? "notice" : "fatal" });
    }
  }
  if (!tagged) return untagged;
  return [...fatals, ...untagged, ...notices];
}
