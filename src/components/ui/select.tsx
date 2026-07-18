import * as React from 'react'
import { ChevronsUpDown } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  monospace?: boolean
}

/**
 * Styled native select. Native chrome keeps keyboard behaviour and SSR safety
 * while the wrapper supplies the desktop-app appearance.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, monospace, children, ...props }, ref) => (
    <div className={cn('relative inline-flex w-full items-center', className)}>
      <select
        ref={ref}
        className={cn(
          'h-9 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm text-foreground shadow-sm transition-colors',
          'hover:border-ring/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          monospace && 'font-mono text-[13px]',
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronsUpDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 size-3.5 text-muted-foreground"
      />
    </div>
  ),
)
Select.displayName = 'Select'
