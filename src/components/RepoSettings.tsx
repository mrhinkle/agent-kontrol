"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MAX_REPOS, validateRepoList, type RepoError, type RepoInput } from "@/lib/repo-validation";
import { fromRepos, groupErrors, isDirty, moveRow, newRow, toPayload, type Row } from "@/lib/repo-settings-helpers";

interface Loaded {
  source: "database" | "file";
  writable: boolean;
  max: number;
  repos: RepoInput[];
}

const input =
  "w-full bg-[#0a0f1c] border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#2563eb] disabled:opacity-60";
const primary =
  "bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const secondary = "border border-white/15 rounded-lg px-4 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50";
const iconBtn = "rounded-md border border-white/10 px-2 py-1 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-30";
const GRID = "md:grid md:grid-cols-[72px_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_130px_minmax(0,1.2fr)_52px] md:items-start md:gap-3";

export function RepoSettings() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initial, setInitial] = useState<RepoInput[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<RepoError[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const apply = useCallback((data: Loaded) => {
    setLoaded(data);
    setInitial(data.repos);
    setRows(fromRepos(data.repos));
    setAttempted(false);
    setServerErrors([]);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/settings/repos", { cache: "no-store" });
      if (!res.ok) throw new Error(`Could not load settings (${res.status}).`);
      apply((await res.json()) as Loaded);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => isDirty(initial, rows), [initial, rows]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const clientCheck = useMemo(() => validateRepoList(toPayload(rows)), [rows]);
  const errors = attempted ? (clientCheck.ok ? serverErrors : clientCheck.errors) : serverErrors;
  const grouped = useMemo(() => groupErrors(errors), [errors]);
  const writable = loaded?.writable ?? false;
  const max = loaded?.max ?? MAX_REPOS;

  function edit(id: string, patch: Partial<RepoInput>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setMessage(null);
    setServerErrors([]);
  }

  function reorder(from: number, to: number) {
    setRows((rs) => moveRow(rs, from, to));
    setMessage(null);
  }

  async function save() {
    setAttempted(true);
    setMessage(null);
    if (!validateRepoList(toPayload(rows)).ok) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings/repos", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos: toPayload(rows) }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Loaded> & { errors?: RepoError[]; error?: string };
      if (res.ok) {
        apply(body as Loaded);
        setMessage({ kind: "ok", text: "Saved. The collector picks this up within 15 minutes." });
      } else if (res.status === 400 && body.errors) {
        setServerErrors(body.errors);
      } else {
        setMessage({ kind: "error", text: body.error ?? `Save failed (${res.status}).` });
      }
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-white/10 bg-[#101828] p-6">
        <p className="text-red-400 text-sm">{loadError}</p>
        <button className={`${secondary} mt-3`} onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!loaded) return <p className="text-sm text-gray-400">Loading settings…</p>;

  const banner = !writable
    ? "No database is connected (demo mode), so this list is read-only."
    : loaded.source === "database"
      ? `Using the list stored in the database. ${loaded.repos.length} ${loaded.repos.length === 1 ? "repo" : "repos"}. The collector reads this list each tick.`
      : "Using the built-in list from progress.config.json. Save to store your own list in the database.";

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[#2563eb]/40 bg-[#2563eb]/10 px-3 py-2 text-sm text-blue-100">{banner}</div>

      <div className="rounded-xl border border-white/10 bg-[#101828] p-4 md:p-6">
        <div className={`hidden ${GRID} mb-2 text-[11px] uppercase tracking-wider text-gray-500`}>
          <span>Order</span>
          <span>Repo (owner/name)</span>
          <span>Label</span>
          <span>Short</span>
          <span>Color</span>
          <span>Blocked label</span>
          <span>Remove</span>
        </div>

        <ul className="space-y-3">
          {rows.map((r, i) => {
            const e = grouped.rows[i] ?? {};
            const name = r.repo || `row ${i + 1}`;
            return (
              <li key={r.id} className={`rounded-lg border border-white/10 p-3 md:border-0 md:p-0 ${GRID}`}>
                <div className="mb-2 flex gap-1 md:mb-0">
                  <button className={iconBtn} onClick={() => reorder(i, i - 1)} disabled={!writable || i === 0} aria-label={`Move ${name} up`}>
                    ↑
                  </button>
                  <button className={iconBtn} onClick={() => reorder(i, i + 1)} disabled={!writable || i === rows.length - 1} aria-label={`Move ${name} down`}>
                    ↓
                  </button>
                </div>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Repo (owner/name)</span>
                  <input className={input} value={r.repo} disabled={!writable} placeholder="acme/app" onChange={(ev) => edit(r.id, { repo: ev.target.value })} aria-label={`Repo for row ${i + 1}`} aria-invalid={!!e.repo} />
                  {e.repo && <span className="mt-1 block text-xs text-red-400">{e.repo}</span>}
                </label>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Label</span>
                  <input className={input} value={r.label} disabled={!writable} placeholder="App" onChange={(ev) => edit(r.id, { label: ev.target.value })} aria-label={`Label for ${name}`} aria-invalid={!!e.label} />
                  {e.label && <span className="mt-1 block text-xs text-red-400">{e.label}</span>}
                </label>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Short</span>
                  <input className={input} value={r.short} disabled={!writable} placeholder="app" onChange={(ev) => edit(r.id, { short: ev.target.value })} aria-label={`Short name for ${name}`} aria-invalid={!!e.short} />
                  {e.short && <span className="mt-1 block text-xs text-red-400">{e.short}</span>}
                </label>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Color</span>
                  <span className="flex items-center gap-2">
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : "#2563eb"}
                      disabled={!writable}
                      onChange={(ev) => edit(r.id, { color: ev.target.value })}
                      className="h-9 w-10 cursor-pointer rounded-md border border-white/10 bg-transparent p-0.5 disabled:opacity-60"
                      aria-label={`Color for ${name}`}
                    />
                    <span className="mono text-xs text-gray-400">{r.color}</span>
                  </span>
                  {e.color && <span className="mt-1 block text-xs text-red-400">{e.color}</span>}
                </label>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Blocked label</span>
                  <input
                    className={input}
                    value={r.blockedLabel ?? ""}
                    disabled={!writable}
                    placeholder="none tracked"
                    onChange={(ev) => edit(r.id, { blockedLabel: ev.target.value === "" ? null : ev.target.value })}
                    aria-label={`Blocked label for ${name}`}
                    aria-invalid={!!e.blockedLabel}
                  />
                  {e.blockedLabel && <span className="mt-1 block text-xs text-red-400">{e.blockedLabel}</span>}
                </label>
                <div>
                  <button
                    className={iconBtn}
                    disabled={!writable}
                    aria-label={`Remove ${name}`}
                    onClick={() => {
                      setRows((rs) => rs.filter((x) => x.id !== r.id));
                      setMessage(null);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        {rows.length === 0 && <p className="text-sm text-gray-400">No repos yet. Add one to start.</p>}

        {grouped.list.length > 0 && (
          <ul className="mt-3 space-y-1" role="alert">
            {grouped.list.map((m) => (
              <li key={m} className="text-sm text-red-400">
                {m}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className={secondary} disabled={!writable || rows.length >= max} onClick={() => setRows((rs) => [...rs, newRow(rs.length)])}>
            + Add repo
          </button>
          <span className="text-xs text-gray-500">
            {rows.length} of {max}
          </span>
          <span className="flex-1" />
          <button className={secondary} disabled={!dirty || saving} onClick={() => apply({ ...loaded, repos: initial })}>
            Discard
          </button>
          <button className={primary} disabled={!writable || !dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {message && (
          <p role="status" className={`mt-3 text-sm ${message.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
