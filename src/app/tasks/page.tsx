"use client";

import { useCallback, useEffect, useState } from "react";
import { DemoBanner, PlatformBadge, TaskStatusChip, TimeAgo } from "@/components/ui";
import { CollapsibleMarkdown } from "@/components/Markdown";
import type { Task } from "@/lib/types";

const PLATFORMS = ["any", "claude-code", "codex", "grok", "hermes", "cowork-cloud"];
const REVIEWERS = ["", "codex", "claude-code", "grok"];

function NewTaskForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState("");
  const [platform, setPlatform] = useState("any");
  const [reviewer, setReviewer] = useState("");
  const [priority, setPriority] = useState(2);
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");

  async function submit() {
    if (!title.trim()) return;
    setState("sending");
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          project: project.trim() || undefined,
          platform,
          priority,
          reviewer_platform: reviewer || undefined,
          created_by: "dashboard",
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setTitle("");
      setDescription("");
      setProject("");
      setState("idle");
      onCreated();
    } catch {
      setState("error");
    }
  }

  const input =
    "bg-[#0a0f1c] border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#2563eb] w-full";

  return (
    <div className="rounded-xl border border-white/10 bg-[#101828] p-4 mb-6">
      <div className="text-sm font-semibold mb-3">Queue a task</div>
      <div className="grid gap-3">
        <input className={input} placeholder="Title — e.g. Fix the broken subscribe form on example.com"
          value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className={`${input} min-h-20`} placeholder="Instructions (becomes the worker's prompt). Be specific: files, acceptance criteria, what done looks like."
          value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-4">
          <input className={input} placeholder="Project (repo folder)" value={project}
            onChange={(e) => setProject(e.target.value)} />
          <select className={input} value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>run on: {p}</option>
            ))}
          </select>
          <select className={input} value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
            {REVIEWERS.map((r) => (
              <option key={r} value={r}>{r ? `review by: ${r}` : "no review"}</option>
            ))}
          </select>
          <select className={input} value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            <option value={1}>priority: high</option>
            <option value={2}>priority: normal</option>
            <option value={3}>priority: low</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={submit} disabled={state === "sending" || !title.trim()}
            className="text-sm px-4 py-2 rounded-lg bg-[#f44800] hover:bg-[#ff5a10] disabled:opacity-40 text-white font-semibold transition-colors">
            {state === "sending" ? "Queuing…" : "Queue task"}
          </button>
          {state === "error" && <span className="text-red-400 text-xs">Failed — try again.</span>}
        </div>
      </div>
    </div>
  );
}

function TaskRow({ t, onAction }: { t: Task; onAction: () => void }) {
  const open = ["queued", "claimed", "running", "review"].includes(t.status);

  async function patch(body: Record<string, unknown>) {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onAction();
  }

  return (
    <div className="rounded-xl border border-white/10 bg-[#101828] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium flex items-center gap-2 flex-wrap">
            <span className="text-gray-500 mono text-xs">#{t.id}</span>
            {t.title}
            {t.priority === 1 && <span className="text-[11px] mono text-[#ff7a40]">HIGH</span>}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 flex-wrap">
            <PlatformBadge platform={t.platform} />
            {t.project && <span className="mono text-[#7aa5ff]">{t.project}</span>}
            {t.reviewer_platform && <span>review: {t.reviewer_platform}</span>}
            {t.assigned_agent && <span className="mono">{t.assigned_agent}</span>}
            {t.cost_usd != null && <span className="mono">${Number(t.cost_usd).toFixed(2)}</span>}
            <span>updated <TimeAgo iso={t.updated_at} /></span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <TaskStatusChip status={t.status} />
          {open && (
            <button onClick={() => patch({ status: "cancelled" })}
              className="text-[11px] text-gray-500 hover:text-red-400 transition-colors" title="Cancel">
              ✕
            </button>
          )}
          {(t.status === "failed" || t.status === "cancelled") && (
            <button onClick={() => patch({ status: "queued" })}
              className="text-[11px] text-gray-500 hover:text-white transition-colors" title="Requeue">
              ↻
            </button>
          )}
        </div>
      </div>
      {t.description && (
        <div className="mt-2">
          <CollapsibleMarkdown source={t.description} className="text-sm leading-relaxed text-gray-400" />
        </div>
      )}
      {t.result && (
        <div className={`mt-2 flex gap-2 border-l-2 pl-3 ${t.status === "failed" ? "border-red-500/50" : "border-white/10"}`}>
          <span className="mono shrink-0 pt-[3px] text-[10px] uppercase tracking-wider text-gray-500">Result</span>
          <div className="min-w-0 flex-1">
            <CollapsibleMarkdown source={t.result} className="text-sm leading-relaxed text-gray-300" />
          </div>
        </div>
      )}
    </div>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?status=all&limit=100", { cache: "no-store" });
      if (!res.ok) throw new Error(`tasks API ${res.status}`);
      const json = (await res.json()) as { demo?: boolean; tasks: Task[] };
      setTasks(json.tasks);
      setDemo(Boolean(json.demo));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 7000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="text-red-400 text-sm">Failed to load tasks: {error}</div>;
  if (!tasks) return <div className="text-gray-500 text-sm animate-pulse">Loading the queue…</div>;

  const open = tasks.filter((t) => ["queued", "claimed", "running", "review"].includes(t.status));
  const closed = tasks.filter((t) => !["queued", "claimed", "running", "review"].includes(t.status));

  return (
    <div>
      {demo && <DemoBanner />}
      <div className="flex items-center gap-6 mb-5">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <div className="text-sm text-gray-500">
          <span className="text-gray-200 font-semibold">{open.length}</span> open ·{" "}
          {closed.length} closed
        </div>
      </div>

      <NewTaskForm onCreated={load} />

      <div className="grid gap-3">
        {open.map((t) => (
          <TaskRow key={t.id} t={t} onAction={load} />
        ))}
        {open.length === 0 && (
          <div className="text-gray-500 text-sm">
            Nothing queued. Add a task above — a dispatcher will pick it up, or any MCP-connected
            agent can claim it with <span className="mono">claim_task</span>.
          </div>
        )}
      </div>

      {closed.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-gray-400 mt-10 mb-2 uppercase tracking-wider">Recently closed</h2>
          <div className="grid gap-3">
            {closed.slice(0, 20).map((t) => (
              <TaskRow key={t.id} t={t} onAction={load} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
