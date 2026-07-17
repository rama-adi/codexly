import * as React from "react"

import { cn } from "@/lib/utils"

type RowProps = {
  label: React.ReactNode
  description?: React.ReactNode
  control: React.ReactNode
  className?: string
}

function SettingRow({ label, description, control, className }: RowProps) {
  return (
    <div
      className={cn(
        "flex min-h-11 items-center justify-between gap-4 px-4 py-2.5",
        className
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  )
}

export { SettingRow }
