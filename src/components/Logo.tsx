// Placeholder wordmark matching the Brandaify brand colors (navy "brand"/"fy",
// teal "ai") until the real logo asset is dropped into /public. Swap this for
// an <img src="/logo.svg" alt="Brandaify" /> once that file exists.
export function Logo({ className }: { className?: string }) {
  return (
    <span className={['logo-wordmark', className].filter(Boolean).join(' ')}>
      brand<span className="logo-ai">ai</span>fy
    </span>
  )
}
