import type { Metadata } from "next";
import Link from "next/link";
import { Inter } from "next/font/google";
import { AgentKontrolMark } from "@/components/AgentKontrolMark";
import { SiteNav } from "@/components/SiteNav";
import { AttentionStrip } from "@/components/AttentionStrip";
import { THEME_BOOT_SCRIPT, ThemeToggle } from "@/components/ThemeToggle";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Agent Kontrol",
  description: "One control room for every AI coding agent you run: status, history, tasks, and a net-backlog progress board.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const name = process.env.NEXT_PUBLIC_MC_NAME ?? "Agent Kontrol";
  // The byline and trademark notice belong to the default product name only.
  const branded = process.env.NEXT_PUBLIC_MC_NAME === undefined;
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen">
        <header className="border-b border-fg/10 sticky top-0 z-10 bg-bg">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2">
            <Link href="/" className="group flex shrink-0 items-center gap-2 py-1 md:py-0">
              <AgentKontrolMark className="h-6 w-6 text-gray-200 transition-colors group-hover:text-fg" />
              <span className="font-semibold tracking-wide">{name}</span>
              {branded && <span className="hidden text-xs text-gray-500 sm:inline">by The AIE</span>}
            </Link>
            {/* Two rows: wordmark and attention strip on top, nav below. The strip
                shares the top row from sm up and takes its own row on a phone. */}
            <div className="flex min-w-0 basis-full items-center gap-3 py-0.5 sm:ml-auto sm:basis-auto">
              <div className="min-w-0 flex-1">
                <AttentionStrip />
              </div>
              <ThemeToggle />
            </div>
            <SiteNav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 py-8 text-xs text-gray-600">
          Agents push, nobody polls. Connect an agent via the MCP server at <span className="mono">/api/mcp</span> or POST to <span className="mono">/api/ingest</span>.
          {branded && (
            <p className="mt-2">
              Agent Kontrol&trade; by <a className="underline" href="https://theaie.net">The AIE Network</a>&trade;. &copy; 2026 Mark Hinkle and The AIE Network. Agent Kontrol is a trademark of Mark Hinkle. The AIE Network is a trademark of Peripety Labs LLC.
            </p>
          )}
        </footer>
      </body>
    </html>
  );
}
