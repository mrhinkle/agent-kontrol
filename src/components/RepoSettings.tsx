"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DryRunResult } from "@/lib/dry-run";
import { MAX_REPOS, validateRepoList, type RepoError, type RepoInput } from "@/lib/repo-validation";
import { fromRepos, groupErrors, isDirty, moveRow, newRow, preserveDirtyRows, splitWatchedRepos, toPayload, type Row } from "@/lib/repo-settings-helpers";
import { PreviewDialog } from "@/components/PreviewDialog";

interface ListedRepo extends RepoInput {
  gone?: boolean;
  shown?: boolean;
  fieldsOverridden?: boolean | null;
}

interface Loaded {
  source: "database" | "file";
  writable: boolean;
  max: number;
  version?: string;
  repos: ListedRepo[];
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
  const [autoRepos, setAutoRepos] = useState<ListedRepo[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<RepoError[]>([]);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [preview, setPreview] = useState<DryRunResult | null>(null);

  const apply = useCallback((data: Loaded) => {
    const split = splitWatchedRepos(data.repos);
    setLoaded(data);
    setAutoRepos(split.discovered);
    setInitial(split.editable);
    setRows(fromRepos(split.editable));
    setAttempted(false);
    setServerErrors([]);
    setStale(false);
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

  const draftRef = useRef<Row[]>(rows);
  draftRef.current = rows;
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

  // beforeunload does not fire for in-app navigation, so also confirm before following a link away.
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!window.confirm("You have unsaved changes. Leave this page and lose them?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", guard, true);
    return () => document.removeEventListener("click", guard, true);
  }, [dirty]);

  const hasAuto = loaded?.repos.some((repo) => repo.origin === "auto") ?? false;
  const clientCheck = useMemo(() => {
    if (rows.length === 0 && hasAuto) return { ok: true as const, errors: [] as RepoError[] };
    return validateRepoList(toPayload(rows));
  }, [rows, hasAuto]);
  const errors = attempted ? (clientCheck.ok ? serverErrors : clientCheck.errors) : serverErrors;
  const grouped = useMemo(() => groupErrors(errors), [errors]);
  const writable = loaded?.writable ?? false;
  const disabled = !writable || saving;
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

  type SaveBody = Partial<Loaded> & { errors?: RepoError[]; error?: string; dry_run?: boolean };

  function explainSave(res: Response, body: SaveBody) {
    if (res.status === 400 && body.errors) {
      setServerErrors(body.errors);
    } else if (res.status === 409 && (body as { code?: string }).code === "stale") {
      setMessage({ kind: "error", text: body.error ?? "The list changed elsewhere. Reload and try again." });
      setStale(true);
    } else {
      setMessage({ kind: "error", text: body.error ?? `Save failed (${res.status}).` });
    }
  }

  async function putList(dryRun: boolean) {
    const res = await fetch("/api/settings/repos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repos: toPayload(rows),
        version: loaded?.version,
        ...(dryRun ? { dry_run: true } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as SaveBody;
    return { res, body };
  }

  async function save() {
    setAttempted(true);
    setMessage(null);
    const payload = toPayload(rows);
    const allowEmpty = rows.length === 0 && hasAuto;
    if (!allowEmpty && !validateRepoList(payload).ok) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-repo-settings] [aria-invalid='true']")?.focus());
      return;
    }
    setSaving(true);
    try {
      const { res, body } = await putList(true);
      if (res.ok && body.dry_run === true) {
        setPreview(body as DryRunResult);
        return;
      }
      explainSave(res, body);
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
      const { res, body } = await putList(false);
      if (res.ok) {
        setPreview(null);
        apply(body as Loaded);
        setMessage({ kind: "ok", text: "Saved. The collector picks this up within 15 minutes." });
      } else {
        setPreview(null);
        explainSave(res, body);
      }
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function setOverride(repo: string, patch: { pinned?: boolean; hidden?: boolean }) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/repos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, ...patch }),
      });
      const body = (await res.json().catch(() => ({}))) as SaveBody;
      if (res.ok && body.dry_run !== true) {
        const data = body as Loaded;
        const split = splitWatchedRepos(data.repos);
        const dirtyNow = isDirty(initial, draftRef.current);
        setLoaded(data);
        setAutoRepos(split.discovered);
        setInitial(split.editable);
        setRows((current) => (
          isDirty(initial, current) ? preserveDirtyRows(current, split.editable) : fromRepos(split.editable)
        ));
        if (!dirtyNow) {
          setAttempted(false);
          setServerErrors([]);
          setStale(false);
        }
        return;
      }
      explainSave(res, body);
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

      {autoRepos.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[#101828] p-4 md:p-6">
          <h3 className="text-sm font-medium text-gray-200">Discovered</h3>
          <p className="mt-1 text-xs text-gray-500">
            These stay collected. Pin keeps a quiet repo on the brief. Hide wins over pin. A repo marked gone is not shown, including when it is pinned.
          </p>
          <ul className="mt-3 space-y-2">
            {autoRepos.map((repo) => {
              const pinned = repo.pinned === true;
              const hidden = repo.hidden === true;
              return (
                <li key={repo.repo} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 px-3 py-2 text-sm">
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">auto</span>
                  <span className="mono text-gray-100">{repo.repo}</span>
                  <span className="text-gray-400">{repo.label}</span>
                  {repo.gone && <span className="text-xs text-amber-300">gone</span>}
                  {repo.shown === false && !repo.gone && <span className="text-xs text-gray-500">off the brief</span>}
                  <label className="ml-auto flex items-center gap-1 text-xs text-gray-300">
                    <input
                      type="checkbox"
                      checked={pinned}
                      disabled={disabled}
                      aria-label={`Pin ${repo.repo}`}
                      onChange={(ev) => void setOverride(repo.repo, { pinned: ev.target.checked })}
                    />
                    Pin
                  </label>
                  <label className="flex items-center gap-1 text-xs text-gray-300">
                    <input
                      type="checkbox"
                      checked={hidden}
                      disabled={disabled}
                      aria-label={`Hide ${repo.repo}`}
                      onChange={(ev) => void setOverride(repo.repo, { hidden: ev.target.checked })}
                    />
                    Hide
                  </label>
                  {pinned && hidden && <span className="text-xs text-amber-300">Hide wins, so this repo stays off the brief.</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div data-repo-settings className="rounded-xl border border-white/10 bg-[#101828] p-4 md:p-6">
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
                  <button className={iconBtn} onClick={() => reorder(i, i - 1)} disabled={disabled || i === 0} aria-label={`Move ${name} up`}>
                    ↑
                  </button>
                  <button className={iconBtn} onClick={() => reorder(i, i + 1)} disabled={disabled || i === rows.length - 1} aria-label={`Move ${name} down`}>
                    ↓
                  </button>
                </div>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Repo (owner/name)</span>
                  <input className={input} value={r.repo} disabled={disabled} placeholder="acme/app" onChange={(ev) => edit(r.id, { repo: ev.target.value })} aria-label={`Repo for row ${i + 1}`} aria-invalid={!!e.repo} aria-describedby={e.repo ? `${r.id}-repo-err` : undefined} />
                  {r.origin === "auto" && (
                    <span className="mt-1 block text-xs text-gray-500">
                      Discovered. Removing this row clears the label, short, color, and blocked-label override. Pin and hide remain.
                    </span>
                  )}
                  {e.repo && <span id={`${r.id}-repo-err`} className="mt-1 block text-xs text-red-400">{e.repo}</span>}
                </label>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Label</span>
                  <input className={input} value={r.label} disabled={disabled} placeholder="App" onChange={(ev) => edit(r.id, { label: ev.target.value })} aria-label={`Label for ${name}`} aria-invalid={!!e.label} aria-describedby={e.label ? `${r.id}-label-err` : undefined} />
                  {e.label && <span id={`${r.id}-label-err`} className="mt-1 block text-xs text-red-400">{e.label}</span>}
                </label>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Short</span>
                  <input className={input} value={r.short} disabled={disabled} placeholder="app" onChange={(ev) => edit(r.id, { short: ev.target.value })} aria-label={`Short name for ${name}`} aria-invalid={!!e.short} aria-describedby={e.short ? `${r.id}-short-err` : undefined} />
                  {e.short && <span id={`${r.id}-short-err`} className="mt-1 block text-xs text-red-400">{e.short}</span>}
                </label>
                <label className="mb-2 block md:mb-0">
                  <span className="mb-1 block text-xs text-gray-400 md:sr-only">Color</span>
                  <span className="flex items-center gap-2">
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : "#2563eb"}
                      disabled={disabled}
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
                    disabled={disabled}
                    placeholder="none tracked"
                    onChange={(ev) => edit(r.id, { blockedLabel: ev.target.value === "" ? null : ev.target.value })}
                    aria-label={`Blocked label for ${name}`}
                    aria-invalid={!!e.blockedLabel}
                    aria-describedby={e.blockedLabel ? `${r.id}-blocked-err` : undefined}
                  />
                  {e.blockedLabel && <span id={`${r.id}-blocked-err`} className="mt-1 block text-xs text-red-400">{e.blockedLabel}</span>}
                </label>
                <div>
                  {r.origin === "auto" && (
                    <span className="mb-2 flex flex-wrap gap-2 text-xs text-gray-300 md:mb-1">
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={r.pinned === true}
                          disabled={disabled}
                          aria-label={`Pin ${r.repo}`}
                          onChange={(ev) => void setOverride(r.repo, { pinned: ev.target.checked })}
                        />
                        Pin
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={r.hidden === true}
                          disabled={disabled}
                          aria-label={`Hide ${r.repo}`}
                          onChange={(ev) => void setOverride(r.repo, { hidden: ev.target.checked })}
                        />
                        Hide
                      </label>
                    </span>
                  )}
                  <button
                    className={iconBtn}
                    disabled={disabled}
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

        {rows.length === 0 && (
          <p className="text-sm text-gray-400">
            {hasAuto ? "No hand-added repos. Discovered repos stay tracked." : "No repos yet. Add one to start."}
          </p>
        )}

        {attempted && errors.length > 0 && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {errors.length} {errors.length === 1 ? "problem" : "problems"} to fix before saving.
          </p>
        )}

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
          <button className={secondary} disabled={disabled || rows.length >= max} onClick={() => setRows((rs) => [...rs, newRow(rs.length)])}>
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

        {stale && (
          <button className={`${secondary} mt-3`} onClick={() => void load()}>
            Reload the latest list
          </button>
        )}

        {message && (
          <p role="status" className={`mt-3 text-sm ${message.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
            {message.text}
          </p>
        )}
      </div>
      {preview && (
        <PreviewDialog
          title="Replace watched repos"
          preview={preview}
          confirmLabel="Replace list"
          busy={saving}
          onConfirm={() => void confirmSave()}
          onCancel={() => setPreview(null)}
        />
      )}
    </div>
  );
}
