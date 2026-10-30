"use client";

import { useCallback, useEffect, useState } from "react";
import { SCOPES, type Scope } from "@/lib/scopes";
import {
  DEFAULT_REQUESTS_PER_DAY,
  DEFAULT_REQUESTS_PER_MINUTE,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MIN,
} from "@/lib/credential-limits";

type Credential = {
  id: string;
  label: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  rate_limit_per_minute: number;
  rate_limit_per_day: number;
};

const input =
  "w-full bg-[#0a0f1c] border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#2563eb]";
const primary =
  "bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50";
const secondary = "border border-white/15 rounded-lg px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50";

const LIMIT_RANGE = `${RATE_LIMIT_MIN} to ${RATE_LIMIT_MAX.toLocaleString("en-US")}`;

/** A whole number in range, or null. "60.5", "", "0" and "1e3" are null. */
function parseLimit(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= RATE_LIMIT_MIN && n <= RATE_LIMIT_MAX ? n : null;
}

function LimitFields({
  idPrefix,
  perMinute,
  perDay,
  onPerMinute,
  onPerDay,
}: {
  idPrefix: string;
  perMinute: string;
  perDay: string;
  onPerMinute: (value: string) => void;
  onPerDay: (value: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block" htmlFor={`${idPrefix}-minute`}>
        <span className="mb-1 block text-xs text-gray-400">Requests per minute</span>
        <input
          id={`${idPrefix}-minute`}
          className={input}
          type="number"
          inputMode="numeric"
          min={RATE_LIMIT_MIN}
          max={RATE_LIMIT_MAX}
          step={1}
          required
          value={perMinute}
          onChange={(e) => onPerMinute(e.target.value)}
        />
        <span className="mt-1 block text-xs text-gray-500">Resets at the start of each clock minute.</span>
      </label>
      <label className="block" htmlFor={`${idPrefix}-day`}>
        <span className="mb-1 block text-xs text-gray-400">Requests per day (UTC)</span>
        <input
          id={`${idPrefix}-day`}
          className={input}
          type="number"
          inputMode="numeric"
          min={RATE_LIMIT_MIN}
          max={RATE_LIMIT_MAX}
          step={1}
          required
          value={perDay}
          onChange={(e) => onPerDay(e.target.value)}
        />
        <span className="mt-1 block text-xs text-gray-500">Resets at 00:00 UTC.</span>
      </label>
    </div>
  );
}

/**
 * Edit one credential's limits. A failed save keeps what the operator typed
 * and shows the error; only a successful save replaces the values.
 */
function LimitEditor({ credential, onSaved }: { credential: Credential; onSaved: (next: Credential) => void }) {
  const [open, setOpen] = useState(false);
  const [perMinute, setPerMinute] = useState(String(credential.rate_limit_per_minute));
  const [perDay, setPerDay] = useState(String(credential.rate_limit_per_day));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start() {
    setPerMinute(String(credential.rate_limit_per_minute));
    setPerDay(String(credential.rate_limit_per_day));
    setError(null);
    setOpen(true);
  }

  async function save() {
    const minute = parseLimit(perMinute);
    const day = parseLimit(perDay);
    if (minute === null || day === null) {
      setError(`Each limit must be a whole number from ${LIMIT_RANGE}.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/credentials", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: credential.id, rate_limit_per_minute: minute, rate_limit_per_day: day }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; credential?: Credential };
      if (!res.ok || !body.credential) {
        setError(body.error ?? `Could not save the limits (${res.status}).`);
        return;
      }
      onSaved(body.credential);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={secondary} onClick={start}>
        Edit limits
      </button>
    );
  }
  return (
    <form
      className="mt-3 w-full space-y-3 rounded-lg border border-white/10 p-3"
      aria-label={`Request limits for ${credential.label}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <LimitFields
        idPrefix={`limits-${credential.id}`}
        perMinute={perMinute}
        perDay={perDay}
        onPerMinute={setPerMinute}
        onPerDay={setPerDay}
      />
      <p className="text-xs text-gray-500">
        Requests already counted this minute and today still count after a change.
      </p>
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button className={primary} type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save limits"}
        </button>
        <button type="button" className={secondary} onClick={() => setOpen(false)} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

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
  const [perMinute, setPerMinute] = useState(String(DEFAULT_REQUESTS_PER_MINUTE));
  const [perDay, setPerDay] = useState(String(DEFAULT_REQUESTS_PER_DAY));
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
    const minute = parseLimit(perMinute);
    const day = parseLimit(perDay);
    if (minute === null || day === null) {
      setFormError(`Each limit must be a whole number from ${LIMIT_RANGE}.`);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          scopes: selected,
          expires_at: expires ? new Date(expires).toISOString() : null,
          rate_limit_per_minute: minute,
          rate_limit_per_day: day,
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
      setPerMinute(String(DEFAULT_REQUESTS_PER_MINUTE));
      setPerDay(String(DEFAULT_REQUESTS_PER_DAY));
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function replaceCredential(next: Credential) {
    setCredentials((current) => current?.map((item) => (item.id === next.id ? next : item)) ?? current);
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
        not store the token. Each credential also has request limits: one request is one HTTP call
        made with the token, including each MCP request. Over a limit, the call answers 429 with
        Retry-After. MC_TOKEN, OAuth sign-ins and this dashboard are not limited.
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
        <LimitFields
          idPrefix="new-credential"
          perMinute={perMinute}
          perDay={perDay}
          onPerMinute={setPerMinute}
          onPerDay={setPerDay}
        />
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
              <p className="mt-1 text-xs text-gray-300">
                {credential.rate_limit_per_minute.toLocaleString()} requests/minute ·{" "}
                {credential.rate_limit_per_day.toLocaleString()} requests/day (resets 00:00 UTC)
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Expires {when(credential.expires_at)} · Last used {when(credential.last_used_at)}
                {credential.revoked_at ? ` · Revoked ${when(credential.revoked_at)}` : ""}
              </p>
              {!credential.revoked_at && (
                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <LimitEditor
                    credential={credential}
                    onSaved={replaceCredential}
                  />
                  <button type="button" className={secondary} onClick={() => void revoke(credential.id)}>
                    Revoke
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
