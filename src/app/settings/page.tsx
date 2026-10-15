import { LangfuseSettings } from "@/components/LangfuseSettings";
import { RepoSettings } from "@/components/RepoSettings";
import { getLangfuseStatus } from "@/lib/langfuse-config";

export const metadata = { title: "Settings · Agent Kontrol" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const langfuse = await getLangfuseStatus();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-gray-400">Configure what Agent Kontrol watches, and optional integrations.</p>
      </div>
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Watched repos</h2>
          <p className="text-sm text-gray-400">The repos on the progress board. Changes apply to the board now.</p>
        </div>
        <RepoSettings />
        <p className="text-xs text-gray-500">Reading from GitHub is done by the collector, never by this page.</p>
      </section>
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Integrations</h2>
          <p className="text-sm text-gray-400">Observability you can turn on with environment variables. Nothing here is stored in the database.</p>
        </div>
        <LangfuseSettings status={langfuse} />
      </section>
    </div>
  );
}
