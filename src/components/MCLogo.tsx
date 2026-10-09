/**
 * Mission Control marks — two candidate directions, both simplified from
 * the design references. Chrome strokes inherit currentColor; accents are flame
 * orange. MCLogo: rocket lifting off through a dashboard screen.
 * MCLogoConsole: control panel with slider rails.
 */
export function MCLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
      <rect
        x="6"
        y="10"
        width="36"
        height="24"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <path
        d="M17 40h14M24 34v6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M24 5.5c3 3.2 4.5 6.9 4.5 10.7 0 2.5-.7 5-2 7.3h-5c-1.3-2.3-2-4.8-2-7.3 0-3.8 1.5-7.5 4.5-10.7Z"
        stroke="#f44800"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="15.5" r="2.2" stroke="#f44800" strokeWidth="2" />
      <path
        d="M19.4 20.5 16 24.5M28.6 20.5 32 24.5"
        stroke="#f44800"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M20.5 27.5v2.5M24 28.5v4M27.5 27.5v2.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MCLogoConsole({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
      <rect
        x="6"
        y="9"
        width="36"
        height="30"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path d="M13 18.5h22" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M13 24h22" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M13 29.5h22" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="19" cy="18.5" r="2.8" fill="#05070f" stroke="#f44800" strokeWidth="1.75" />
      <circle cx="30" cy="24" r="2.8" fill="#05070f" stroke="#f44800" strokeWidth="1.75" />
      <circle cx="22" cy="29.5" r="2.8" fill="#05070f" stroke="#f44800" strokeWidth="1.75" />
    </svg>
  );
}
