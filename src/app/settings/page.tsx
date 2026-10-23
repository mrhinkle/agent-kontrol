import { CredentialSettings } from "@/components/CredentialSettings";
import { RepoSettings } from "@/components/RepoSettings";

export const metadata = { title: "Settings · Agent Kontrol" };

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-gray-400">Configure what Agent Kontrol watches, and the credentials agents use.</p>
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
          <h2 className="text-base font-semibold">Agent credentials</h2>
          <p className="text-sm text-gray-400">
            A revocable token per agent. Scopes are enforced on MCP tools and on the agent REST routes.
          </p>
        </div>
        <CredentialSettings />
      </section>
    </div>
  );
}
