"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PreviewDialog } from "@/components/PreviewDialog";
import type { DryRunResult } from "@/lib/dry-run";
import {
  ACTIVITY_DAYS_DEFAULT,
  MAX_OWNERS,
  validateOwnerList,
  type OwnerError,
} from "@/lib/owner-validation";

interface OwnerRow {
  owner: string;
  activity_days: number;
  include_forks: boolean;
  include_archived: boolean;
  last_error?: string | null;
  last_error_at?: string | null;
  last_discovered_at?: string | null;
}

interface Loaded {
  writable: boolean;
  max: number;
  version?: string;
  owners: OwnerRow[];
}

const input =
  "w-full bg-[#0a0f1c] border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#2563eb] disabled:opacity-60";
const primary =
  "bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const secondary = "border border-white/15 rounded-lg px-4 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50";

function blank(): OwnerRow {
  return { owner: "", activity_days: ACTIVITY_DAYS_DEFAULT, include_forks: false, include_archived: false };
}

export function OwnerSettings() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<OwnerRow[]>([]);
  const [initial, setInitial] = useState<OwnerRow[]>([]);
  const [errors, setErrors] = useState<OwnerError[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [preview, setPreview] = useState<DryRunResult | null>(null);

  const apply = useCallback((data: Loaded) => {
    setLoaded(data);
    setRows(data.owners.map((row) => ({ ...row })));
    setInitial(data.owners.map((row) => ({ ...row })));
    setErrors([]);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/settings/owners", { cache: "no-store" });
      if (!res.ok) throw new Error(`Could not load owners (${res.status}).`);
      apply((await res.json()) as Loaded);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => JSON.stringify(payloadOf(rows)) !== JSON.stringify(payloadOf(initial)), [rows, initial]);
  const writable = loaded?.writable ?? false;
  const disabled = !writable || saving;
  const max = loaded?.max ?? MAX_OWNERS;

  function edit(index: number, patch: Partial<OwnerRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setErrors([]);
    setMessage(null);
  }

  async function putList(dryRun: boolean) {
    const checked = validateOwnerList(payloadOf(rows));
    if (!checked.ok) {
      setErrors(checked.errors);
      return null;
    }
    const res = await fetch("/api/settings/owners", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owners: payloadOf(rows),
        version: loaded?.version,
        ...(dryRun ? { dry_run: true } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Loaded & {
      error?: string;
      errors?: OwnerError[];
      dry_run?: boolean;
      code?: string;
    };
    return { res, body };
  }

  async function save() {
    setMessage(null);
    const checked = validateOwnerList(payloadOf(rows));
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setSaving(true);
    try {
      const sent = await putList(true);
      if (!sent) return;
      if (sent.res.ok && sent.body.dry_run === true) {
        setPreview(sent.body as unknown as DryRunResult);
        return;
      }
      explain(sent.res, sent.body);
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function confirmSave() {
    setSaving(true);
    setMessage(null);
    try {
      const sent = await putList(false);
      if (!sent) return;
      if (sent.res.ok && sent.body.dry_run !== true) {
        setPreview(null);
        apply(sent.body);
        setMessage({ kind: "ok", text: "Saved. The collector discovers these owners on its next tick." });
      } else {
        setPreview(null);
        explain(sent.res, sent.body);
      }
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  function explain(res: Response, body: { error?: string; errors?: OwnerError[]; code?: string }) {
    if (res.status === 400 && body.errors) setErrors(body.errors);
    else setMessage({ kind: "error", text: body.error ?? `Save failed (${res.status}).` });
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-white/10 bg-[#101828] p-6">
        <p className="text-sm text-red-400">{loadError}</p>
        <button className={`${secondary} mt-3`} onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!loaded) return <p className="text-sm text-gray-400">Loading owners…</p>;

  return (
    <div data-owner-settings className="space-y-4">
      <div className="rounded-lg border border-[#2563eb]/40 bg-[#2563eb]/10 px-3 py-2 text-sm text-blue-100">
        {writable
          ? "Name a GitHub user or organization. The collector adds repos that were pushed inside the activity window. Hide wins over pin."
          : "No database is connected (demo mode), so owners are read-only."}
      </div>
      <div className="rounded-xl border border-white/10 bg-[#101828] p-4 md:p-6">
        <ul className="space-y-4">
          {rows.map((row, index) => {
            const rowErrors = errors.filter((item) => item.index === index);
            return (
              <li key={`${index}-${row.owner}`} className="rounded-lg border border-white/10 p-3">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_120px_auto_auto_auto]">
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-400">Owner</span>
                    <input
                      className={input}
                      value={row.owner}
                      disabled={disabled}
                      placeholder="acme"
                      aria-label={`Owner ${index + 1}`}
                      aria-invalid={rowErrors.some((item) => item.field === "owner")}
                      onChange={(ev) => edit(index, { owner: ev.target.value })}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-400">Activity days</span>
                    <input
                      className={input}
                      type="number"
                      min={1}
                      max={3650}
                      value={row.activity_days}
                      disabled={disabled}
                      aria-label={`Activity days for ${row.owner || `owner ${index + 1}`}`}
                      onChange={(ev) => edit(index, { activity_days: Number(ev.target.value) })}
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      checked={row.include_forks}
                      disabled={disabled}
                      onChange={(ev) => edit(index, { include_forks: ev.target.checked })}
                    />
                    Forks
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      checked={row.include_archived}
                      disabled={disabled}
                      onChange={(ev) => edit(index, { include_archived: ev.target.checked })}
                    />
                    Archived
                  </label>
                  <div className="flex items-end">
                    <button
                      className={secondary}
                      disabled={disabled}
                      aria-label={`Remove ${row.owner || `owner ${index + 1}`}`}
                      onClick={() => {
                        setRows((current) => current.filter((_, i) => i !== index));
                        setErrors([]);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {rowErrors.map((item) => (
                  <p key={`${item.field}-${item.message}`} className="mt-2 text-xs text-red-400">
                    {item.message}
                  </p>
                ))}
                {row.last_error && (
                  <p className="mt-2 text-sm text-red-400" role="alert">
                    Discovery failed: {row.last_error}
                    {row.last_error_at ? ` (${row.last_error_at})` : ""}
                  </p>
                )}
                {row.last_discovered_at && !row.last_error && (
                  <p className="mt-2 text-xs text-gray-500">Last discovered {row.last_discovered_at}.</p>
                )}
              </li>
            );
          })}
        </ul>
        {rows.length === 0 && <p className="text-sm text-gray-400">No owners yet. Add one and the next collector tick fills in its active repos.</p>}
        {errors.some((item) => item.index < 0) && (
          <ul className="mt-3 space-y-1" role="alert">
            {errors
              .filter((item) => item.index < 0)
              .map((item) => (
                <li key={item.message} className="text-sm text-red-400">
                  {item.message}
                </li>
              ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className={secondary} disabled={disabled || rows.length >= max} onClick={() => setRows((current) => [...current, blank()])}>
            + Add owner
          </button>
          <span className="text-xs text-gray-500">
            {rows.length} of {max}
          </span>
          <span className="flex-1" />
          <button className={secondary} disabled={!dirty || saving} onClick={() => apply({ ...loaded, owners: initial })}>
            Discard
          </button>
          <button className={primary} disabled={!writable || !dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save owners"}
          </button>
        </div>
        {message && (
          <p role="status" className={`mt-3 text-sm ${message.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
            {message.text}
          </p>
        )}
      </div>
      {preview && (
        <PreviewDialog
          title="Replace watched owners"
          preview={preview}
          confirmLabel="Replace owners"
          busy={saving}
          onConfirm={() => void confirmSave()}
          onCancel={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function payloadOf(rows: OwnerRow[]) {
  return rows.map((row) => ({
    owner: row.owner,
    activity_days: row.activity_days,
    include_forks: row.include_forks,
    include_archived: row.include_archived,
  }));
}
