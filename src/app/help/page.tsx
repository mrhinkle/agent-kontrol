import Link from "next/link";
import { HELP_DOCS } from "@/lib/help-docs";

export const dynamic = "force-static";

export const metadata = { title: "Help · Agent Kontrol" };

export default function HelpIndex() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Help</h1>
        <p className="mt-1 text-sm text-gray-400">
          The project documentation, inside the app. The same files live in the{" "}
          <a className="underline" href="https://github.com/mrhinkle/agent-kontrol/tree/main/docs">
            repository
          </a>
          .
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {HELP_DOCS.map((d) => (
          <li key={d.slug}>
            <Link href={`/help/${d.slug}`} className="block rounded-xl border border-white/10 bg-[#101828] p-4 hover:border-white/25">
              <div className="font-semibold">{d.title}</div>
              <div className="mt-1 text-sm text-gray-400">{d.blurb}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
