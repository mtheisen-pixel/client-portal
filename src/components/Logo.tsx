// Hand-drawn approximation of the Brandaify mark (a "b" with an arrow cut
// into its bowl, navy, next to a navy/teal "brandaify" wordmark) built from
// a visual reference since the actual logo file hasn't landed as an asset
// in this project yet. Swap the <svg> below for an <img src="/logo.svg" />
// once the real file is added — see the project README.
export function Logo({ className }: { className?: string }) {
  return (
    <span className={['logo-wordmark', className].filter(Boolean).join(' ')}>
      <svg
        className="logo-mark"
        viewBox="0 0 100 130"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* stem (ascender) */}
        <rect x="8" y="0" width="26" height="110" rx="13" fill="currentColor" />
        {/* bowl */}
        <circle cx="62" cy="88" r="42" fill="currentColor" />
        {/* arrow, knocked out in white */}
        <path
          d="M42 104 Q36 110 41 114 L80 72"
          stroke="white"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <path d="M74 62 L94 56 L86 76 Z" fill="white" />
      </svg>
      brand<span className="logo-ai">ai</span>fy
    </span>
  )
}
