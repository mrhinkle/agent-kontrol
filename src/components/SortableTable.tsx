"use client";

import { useMemo, useState, type ReactNode } from "react";

type Direction = "ascending" | "descending";
type SortValue = string | number | readonly number[] | null | undefined;
export type SortColumn<T> = {
  id: string;
  label: string;
  value: (row: T) => SortValue;
  render: (row: T) => ReactNode;
  width?: string;
  defaultDirection?: Direction;
  describedBy?: string;
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const missing = (value: SortValue) => value == null ||
  (typeof value === "number" && !Number.isFinite(value)) ||
  (Array.isArray(value) && value.some((n) => !Number.isFinite(n)));

function compare(a: SortValue, b: SortValue): number {
  const left = typeof a === "string" || typeof a === "number" ? [a] : a!;
  const right = typeof b === "string" || typeof b === "number" ? [b] : b!;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const av = left[i], bv = right[i];
    const difference = typeof av === "number" && typeof bv === "number" ? av - bv : collator.compare(String(av), String(bv));
    if (difference) return difference;
  }
  return left.length - right.length;
}

export function SortableTable<T>({ caption, rows, columns, rowKey, initialSort, className = "" }: {
  caption: string;
  rows: readonly T[];
  columns: readonly SortColumn<T>[];
  rowKey: (row: T) => string;
  initialSort: { column: string; direction: Direction };
  className?: string;
}) {
  const [sort, setSort] = useState(initialSort);
  const shown = useMemo(() => {
    const column = columns.find((c) => c.id === sort.column);
    if (!column) return rows;
    return rows.map((row, index) => ({ row, index, value: column.value(row) }))
      .sort((a, b) => {
        const am = missing(a.value), bm = missing(b.value);
        if (am !== bm) return am ? 1 : -1;
        const difference = am ? 0 : compare(a.value, b.value) * (sort.direction === "ascending" ? 1 : -1);
        return difference || a.index - b.index;
      }).map(({ row }) => row);
  }, [rows, columns, sort]);

  return <table className={`w-full table-fixed text-left text-[11px] [overflow-wrap:anywhere] sm:text-sm ${className}`}>
    <caption className="sr-only">{caption}</caption>
    <colgroup>{columns.map((c) => <col key={c.id} style={c.width ? { width: c.width } : undefined} />)}</colgroup>
    <thead className="bg-[#162132] text-[10px] text-gray-300 sm:text-xs"><tr>{columns.map((column) => {
      const active = sort.column === column.id;
      const next = active ? (sort.direction === "ascending" ? "descending" : "ascending") : column.defaultDirection ?? "ascending";
      return <th key={column.id} scope="col" aria-sort={active ? sort.direction : undefined} className="align-top font-medium">
        <button type="button" onClick={() => setSort({ column: column.id, direction: next })}
          aria-label={`${column.label}: sort ${next}`} aria-describedby={column.describedBy}
          className="flex min-h-11 w-full flex-col items-start gap-1 px-1 py-3 text-left hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400 sm:flex-row sm:px-3">
          <span className="min-w-0 max-w-full">{column.label}</span><span aria-hidden="true" className="shrink-0">{active ? sort.direction === "ascending" ? "↑" : "↓" : "↕"}</span>
        </button>
      </th>;
    })}</tr></thead>
    <tbody className="divide-y divide-white/5">{shown.map((row) => <tr key={rowKey(row)} className="hover:bg-white/[.025]">
      {columns.map((column) => <td key={column.id} className="px-1 py-3 align-top tabular-nums sm:px-3">{column.render(row)}</td>)}
    </tr>)}</tbody>
  </table>;
}
