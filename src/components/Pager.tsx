"use client";

import type { Page } from "@/lib/history";

/** "1–10 of 37  ‹ Prev  2 / 4  Next ›". Renders nothing when everything fits on one page. */
export function Pager<T>({ page, onPage, noun }: { page: Page<T>; onPage: (p: number) => void; noun: string }) {
  if (page.pages <= 1) return null;
  const btn =
    "rounded-md border border-white/10 px-2.5 py-1 text-xs text-gray-300 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <nav className="mt-3 flex items-center justify-between gap-3 text-xs text-gray-500" aria-label={`${noun} pages`}>
      <span>
        {page.from}–{page.to} of {page.total} {noun}
      </span>
      <span className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>
          ‹ Newer
        </button>
        <span className="mono" aria-live="polite">
          {page.page} / {page.pages}
        </span>
        <button type="button" className={btn} disabled={page.page >= page.pages} onClick={() => onPage(page.page + 1)}>
          Older ›
        </button>
      </span>
    </nav>
  );
}
