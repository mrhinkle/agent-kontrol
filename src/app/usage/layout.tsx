import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Usage and Costs · Mission Control",
  description: "Fleet paid vs Codex shadow usage ledger for Hermes and OpenRouter.",
};

export default function UsageLayout({ children }: { children: React.ReactNode }) {
  return children;
}
