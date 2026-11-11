"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SortableTable } from "@/components/SortableTable";
import { distribution, localDate, parseVelocity, summarizeVelocity, VELOCITY_MAX_BYTES, type VelocityPoint, type VelocityRepo, type VelocityResponse, type VelocitySnapshot, type VelocitySummary } from "@/lib/velocity";

const number = (v: number | null | undefined, digits = 0) => v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const percent = (v: number | null | undefined) => v == null ? "—" : `${number(v * 100, 1)}%`;
const dateLabel = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const control = "rounded-lg border border-white/15 bg-[#101828] px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40";

function Panel({ title, note, children, className = "" }: { title: string; note?: string; children: React.ReactNode; className?: string }) {
  return <section className={`min-w-0 rounded-xl border border-white/10 bg-[#101828] ${className}`}>
    <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 px-5 py-3">
      <h2 className="mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-300">{title}</h2>
      {note && <span className="text-xs text-gray-400">{note}</span>}
    </header><div className="p-5">{children}</div>
  </section>;
}
function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-w-0"><p className="text-sm text-gray-400">{label}</p><p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-white">{value}</p><p className="mt-2 text-xs leading-relaxed text-gray-400">{detail}</p></div>;
}

function Throughput({ summary }: { summary: VelocitySummary }) {
  const days = summary.prs?.daily ?? [];
  if (!days.length) return <p className="text-sm text-gray-400">No dated PR evidence in this capture.</p>;
  const max = Math.max(1, ...days.flatMap((d) => [d.opened, d.merged]));
  const width = 900, height = 170, step = width / days.length;
  return <>
    <div className="mb-3 flex flex-wrap gap-4 text-xs text-gray-300"><span><i className="mr-2 inline-block h-2 w-2 rounded-sm bg-cyan-400" />Merged PRs</span><span><i className="mr-2 inline-block h-2 w-2 rounded-sm bg-orange-300" />Opened PRs</span><span className="ml-auto text-gray-400">Daily counts · peak {max}</span></div>
    <svg viewBox={`0 0 ${width} ${height + 30}`} className="w-full" role="img" aria-label="Daily opened and merged pull requests. Exact values are in the daily counts table.">
      {[0, 0.5, 1].map((n) => <line key={n} x1="0" x2={width} y1={height * n} y2={height * n} stroke="white" strokeOpacity="0.08" />)}
      {days.map((d, i) => <g key={d.date}><title>{d.date}: {d.merged} merged, {d.opened} opened</title>
        <rect x={i * step + step * .14} y={height - d.merged / max * (height - 8)} width={Math.max(1, step * .32)} height={d.merged / max * (height - 8)} rx="2" fill="#22d3ee" />
        <rect x={i * step + step * .51} y={height - d.opened / max * (height - 8)} width={Math.max(1, step * .32)} height={d.opened / max * (height - 8)} rx="2" fill="#fdba74" opacity="0.8" />
        {(i === 0 || i === days.length - 1 || (i % Math.max(1, Math.floor(days.length / 5)) === 0 && i < days.length - 2)) && <text x={i * step + step / 2} y={height + 23} fill="#9ca3af" fontSize="11" textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}>{dateLabel(d.date)}</text>}
      </g>)}
    </svg>
    <details className="mt-3 text-xs text-gray-400"><summary className="cursor-pointer hover:text-white">View exact daily counts</summary><div className="mt-3">
      <SortableTable caption="Exact daily counts" rows={days} rowKey={(d) => d.date} initialSort={{ column: "date", direction: "ascending" }} columns={[
        { id: "date", label: "Date", value: (d) => Date.parse(d.date), render: (d) => d.date, width: "50%" },
        { id: "opened", label: "Opened", value: (d) => d.opened, render: (d) => d.opened, defaultDirection: "descending" },
        { id: "merged", label: "Merged", value: (d) => d.merged, render: (d) => d.merged, defaultDirection: "descending" },
      ]} />
    </div></details>
  </>;
}

