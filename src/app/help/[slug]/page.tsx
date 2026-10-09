import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { HELP_DOCS, loadDoc } from "@/lib/help-docs";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return HELP_DOCS.map((d) => ({ slug: d.slug }));
}

export default async function HelpDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const loaded = loadDoc(slug);
  if (!loaded) notFound();
  const { doc, source } = loaded;
  return (
    <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Help topics" className="text-sm lg:sticky lg:top-4 lg:self-start">
        <Link href="/help" className="mb-2 block text-xs uppercase tracking-wider text-gray-500 hover:text-gray-300">
          All topics
        </Link>
        <ul className="space-y-0.5">
          {HELP_DOCS.map((d) => (
            <li key={d.slug}>
              <Link
                href={`/help/${d.slug}`}
                aria-current={d.slug === slug ? "page" : undefined}
                className={`block rounded px-2 py-1 ${d.slug === slug ? "bg-white/10 text-white" : "text-gray-400 hover:text-gray-200"}`}
              >
                {d.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className="min-w-0">
        <h1 className="mb-3 text-xl font-semibold">{doc.title}</h1>
        <Markdown source={source} className="text-sm text-gray-300" />
        <p className="mt-6 text-xs text-gray-500">
          Source:{" "}
          <a className="underline" href={`https://github.com/mrhinkle/mission-control/blob/main/${doc.file}`}>
            {doc.file}
          </a>
        </p>
      </article>
    </div>
  );
}
