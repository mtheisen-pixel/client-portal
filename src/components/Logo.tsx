export function Logo({ className, large }: { className?: string; large?: boolean }) {
  return (
    <img
      src="/logo.png"
      alt="Brandaify"
      className={['logo-wordmark', large && 'logo-wordmark--lg', className].filter(Boolean).join(' ')}
    />
  )
}
