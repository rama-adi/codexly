import * as React from 'react'

import { cn } from '@/lib/utils'

export interface SettingRowProps {
  label: React.ReactNode
  description?: React.ReactNode
  control?: React.ReactNode
  htmlFor?: string
  className?: string
  /** Stack the control beneath the label instead of trailing it. */
  stacked?: boolean
}

export const SettingRow: React.FC<SettingRowProps> = ({
  label,
  description,
  control,
  htmlFor,
  className,
  stacked = false,
}) => (
  <div
    className={cn(
      'flex gap-4 px-4 py-3.5',
      stacked ? 'flex-col' : 'items-center justify-between',
      className,
    )}
  >
    <div className="min-w-0 space-y-0.5">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      {description ? (
        <div className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </div>
      ) : null}
    </div>
    {control ? (
      <div className={cn('shrink-0', stacked && 'w-full')}>{control}</div>
    ) : null}
  </div>
)
