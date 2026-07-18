import type { ReactNode } from 'react'

export function Key({ children }: { children: ReactNode }) {
  return <span className="ov-key">{children}</span>
}
