import type { ReactNode } from 'react'

export function Key({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded px-1 py-px text-[9px] font-semibold leading-[1.4] tracking-[0.02em] bg-white/8 text-hud-faint">
      {children}
    </span>
  )
}
