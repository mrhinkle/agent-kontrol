"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS, isActive } from "@/lib/nav";

/**
 * Main navigation. On narrow screens it drops to its own row and scrolls
 * sideways (links never wrap or squash); edge fades show when more links are
 * off-screen. The current page is marked with aria-current and kept in view.
 */
export function SiteNav() {
  const pathname = usePathname() ?? "/";
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);

  useEffect(() => {
    // Keep the current page's link visible when the row is scrolled.
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !active) return;
    const left = active.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft || left + active.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, left - 16);
    }
  }, [pathname]);

  return (
    <nav aria-label="Main" className="relative -mx-4 w-[calc(100%+2rem)] md:mx-0 md:w-auto">
      <div ref={ref} className="no-scrollbar flex items-center gap-1 overflow-x-auto px-3 text-sm md:overflow-visible md:px-0">
        {NAV_LINKS.map((l) => {
          const active = isActive(pathname, l.href);
          const tone = l.accent
            ? active
              ? "text-[#19d2ff]"
              : "text-[#19d2ff]/80 hover:text-[#19d2ff]"
            : active
              ? "text-white"
              : "text-gray-400 hover:text-white";
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap rounded-md px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#19d2ff]/70 md:py-0.5 ${l.accent ? "mono" : ""} ${tone} ${
                active ? "bg-white/[0.06]" : ""
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
      {edges.left && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[#0a0f1c] to-transparent md:hidden" />}
      {edges.right && <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[#0a0f1c] to-transparent md:hidden" />}
    </nav>
  );
}
