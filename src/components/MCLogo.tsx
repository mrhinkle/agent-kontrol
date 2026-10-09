/**
 * Mission Control mark: a thin ring with crosshair ticks and a flame-orange
 * vector. The ring and ticks inherit currentColor so it sits on light or dark
 * surfaces; the triangle is always flame. Master artwork lives in assets/brand/.
 */
export function MCMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
      <circle cx="50" cy="50" r="34" stroke="currentColor" strokeWidth="5" />
      <path d="M50 2V24M50 76V98M2 50H24M76 50H98" stroke="currentColor" strokeWidth="6" />
      <path d="M50 36L61 59H39Z" fill="#f44800" stroke="#f44800" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}
