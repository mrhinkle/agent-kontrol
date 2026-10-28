import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One header grammar for every panel: title, count, optional controls, and a
 * link to the full page on the right. Learn it once, read it everywhere.
 */
export function PanelHeader({
  title,
  count,
  href,
  hrefLabel = "View all",
  className = "",
  children,
}: {
  title: string;
  count?: number;
  href?: string;
  hrefLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
        {title}
        {typeof count === "number" && <span className="mono ml-2 text-xs font-normal text-gray-600">{count}</span>}
      </h2>
      {children}
      {href && (
        <Link href={href} className="ml-auto text-xs text-gray-500 transition-colors hover:text-gray-200">
          {hrefLabel} →
        </Link>
      )}
    </div>
  );
}
