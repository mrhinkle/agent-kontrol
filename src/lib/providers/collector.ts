/** Shared CLI mechanics. Collection is read-only until an explicit publish action. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ProviderUsageBatch } from "./types";
import { jsonRequest, nonnegative, record } from "./transport";

const CONFIG_NAMES = new Set(["MC_URL", "MC_TOKEN", "MC_OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_MANAGEMENT_KEY", "MC_ANTHROPIC_ADMIN_KEY", "ANTHROPIC_ADMIN_KEY"]);
export function literalConfig(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("Invalid literal configuration line");
    if (!CONFIG_NAMES.has(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function loadConfig(file?: string) {
  const values = file ? literalConfig(readFileSync(file, "utf8")) : {};
  for (const name of CONFIG_NAMES) if (process.env[name]) values[name] = process.env[name]!;
  return values;
}

export function fleetOrigin(raw: string, allowLoopback = false): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("MC_URL must be an origin-only HTTPS URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (allowLoopback && loopback && url.protocol === "http:"))) {
    throw new Error("MC_URL must be an origin-only HTTPS URL (explicit loopback test opt-in required for HTTP)");
  }
  return url.origin;
}

export function validateReceipt(value: unknown, expected: number): void {
  const receipt = record(value);
  if (receipt.ok !== true || receipt.demo === true || receipt.written !== expected) throw new Error("Fleet did not confirm the complete non-demo import");
}

export async function publishBatch(batch: ProviderUsageBatch, origin: string, token: string): Promise<void> {
  if (!token) throw new Error("MC_TOKEN is required to publish");
  const result = await jsonRequest(`${origin}/api/usage/ingest`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "cost-collection-v1", collected_at: batch.snapshot?.collected_at ?? new Date().toISOString(), ...batch }),
  });
  validateReceipt(result, batch.facts.length);
}

export function privateOutput(path: string, payload: unknown): void {
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

export function subscriptionFee(value: unknown, now = new Date()): ProviderUsageBatch {
  const row = record(value);
  const keys = ["invoice_id", "paid_at", "amount_usd", "currency"];
  if (Object.keys(row).some((key) => !keys.includes(key)) || keys.some((key) => !(key in row))) throw new Error("Fee requires only invoice_id, paid_at, amount_usd and currency");
  if (typeof row.invoice_id !== "string" || !row.invoice_id.trim() || row.invoice_id.length > 256 || row.currency !== "USD" ||
      typeof row.paid_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.paid_at) || !Number.isFinite(Date.parse(row.paid_at)) || Date.parse(row.paid_at) > now.getTime()) throw new Error("Invalid USD fee identity or payment date");
  const amount = nonnegative(row.amount_usd);
  const paidAt = new Date(row.paid_at).toISOString();
  return { facts: [{ source: "subscription_fee", account_id: "claude-subscription", model: "subscription", billing_provider: "anthropic", billing_mode: "subscription",
    session_id: `claude-fee:${createHash("sha256").update(row.invoice_id).digest("hex")}`,
    paid_cost_usd: amount, shadow_cost_usd: 0, cost_status: "recorded_fee", first_seen_at: paidAt, last_seen_at: paidAt,
    detail: { currency: "USD", basis: "operator_recorded_payment" },
  }] };
}
