"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { markdownWeight, parseMarkdown, type Block, type Inline } from "@/lib/markdown";

/**
 * Renders task markdown as React elements (never as HTML), so raw HTML in a
 * task body shows as text. See src/lib/markdown.ts for the safety model.
 */
export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className={`md space-y-2 break-words ${className}`}>{blocks.map((b, i) => renderBlock(b, i))}</div>;
}

/** Collapsed preview height in px (Tailwind max-h-36). */
const PREVIEW_PX = 144;

/**
 * Markdown that starts collapsed when it renders taller than the preview, with a
 * Show more / Show less toggle. The decision uses the rendered height (re-measured
 * when the width changes), seeded from the source size to avoid a flash.
 */
export function CollapsibleMarkdown({ source, className = "" }: { source: string; className?: string }) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(() => {
    const w = markdownWeight(source);
    return w.lines > 6 || w.chars > 420;
  });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = content.current;
    if (!el) return;
    // A little slack so a body only slightly taller than the preview isn't hidden behind a toggle.
    const measure = () => setTall(el.scrollHeight > PREVIEW_PX + 24);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [source]);

  return (
    <div>
      <div id={id} className={tall && !open ? "relative max-h-36 overflow-hidden" : undefined}>
        <div ref={content}>
          <Markdown source={source} className={className} />
        </div>
        {tall && !open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#101828] to-transparent" />}
      </div>
      {tall && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-xs text-gray-500 underline-offset-2 hover:text-gray-200 hover:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "heading": {
      const cls = ["", "text-base font-semibold text-gray-100", "text-sm font-semibold text-gray-100", "text-sm font-semibold text-gray-200", "text-xs font-semibold uppercase tracking-wider text-gray-400"][b.level];
      const kids = renderInlines(b.c);
      if (b.level === 1) return <h3 key={key} className={cls}>{kids}</h3>;
      if (b.level === 2) return <h4 key={key} className={cls}>{kids}</h4>;
      if (b.level === 3) return <h5 key={key} className={cls}>{kids}</h5>;
      return <h6 key={key} className={cls}>{kids}</h6>;
    }
    case "p":
      return <p key={key}>{renderInlines(b.c)}</p>;
    case "code":
      return (
        <pre key={key} className="overflow-x-auto rounded-md border border-white/10 bg-black/40 px-3 py-2 text-[12px] leading-relaxed text-gray-200">
          <code className="mono" data-lang={b.lang ?? undefined}>
            {b.v}
          </code>
        </pre>
      );
    case "quote":
      return (
        <blockquote key={key} className="space-y-2 border-l-2 border-white/15 pl-3 text-gray-400">
          {b.c.map((c, i) => renderBlock(c, i))}
        </blockquote>
      );
    case "text":
      return (
        <p key={key} className="whitespace-pre-wrap">
          {b.v}
        </p>
      );
    case "hr":
      return <hr key={key} className="border-white/10" />;
    case "list": {
      const items = b.items.map((it, i) => (
        <li key={i} className={it.checked === null ? undefined : "flex list-none items-start gap-2 -ml-5"}>
          {it.checked !== null && (
            <input type="checkbox" checked={it.checked} readOnly disabled aria-label={it.checked ? "done" : "not done"} className="mt-1 accent-[#2ee6a6]" />
          )}
          <span className="min-w-0">
            {renderInlines(it.c)}
            {it.children.length > 0 && <div className="mt-0.5 space-y-1">{it.children.map((c, j) => renderBlock(c, j))}</div>}
          </span>
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start} className="list-decimal space-y-0.5 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-0.5 pl-5">
          {items}
        </ul>
      );
    }
  }
}

function renderInlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="mono rounded bg-white/10 px-1 py-px text-[0.9em] text-gray-100">
            {n.v}
          </code>
        );
      case "strong":
        return <strong key={i} className="font-semibold text-gray-100">{renderInlines(n.c)}</strong>;
      case "em":
        return <em key={i}>{renderInlines(n.c)}</em>;
      case "del":
        return <del key={i}>{renderInlines(n.c)}</del>;
      case "link": {
        const external = /^(https?:|mailto:)/i.test(n.href);
        return (
          <a
            key={i}
            href={n.href}
            className="text-[#8be6ff] underline decoration-[#8be6ff]/40 underline-offset-2 hover:decoration-[#8be6ff]"
            {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
          >
            {renderInlines(n.c)}
          </a>
        );
      }
    }
  });
}
