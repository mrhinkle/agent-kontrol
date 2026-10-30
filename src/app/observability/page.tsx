import type { Metadata } from "next";
import Link from "next/link";
import { langfuseStatus } from "@/lib/langfuse-config";
import { runMetrics } from "@/lib/run-store";
import { RunDashboard } from "@/components/RunDashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Langfuse · Mission Control" };

export default async function ObservabilityPage() {
  const metricsPromise = runMetrics().catch(() => null);
  const status = langfuseStatus();
  const ready = status.state === "ready";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Langfuse</h1>
          <p className="mt-2 max-w-2xl text-sm text-gray-400">Run traces, reported model usage, runtime, and errors.</p>
        </div>
        {status.projectUrl && (
          <a href={status.projectUrl} target="_blank" rel="noopener noreferrer" className="rounded-md border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]">
            Open Langfuse project ↗
          </a>
        )}
      </div>
      <section className="rounded-xl border border-white/10 bg-[#101828] p-5" aria-labelledby="export-status">
        <h2 id="export-status" className="font-medium text-gray-200">
          {ready ? "Event export configured" : status.state === "incomplete" ? "Setup incomplete" : "Event export disabled"}
        </h2>
        <p className="mt-2 text-sm text-gray-400">
          {ready
            ? "New session activity is queued for Langfuse after Mission Control saves each event. Delivery has not been verified here; check the project for incoming fleet events."
            : "Langfuse is not receiving events from this deployment. Connect a project and enable event export to start collecting new activity."}
        </p>
        {ready && !status.projectUrl && <p className="mt-2 text-sm text-gray-400">A Langfuse project link has not been set.</p>}
      </section>
      <RunDashboard metrics={await metricsPromise} />
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-white/10 bg-[#101828] p-5">
          <h2 className="font-medium text-gray-200">Activity traces</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">New session starts, turns, milestones, waiting states, completions, and errors become timestamped events in Langfuse. Events share a hashed session reference. Routine heartbeats are excluded.</p>
          <Link href="/history" className="mt-4 inline-block text-sm text-[#19d2ff] hover:underline">View fleet history →</Link>
        </section>
        <section className="rounded-xl border border-white/10 bg-[#101828] p-5">
          <h2 className="font-medium text-gray-200">Model usage</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">Completed dispatcher runs carry measured runtime, outcomes, and available per-model token totals. Langfuse receives a run span and model-total metadata. Individual model calls and request latency need native agent instrumentation.</p>
          <Link href="/usage" className="mt-4 inline-block text-sm text-[#19d2ff] hover:underline">View usage and costs →</Link>
        </section>
      </div>
      <p className="max-w-3xl text-xs leading-relaxed text-gray-400">Export includes event kind, platform, timestamp, event ID, and hashed agent and session references. Prompts, replies, task text, raw errors, project names, and machine names stay out of Langfuse. Export is best effort; historical events are not backfilled.</p>
    </div>
  );
}