function BenchmarkTrend({ points, baseline, latest, preview }: { points: VelocityPoint[]; baseline: VelocityPoint | null; latest: VelocityPoint | null; preview: boolean }) {
  const [metric, setMetric] = useState<"revisions" | "firstPass" | "cycle">("revisions");
  const value = (p: VelocityPoint) => metric === "revisions" ? p.summary.ci?.revisions.mean : metric === "firstPass" ? p.summary.ci?.firstPassRate : p.summary.prs?.mergeHours.median;
  const usable = points.filter((p) => value(p) != null);
  const max = Math.max(1, ...usable.map((p) => value(p)!));
  const x = (i: number) => 32 + i * 836 / Math.max(points.length - 1, 1);
  const y = (v: number) => 150 - v / max * 130;
  const sameCoverage = baseline && latest && baseline.inventoryKey === latest.inventoryKey;
  const delta = sameCoverage && value(baseline!) != null && value(latest!) != null ? value(latest!)! - value(baseline!)! : null;
  const format = (v: number | null | undefined) => metric === "firstPass" ? percent(v) : number(v, 2);
  return <>
    <label className="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-400">Compare captures
      <select aria-label="Benchmark trend metric" className={control} value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}><option value="revisions">CI revisions to green</option><option value="firstPass">First-pass rate</option><option value="cycle">Median merge hours</option></select>
    </label>
    {preview || usable.length < 2 ? <div className="my-6 rounded-lg border border-dashed border-white/15 p-6 text-center"><p className="text-lg font-medium text-gray-200">{preview ? "Capture preview" : "Baseline recorded. History starts here."}</p><p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-gray-400">{preview ? "This file shows one measurement period. Save it to compare it with compatible captures already on the dashboard." : "A trend needs at least two comparable captures. Daily snapshots will build this chart without inventing past CI results."}</p></div>
      : <svg viewBox="0 0 900 188" className="mt-4 w-full" role="img" aria-label={`${metric} across comparable captures; gaps indicate changed coverage.`}>
        {[20, 85, 150].map((n) => <line key={n} x1="32" x2="868" y1={n} y2={n} stroke="white" strokeOpacity=".08" />)}
        {points.map((p, i) => {
          const v = value(p), prev = points[i - 1], pv = prev && value(prev);
          return v == null ? null : <g key={p.id}><title>{dateLabel(p.windowEnd)}: {format(v)} · {p.summary.repositories} repositories · {p.captureKind}</title>
            {prev && pv != null && prev.inventoryKey === p.inventoryKey && <line x1={x(i - 1)} y1={y(pv)} x2={x(i)} y2={y(v)} stroke="#22d3ee" strokeWidth="2.5" />}
            <circle cx={x(i)} cy={y(v)} r="4" fill={p.captureKind === "reconstructed" ? "#fdba74" : "#22d3ee"} />
            {(i === 0 || i === points.length - 1) && <text x={x(i)} y="180" textAnchor={i === 0 ? "start" : "end"} fill="#9ca3af" fontSize="11">{dateLabel(p.windowEnd)}</text>}
          </g>;
        })}
        <text x="32" y="12" fill="#9ca3af" fontSize="11">{format(max)}</text>
      </svg>}
    {!preview && baseline && latest && <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-gray-400"><span>Baseline {format(value(baseline))}</span><span>Latest {format(value(latest))}</span><span>{baseline.id === latest.id ? "First capture" : !sameCoverage ? "Coverage changed · delta withheld" : delta == null ? "Delta unavailable" : `Change ${delta > 0 ? "+" : ""}${metric === "firstPass" ? `${number(delta * 100, 1)} percentage points` : number(delta, 2)}`}</span></div>}
    {points.length > 1 && <details className="mt-4 text-xs text-gray-400"><summary className="cursor-pointer">Capture history and sample sizes</summary><div className="mt-3">
      <SortableTable caption="Capture history and sample sizes" rows={points} rowKey={(p) => p.id} initialSort={{ column: "date", direction: "ascending" }} columns={[
        { id: "date", label: "Window end (exclusive)", value: (p) => Date.parse(p.windowEnd), render: (p) => p.windowEnd, width: "30%" },
        { id: "value", label: "Value", value, render: (p) => format(value(p)), defaultDirection: "descending", width: "16%" },
        { id: "ci", label: "CI green / covered", value: (p) => p.summary.ci ? [p.summary.ci.green, p.summary.ci.covered] : null, render: (p) => `${p.summary.ci?.green ?? "—"} / ${p.summary.ci?.covered ?? "—"}`, defaultDirection: "descending", describedBy: "history-ci-sort", width: "22%" },
        { id: "repos", label: "Repos", value: (p) => p.summary.repositories, render: (p) => p.summary.repositories, defaultDirection: "descending", width: "12%" },
        { id: "source", label: "Source", value: (p) => p.captureKind, render: (p) => p.captureKind, width: "20%" },
      ]} />
      <p id="history-ci-sort" className="mt-3">CI green / covered sorts by observed-green PRs, then by PRs with CI evidence.</p>
    </div></details>}
  </>;
}

