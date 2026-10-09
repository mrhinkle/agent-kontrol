/** Main navigation links, in display order. */
export const NAV_LINKS: { href: string; label: string; accent?: boolean }[] = [
  { href: "/", label: "Fleet" },
  { href: "/progress", label: "Progress" },
  { href: "/usage", label: "Usage and Costs" },
  { href: "/tasks", label: "Tasks" },
  { href: "/history", label: "History" },
  { href: "/memory", label: "Memory" },
  { href: "/gibson", label: "Gibson", accent: true },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
