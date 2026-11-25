"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      window.location.href = "/";
    } else if (res.status === 429) {
      const header = res.headers.get("Retry-After");
      const seconds = header !== null ? Number(header) : Number.NaN;
      setError(
        Number.isFinite(seconds) && seconds > 0
          ? `Too many attempts. Try again in ${seconds} seconds.`
          : "Too many attempts. Try again in a few minutes."
      );
      setBusy(false);
    } else {
      setError("Wrong password.");
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-fg/10 bg-panel p-6">
        <div className="flex items-center gap-2 mb-4">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-error pulse-dot" />
          <span className="font-semibold">Agent Kontrol</span>
        </div>
        <label className="block text-sm text-gray-400 mb-2" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-bg border border-fg/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent mb-3"
        />
        {error && <div className="text-red-400 text-sm mb-3">{error}</div>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink text-sm font-semibold py-2 transition-colors"
        >
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
