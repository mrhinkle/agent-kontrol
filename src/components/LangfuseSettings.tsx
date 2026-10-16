import { langfuseStatusLabel, type LangfuseStatus } from "@/lib/langfuse-config";

const BADGE: Record<LangfuseStatus["state"], { dot: string; text: string; ring: string }> = {
  connected: { dot: "bg-[#2ee6a6]", text: "text-[#2ee6a6]", ring: "ring-[#2ee6a6]/40" },
  not_configured: { dot: "bg-[#3b4559]", text: "text-[#8f98ab]", ring: "ring-[#3b4559]/50" },
  unreachable: { dot: "bg-[#ffb020]", text: "text-[#ffb020]", ring: "ring-[#ffb020]/45" },
};

/**
 * Integrations card for Langfuse. Keys stay in the environment; this card
 * shows whether they are present and links to the project once they are.
 */
export function LangfuseSettings({ status }: { status: LangfuseStatus }) {
  const badge = BADGE[status.state];
  const label = langfuseStatusLabel(status.state);
  return (
    <div className="rounded-xl border border-white/10 bg-[#101828] p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">Langfuse</h3>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 bg-white/5 mono ${badge.ring} ${badge.text}`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
          {label}
        </span>
      </div>
      <p className="text-sm text-gray-400">
        Optional traces for task queue actions, MCP tool calls, and ingest requests. Prompts, message bodies, tool payloads, and secrets are not sent.
      </p>
      {status.state === "connected" && (
        <p className="text-sm text-gray-300">
          Sending traces to {status.projectName ? <span className="text-gray-100">{status.projectName}</span> : "Langfuse"} at{" "}
          <span className="mono text-gray-200">{status.baseUrl}</span>.
        </p>
      )}
      {status.state === "not_configured" && (
        <p className="text-sm text-gray-300">
          Tracing is off. The dashboard and the agents keep working with these variables unset.
        </p>
      )}
      {status.message && <p className="text-sm text-amber-200/90">{status.message}</p>}
      <div className="space-y-2 text-sm text-gray-300">
        <p className="font-medium text-gray-200">Connect</p>
        <ol className="list-decimal space-y-1 pl-5 text-gray-400">
          <li>Create a Langfuse project (Cloud or self-hosted) and create API keys in the project settings.</li>
          <li>
            Set <span className="mono text-gray-200">LANGFUSE_PUBLIC_KEY</span> and <span className="mono text-gray-200">LANGFUSE_SECRET_KEY</span> in
            the environment, then redeploy. Both are required.
          </li>
          <li>
            For a region other than EU, or a self-hosted server, also set <span className="mono text-gray-200">LANGFUSE_BASEURL</span> or{" "}
            <span className="mono text-gray-200">LANGFUSE_HOST</span>. The default is <span className="mono">https://cloud.langfuse.com</span>.
          </li>
        </ol>
      </div>
      <div className="flex flex-wrap gap-3">
        {status.configured && status.projectUrl && (
          <a
            href={status.projectUrl}
            target="_blank"
            rel="noreferrer"
            className="bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-lg px-4 py-2 text-sm font-medium"
          >
            Open Langfuse project
          </a>
        )}
        <a
          href="https://langfuse.com/docs/observability/get-started"
          target="_blank"
          rel="noreferrer"
          className="border border-white/15 rounded-lg px-4 py-2 text-sm text-gray-200 hover:bg-white/5"
        >
          Langfuse setup guide
        </a>
      </div>
    </div>
  );
}
