"use client";

import { useEffect, useState } from "react";
import { TimeAgo } from "@/components/ui";
import { PreviewDialog } from "@/components/PreviewDialog";
import type { DryRunResult } from "@/lib/dry-run";
import type { MemoryItem } from "@/lib/types";

interface Draft {
  key: string;
  content: string;
  tags: string[];
  agent_id: string | null;
}

export default function MemoryPage() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/memory?query=${encodeURIComponent(query)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const json = await res.json();
        if (controller.signal.aborted) return; // stale response — ignore
        setItems(json.items ?? []);
        setLoaded(true);
      } catch {
        // aborted or network error — keep current results
      }
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, reload]);

  async function postNote(dryRun: boolean, expectedRevision?: string) {
    if (!draft) return null;
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: draft.content,
        key: draft.key,
        tags: draft.tags,
        agent_id: draft.agent_id,
        ...(dryRun ? { dry_run: true } : {}),
        ...(!dryRun && expectedRevision ? { expected_revision: expectedRevision } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<DryRunResult> & {
      error?: string;
      code?: string;
    };
    return { res, body };
  }

  async function requestPreview() {
    if (!draft) return;
    setBusy(true);
    setFormError(null);
    try {
      const sent = await postNote(true);
      if (!sent) return;
      if (sent.res.ok && sent.body.dry_run === true && Array.isArray(sent.body.changes)) {
        setPreview(sent.body as DryRunResult);
      } else {
        setFormError(sent.body.error ?? `Could not preview the overwrite (${sent.res.status}).`);
      }
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmOverwrite() {
    setBusy(true);
    setFormError(null);
    try {
      const sent = await postNote(false, preview?.expected_revision);
      if (!sent) return;
      if (sent.res.status === 409 && sent.body.error === "stale_write") {
        const fresh = await postNote(true);
        if (fresh && fresh.res.ok && fresh.body.dry_run === true && Array.isArray(fresh.body.changes)) {
          setPreview(fresh.body as DryRunResult);
          setFormError("This note changed since the preview. Review the new preview before overwriting.");
          return;
        }
        setFormError(fresh?.body.error ?? "This note changed. Preview it again before overwriting.");
        setPreview(null);
        return;
      }
      if (!sent.res.ok) {
        setFormError(sent.body.error ?? `Overwrite failed (${sent.res.status}).`);
        setPreview(null);
        return;
      }
      setPreview(null);
      setDraft(null);
      setReload((n) => n + 1);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-5">
        <h1 className="text-lg font-semibold">Shared memory</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes…"
          className="bg-[#101828] border border-white/10 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-[#2563eb] w-64"
        />
      </div>

      {formError && <p className="mb-3 text-sm text-red-400">{formError}</p>}

      <div className="grid gap-3">
        {items.map((m) => (
          <div key={m.id} className="rounded-xl border border-white/10 bg-[#101828] p-4">
            <div className="flex items-center gap-3 text-xs text-gray-500 mb-1.5 flex-wrap">
              {m.key && <span className="mono text-[#7aa5ff]">{m.key}</span>}
              {m.tags.map((t) => (
                <span key={t} className="rounded-full bg-white/5 px-2 py-0.5 mono">
                  #{t}
                </span>
              ))}
              <span className="ml-auto">
                {m.agent_id ?? "unknown"} · <TimeAgo iso={m.updated_at} />
              </span>
              {m.key && (
                <button
                  type="button"
                  className="text-[11px] text-gray-500 hover:text-white"
                  onClick={() => {
                    setFormError(null);
                    setPreview(null);
                    setDraft({ key: m.key as string, content: m.content, tags: m.tags, agent_id: m.agent_id });
                  }}
                >
                  Replace
                </button>
              )}
            </div>
            {draft && draft.key === m.key ? (
              <div className="mt-2">
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  className="min-h-24 w-full rounded-lg border border-white/10 bg-[#0a0f1c] px-3 py-2 text-sm text-gray-200 outline-none focus:border-[#2563eb]"
                  aria-label={`Replacement for ${m.key}`}
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-[#2563eb] px-3 py-1.5 text-sm text-white disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void requestPreview()}
                  >
                    Preview overwrite
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-gray-200"
                    onClick={() => setDraft(null)}
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-300 whitespace-pre-wrap">{m.content}</div>
            )}
          </div>
        ))}
        {loaded && items.length === 0 && (
          <div className="text-gray-600 text-sm">
            Nothing here yet. Agents write notes with the <span className="mono">remember</span> MCP tool.
          </div>
        )}
      </div>
      {preview && (
        <PreviewDialog
          title="Overwrite memory"
          preview={preview}
          confirmLabel="Overwrite note"
          busy={busy}
          onConfirm={() => void confirmOverwrite()}
          onCancel={() => setPreview(null)}
        />
      )}
    </div>
  );
}
