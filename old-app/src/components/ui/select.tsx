import * as React from "react"
import { ChevronDown, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

type SelectProps = React.ComponentProps<"select"> & {
  loading?: boolean
  monospace?: boolean
}

function Select({
  className,
  loading = false,
  monospace = false,
  children,
  ...props
}: SelectProps) {
  return (
    <div className="relative inline-flex min-w-0">
      <select
        data-slot="select"
        className={cn(
          "h-8 w-full max-w-[220px] appearance-none rounded-md border border-input bg-background py-0 pl-3 pr-8 text-xs text-foreground outline-none transition-colors hover:bg-muted",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:cursor-default disabled:opacity-60",
          monospace && "font-mono",
          className
        )}
        {...props}
      >
        {children}
      </select>
      {loading ? (
        <Loader2 className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
      ) : (
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      )}
    </div>
  )
}

export { Select }
