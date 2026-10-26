"use client";

import { changeDetails, type DryRunResult } from "@/lib/dry-run";

/**
 * Confirm dialog for a destructive write. The lines are the server preview
 * (`changes`), not a diff computed again in the browser.
 */
export function PreviewDialog({
  title,
  preview,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  preview: DryRunResult;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const canApply = preview.would_write && !busy;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dry-run-title"
        className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-xl border border-white/10 bg-[#101828] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dry-run-title" className="text-base font-semibold">
          {title}
        </h2>
        {preview.note && <p className="mt-2 text-sm text-gray-300">{preview.note}</p>}
        {preview.changes.length === 0 && !preview.note && (
          <p className="mt-2 text-sm text-gray-300">Nothing would change.</p>
        )}
        <ul className="mt-3 space-y-3">
          {preview.changes.map((change, i) => (
            <li key={`${change.op}-${i}`} className="rounded-lg border border-white/10 p-3 text-sm text-gray-200">
              {changeDetails(change).map((line, j) => (
                <p key={j} className={j === 0 ? "font-medium" : "mt-1 whitespace-pre-wrap text-gray-400"}>
                  {line}
                </p>
              ))}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-white/15 px-4 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50"
            onClick={onCancel}
            disabled={busy}
          >
            Back
          </button>
          <button
            type="button"
            className="rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-medium text-white hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onConfirm}
            disabled={!canApply}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
