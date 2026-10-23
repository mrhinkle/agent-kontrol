"use client";

import { useCallback, useEffect, useState } from "react";
import { SCOPES, type Scope } from "@/lib/scopes";

type Credential = {
  id: string;
  label: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

const input =
  "w-full bg-[#0a0f1c] border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#2563eb]";
const primary =
  "bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50";
const secondary = "border border-white/15 rounded-lg px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50";

function when(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "—";
  return new Date(parsed).toLocaleString();
}

export function CredentialSettings() {
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<Scope[]>([]);
  const [expires, setExpires] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/settings/credentials", { cache: "no-store" });
      if (!res.ok) throw new Error(`Could not load credentials (${res.status}).`);
      const body = (await res.json()) as { credentials?: Credential[] };
      setCredentials(body.credentials ?? []);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(scope: Scope) {
    setSelected((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    );
  }

  async function create() {
    setFormError(null);
    setFreshToken(null);
    setCopied(false);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          scopes: selected,
          expires_at: expires ? new Date(expires).toISOString() : null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        credential?: Credential & { token?: string };
      };
      if (!res.ok || !body.credential?.token) {
        setFormError(body.error ?? `Could not create the credential (${res.status}).`);
        return;
      }
      setFreshToken(body.credential.token);
      setLabel("");
      setSelected([]);
      setExpires("");
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    setFormError(null);
    const res = await fetch("/api/settings/credentials", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setFormError(body.error ?? `Could not revoke (${res.status}).`);
      return;
    }
    await load();
  }

  async function copyToken() {
    if (!freshToken) return;
    try {
      await navigator.clipboard.writeText(freshToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Each credential is a separate bearer token. The token is shown once. Agent Kontrol stores
        the label, an 8-character prefix, a hash of the token, the scopes, and timestamps. It does
        not store the token.
      </p>

      {freshToken && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3" role="status">
          <p className="text-sm text-amber-100">Copy this token now. It will not be shown again.</p>
          <div className="mt-2 flex gap-2">
            <input className={input} readOnly value={freshToken} aria-label="New credential token" />
            <button type="button" className={secondary} onClick={() => void copyToken()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <form
        className="space-y-3 rounded-xl border border-white/10 bg-[#101828] p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-gray-400">Label</span>
          <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="dispatcher on build box" required maxLength={80} />
        </label>
        <fieldset>
          <legend className="mb-2 text-xs text-gray-400">Scopes</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm text-gray-200">
                <input
                  type="checkbox"
                  checked={selected.includes(scope)}
                  onChange={() => toggle(scope)}
                />
                <span className="font-mono text-xs">{scope}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-400">Expires (optional)</span>
          <input className={input} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
        {formError && <p className="text-sm text-red-400">{formError}</p>}
        <button className={primary} type="submit" disabled={saving || selected.length === 0}>
          {saving ? "Creating…" : "Create credential"}
        </button>
      </form>

      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      {!credentials && !loadError && <p className="text-sm text-gray-400">Loading credentials…</p>}
      {credentials && credentials.length === 0 && (
        <p className="text-sm text-gray-400">No credentials yet.</p>
      )}
      {credentials && credentials.length > 0 && (
        <ul className="space-y-2">
          {credentials.map((credential) => (
            <li key={credential.id} className="rounded-xl border border-white/10 bg-[#101828] p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{credential.label}</span>
                <span className="font-mono text-xs text-gray-400">{credential.token_prefix}…</span>
              </div>
              <p className="mt-1 font-mono text-xs text-gray-300">{credential.scopes.join(", ")}</p>
              <p className="mt-1 text-xs text-gray-500">
                Expires {when(credential.expires_at)} · Last used {when(credential.last_used_at)}
                {credential.revoked_at ? ` · Revoked ${when(credential.revoked_at)}` : ""}
              </p>
              {!credential.revoked_at && (
                <button type="button" className={`${secondary} mt-3`} onClick={() => void revoke(credential.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