function RepositoryTable({ rows }: { rows: VelocityRepo[] }) {
  const [query, setQuery] = useState(""), [owner, setOwner] = useState("all"), [view, setView] = useState("all");
  const owners = [...new Set(rows.map((r) => r.repo.split("/")[0]))].sort();
  const prepared = useMemo(() => rows.map((r) => ({ ...r,
    revisions: distribution(r.ci?.revisionSamples ?? []).mean,
    mergeHours: distribution(r.prs?.mergeHours ?? []).median,
    evidence: Object.values(r.coverage).some((c) => c !== "complete") ? "Partial / missing" : r.ci?.covered ? "CI observed" : r.prs?.opened ? "No PR CI" : "No new PRs",
  })), [rows]);
  const shown = useMemo(() => prepared.filter((r) => r.repo.includes(query.toLowerCase()) && (owner === "all" || r.repo.startsWith(`${owner}/`)) && (view === "all" || (view === "active" && r.prs && (r.prs.opened + r.prs.merged > 0)) || (view === "archived" && r.archived) || (view === "forks" && r.fork))), [prepared, query, owner, view]);
  return <>
    <div className="mb-4 grid gap-3 sm:grid-cols-3">
      <input className={control} aria-label="Search repositories" placeholder="Search repositories…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select className={control} aria-label="Repository owner" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="all">All owners</option>{owners.map((o) => <option key={o}>{o}</option>)}</select>
      <select className={control} aria-label="Repository activity" value={view} onChange={(e) => setView(e.target.value)}><option value="all">All repositories</option><option value="active">PR activity in window</option><option value="archived">Archived</option><option value="forks">Forks</option></select>
    </div>
    <p className="mb-3 text-xs text-gray-400">{shown.length} of {rows.length} repositories · filters affect this table; fleet totals above keep the full scope.</p>
    <div className="rounded-lg border border-white/10"><SortableTable caption="All repositories" rows={shown} rowKey={(r) => r.repo} initialSort={{ column: "merged", direction: "descending" }} columns={[
      { id: "repo", label: "Repository", value: (r) => r.repo, width: "28%", render: (r) => <><a className="font-medium text-gray-100 hover:text-cyan-300" href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer">{r.repo}</a><div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-wide text-gray-400">{r.archived && <span>Archived</span>}{r.fork && <span>Fork</span>}</div></> },
      { id: "opened", label: "Opened", value: (r) => r.prs?.opened, render: (r) => number(r.prs?.opened), defaultDirection: "descending", width: "9%" },
      { id: "merged", label: "Merged", value: (r) => r.prs?.merged, render: (r) => number(r.prs?.merged), defaultDirection: "descending", width: "9%" },
      { id: "revisions", label: "CI revisions¹", value: (r) => r.revisions, render: (r) => number(r.revisions, 2), defaultDirection: "descending", width: "12%" },
      { id: "ci", label: "Green / CI", value: (r) => r.ci ? [r.ci.revisionSamples.length, r.ci.covered] : null, render: (r) => r.ci ? `${r.ci.revisionSamples.length} / ${r.ci.covered}` : "—", defaultDirection: "descending", describedBy: "repository-ci-sort", width: "12%" },
      { id: "hours", label: "Merge hours²", value: (r) => r.mergeHours, render: (r) => number(r.mergeHours, 2), defaultDirection: "descending", width: "12%" },
      { id: "evidence", label: "Evidence", value: (r) => r.evidence, render: (r) => <span className={r.evidence === "Partial / missing" ? "text-orange-300" : "text-gray-400"}>{r.evidence}</span>, width: "18%" },
    ]} /></div>
    {shown.length === 0 && <p className="py-6 text-center text-gray-400">No repositories match these filters.</p>}
    <p className="mt-3 text-xs leading-relaxed text-gray-400">¹ Mean CI-submitted revisions among PRs with observed green. ² Median hours from PR creation to merge. A dash means no measured sample, not zero effort.</p>
    <p id="repository-ci-sort" className="mt-2 text-xs text-gray-400">Green / CI sorts by observed-green PRs, then by PRs with CI evidence. Click any header to sort; click it again to reverse. Missing values stay last.</p>
  </>;
}

