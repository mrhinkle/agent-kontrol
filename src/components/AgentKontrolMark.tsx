/**
 * The Agent Kontrol mark: a reticle (ring and four ticks, drawn in the current
 * text color) with an orange marker inside. Same geometry as the files in
 * public/logo/.
 */
export function AgentKontrolMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" className={className} aria-hidden="true">
      <circle cx="60" cy="60" r="31" stroke="currentColor" strokeWidth="8" />
      <path
        d="M60 36.2V15.7M60 83.8v20.5M36.2 60H15.7M83.8 60h20.5"
        stroke="currentColor"
        strokeWidth="8"
      />
      <path
        d="M60 45.3 71.2 70.5H48.8Z"
        fill="#ff6d00"
        stroke="#ff6d00"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
