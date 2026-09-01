import type { ReactNode } from 'react'
import { Logo } from './Logo'

export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Logo />
        {children && <div className="site-header-actions">{children}</div>}
      </div>
    </header>
  )
}