export default function VelocityPage() {
  const [data, setData] = useState<VelocityResponse | null>(null), [seriesKey, setSeriesKey] = useState(""), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<VelocitySnapshot | null>(null), [notice, setNotice] = useState<string | null>(null), [saving, setSaving] = useState(false), [refresh, setRefresh] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const abort = new AbortController(); let alive = true;
    async function load() {
      try {
        const res = await fetch(`/api/velocity${seriesKey ? `?series=${seriesKey}` : ""}`, { cache: "no-store", signal: abort.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Benchmark history could not be loaded.");
        if (alive) { setData(body); setError(null); }
      } catch (e) { if (alive && !(e instanceof Error && e.name === "AbortError")) { setError(e instanceof Error ? e.message : "Benchmark history could not be loaded."); setData(null); } }
      finally { if (alive) setLoading(false); }
    }
    void load(); const timer = setInterval(load, 120_000);
    return () => { alive = false; abort.abort(); clearInterval(timer); };
  }, [seriesKey, refresh]);
  const snapshot = preview ?? data?.latest?.snapshot;
  const summary = useMemo(() => snapshot ? summarizeVelocity(snapshot) : null, [snapshot]);
  const previewFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try { if (file.size > VELOCITY_MAX_BYTES) throw new Error("Capture exceeds the 2 MB limit."); setPreview(parseVelocity(JSON.parse(await file.text()))); setNotice(null); }
    catch (e) { setNotice(e instanceof Error ? e.message.slice(0, 240) : "Invalid capture file."); }
    if (fileRef.current) fileRef.current.value = "";
  }, []);
  async function save() {
    if (!preview) return; setSaving(true); setNotice(null);
    try {
      const res = await fetch("/api/velocity/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(preview) });
      const body = await res.json(); if (!res.ok) throw new Error(body.error ?? "Capture could not be saved.");
      setNotice(`${body.duplicate ? "Already recorded" : "Capture saved"} · receipt ${body.id}`); setPreview(null); setSeriesKey(body.scopeKey); setRefresh((n) => n + 1);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Capture could not be saved."); }
    finally { setSaving(false); }
  }
  const lastDate = snapshot ? localDate(new Date(Date.parse(snapshot.window.end) - 1).toISOString(), snapshot.window.timezone) : "";
  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="mono text-xs uppercase tracking-[.18em] text-cyan-300">Development intelligence</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Velocity</h1><p className="mt-2 text-sm text-gray-400">Every repository. Measured delivery. A benchmark that lasts.</p></div>
      <div className="flex flex-wrap gap-2"><button className={control} onClick={() => setRefresh((n) => n + 1)}>Refresh</button><button className={control} onClick={() => fileRef.current?.click()}>Preview capture</button><input ref={fileRef} className="hidden" type="file" accept="application/json,.json" aria-label="Benchmark capture file" onChange={(e) => void previewFile(e.target.files?.[0])} /></div>
    </header>
    {notice && <p role="status" className="break-all rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-4 py-3 text-sm text-cyan-100">{notice}</p>}
    {preview && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-orange-300/30 bg-orange-300/5 p-4"><div><p className="font-medium text-orange-200">Local preview · this capture has not been saved</p><p className="mt-1 text-xs text-gray-400">The file stays in this page until you save it. Closing this view discards the preview.</p></div><div className="flex gap-2"><button className={control} disabled={saving} onClick={() => setPreview(null)}>Close preview</button><button className={control} disabled={saving || !data || !!error} onClick={() => void save()}>{saving ? "Saving…" : "Save to dashboard"}</button></div></div>}
    {error && <p role="alert" className="rounded-lg border border-white/10 p-4 text-sm text-gray-400">{error} You can still inspect a local capture with Preview capture.</p>}
    {loading && !snapshot && <p className="py-16 text-center text-gray-400">Loading benchmark history…</p>}
    {!loading && !snapshot && !error && <Panel title="Ready for the first capture"><p className="text-gray-300">No benchmark has been recorded yet.</p><p className="mt-2 text-sm text-gray-400">Preview a validated capture, then save it to establish the baseline. Daily captures will extend the history.</p></Panel>}
    {snapshot && summary && <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 px-4 py-3"><div className="text-sm text-gray-300"><span className="font-medium text-white">{snapshot.scope.owners.join(" + ")}</span><span className="mx-3 text-gray-600">/</span>{dateLabel(localDate(snapshot.window.start, snapshot.window.timezone))} – {dateLabel(lastDate)}<span className="ml-2 text-gray-400">{snapshot.window.days} complete days</span></div>
        {!preview && data && data.series.length > 1 && <select className={control} aria-label="Benchmark series" value={data.selectedKey ?? ""} onChange={(e) => { setLoading(true); setSeriesKey(e.target.value); }}>{data.series.map((s) => <option key={s.key} value={s.key}>{s.owners.join(" + ")} · {s.days} days · {s.timezone}</option>)}</select>}
        <span className="text-xs text-gray-400">{snapshot.window.timezone} · {snapshot.captureKind === "reconstructed" ? "Reconstructed from historical evidence" : "Recorded capture"}</span>
      </div>
      <div className="grid gap-5 lg:grid-cols-5">
        <section className="relative overflow-hidden rounded-xl border border-cyan-400/25 bg-[#101e2b] p-6 lg:col-span-3"><div className="absolute inset-y-0 left-0 w-1 bg-cyan-400" /><p className="text-sm font-medium text-cyan-200">CI-submitted revisions to first green</p><div className="mt-4 flex flex-wrap items-end gap-5"><p className="text-6xl font-semibold tracking-tight tabular-nums text-white">{number(summary.ci?.revisions.mean, 2)}</p><p className="pb-1 text-sm leading-relaxed text-gray-300">average revisions<br /><span className="text-gray-400">among {number(summary.ci?.green)} observed-green PRs</span></p></div><div className="mt-6 flex flex-wrap gap-x-8 gap-y-2 border-t border-white/10 pt-4 text-sm"><span className="text-gray-400">Median <b className="ml-2 font-medium text-white">{number(summary.ci?.revisions.median, 1)}</b></span><span className="text-gray-400">90th percentile <b className="ml-2 font-medium text-white">{number(summary.ci?.revisions.p90, 1)}</b></span></div><p className="mt-3 text-xs leading-relaxed text-gray-400">Parallel workflows count as one revision. Repeat executions on the same revision are reported separately below.</p></section>
        <Panel title="Evidence coverage" note={`${summary.repositories} repositories`} className="lg:col-span-2"><div className="space-y-4"><div><p className="text-3xl font-semibold tabular-nums">{number(summary.ci?.covered)} <span className="text-sm font-normal text-gray-400">PRs with CI evidence</span></p><p className="mt-2 text-sm text-gray-400">{number(summary.ci?.noGreen)} without observed green · {number(summary.ci?.noCI)} without PR-triggered Actions</p></div><div className="h-2 overflow-hidden rounded bg-white/5"><div className="h-full rounded bg-cyan-400" style={{ width: `${summary.ci?.covered ? summary.ci.green / summary.ci.covered * 100 : 0}%` }} /></div><p className="text-xs leading-relaxed text-gray-400">{summary.coverage.complete}/{summary.repositories} repos have complete collection across PR, CI and deployment streams. {snapshot.inventoryComplete ? "Owner inventory is complete." : "Owner inventory is incomplete."}</p></div></Panel>
      </div>
      <Panel title="Delivery benchmark" note="Full repository scope"><div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4"><Stat label="PRs merged" value={number(summary.prs?.merged)} detail={`${number(summary.prs?.opened)} opened in this window`} /><Stat label="Median time to merge" value={`${number(summary.prs?.mergeHours.median, 2)} h`} detail={`90th percentile ${number(summary.prs?.mergeHours.p90, 2)} h · ${number(summary.prs?.mergeHours.n)} merged PRs`} /><Stat label="First pass, no repeat" value={percent(summary.ci?.firstPassRate)} detail={`${number(summary.ci?.firstPass)} / ${number(summary.ci?.covered)} PRs with CI evidence`} /><Stat label="Current open PRs" value={number(summary.prs?.openCurrent)} detail="Retrieved backlog snapshot; not a historical window-end count" /></div></Panel>
      <Panel title="Daily delivery trend" note={`${summary.active} repositories with PR activity`}><Throughput summary={summary} /></Panel>
      <Panel title="Benchmark trend" note={data?.historyLimited ? "Latest 120 periods · original baseline retained" : "Matching scope, method and period length"}><BenchmarkTrend points={data?.history ?? []} baseline={data?.baseline ?? null} latest={data?.latest ?? null} preview={!!preview} /></Panel>
      <div className="grid gap-5 lg:grid-cols-2"><Panel title="Repeat CI executions"><div className="grid grid-cols-2 gap-5"><Stat label="GitHub reruns" value={number(summary.ci?.reruns)} detail="Additional attempts on existing workflow runs" /><Stat label="Fresh runs, same revision" value={number(summary.ci?.sameShaRepeats)} detail="New execution IDs for an unchanged SHA and workflow" /></div><p className="mt-5 text-xs text-gray-400">Counts cover the full created-PR cohort, including repeats after its first green.</p></Panel><Panel title="Deployment records to success"><div className="grid grid-cols-2 gap-5">{(["production", "preview"] as const).map((kind) => <Stat key={kind} label={kind === "production" ? "Production" : "Preview"} value={number(summary.cd?.[kind].turns.mean, 2)} detail={`${number(summary.cd?.[kind].turns.n)} successful / ${number(summary.cd?.[kind].targets)} observed targets`} />)}</div><p className="mt-5 text-xs leading-relaxed text-gray-400">GitHub-recorded deployment targets, grouped by repository, SHA and exact environment. Provider-internal retries are not visible.</p></Panel></div>
      <Panel title="All repositories" note={`${summary.archived} archived · ${summary.forks} forks`}><RepositoryTable rows={snapshot.repositories} /></Panel>
      <details className="rounded-xl border border-white/10 p-5 text-sm text-gray-400"><summary className="cursor-pointer font-medium text-gray-300">Method, provenance and limits</summary><div className="mt-4 space-y-3 text-xs leading-relaxed"><p>CI uses PRs created during the reporting window. A green observation requires the latest governing attempt to succeed for every workflow observed across that PR’s lifetime. This conservative Actions measure does not prove historical required-check eligibility; external checks, push-only workflows and agent conversation turns are outside it. Revisions cancelled or superseded still count as submitted work.</p><p>Means and percentiles pool individual observations. CI averages include only observed successes; no-green and no-CI cohorts stay visible. Throughput and merge time use PRs merged in the window, including those opened earlier. Rolling captures overlap and must not be added together for weekly totals.</p><p>Inventory and collection coverage changes break trend lines and suppress baseline deltas. Orange trend points mark reconstructed captures. The baseline is the first server-recorded capture for the selected series; later imports never overwrite it.</p><p>Captured {new Date(snapshot.capturedAt).toLocaleString()} · method {snapshot.metricVersion} · collector {snapshot.source.collectorVersion}</p><p className="break-all">Source artifact SHA-256: {snapshot.source.artifactSha256}</p><p className="break-all">Evidence manifest SHA-256: {snapshot.source.evidenceSha256}</p>{!preview && data?.latest && <p className="break-all">Capture receipt: {data.latest.id} · baseline: {data.baseline?.id}</p>}</div></details>
    </>}
  </div>;
}
