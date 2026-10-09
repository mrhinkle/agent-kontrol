import type { Metadata } from "next";
import Link from "next/link";
import { MCLogoConsole } from "@/components/MCLogo";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mission Control",
  description: "One dashboard for every agent in the fleet — status, history, and shared memory.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const name = process.env.NEXT_PUBLIC_MC_NAME ?? "Mission Control";
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-white/10 sticky top-0 z-10 backdrop-blur bg-[#0a0f1c]/80">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 md:flex-nowrap md:py-3">
            <Link href="/" className="group flex shrink-0 items-center gap-2 py-1 md:py-0">
              <MCLogoConsole className="h-6 w-6 text-gray-200 transition-colors group-hover:text-white" />
              <span className="font-semibold tracking-wide">{name}</span>
            </Link>
            <SiteNav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 py-8 text-xs text-gray-600">
          Agents push, nobody polls. Connect an agent via the MCP server at <span className="mono">/api/mcp</span> or POST to <span className="mono">/api/ingest</span>.
        </footer>
      </body>
    </html>
  );
}
