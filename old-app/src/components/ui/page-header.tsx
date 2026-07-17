import * as React from "react"

import { cn } from "@/lib/utils"

type PageActionsState = {
  setActions: (node: React.ReactNode) => void
}

const PageActionsContext = React.createContext<PageActionsState | null>(null)

function PageActionsProvider({
  children,
  setActions
}: {
  children: React.ReactNode
  setActions: (node: React.ReactNode) => void
}) {
  const value = React.useMemo(() => ({ setActions }), [setActions])
  return (
    <PageActionsContext.Provider value={value}>
      {children}
    </PageActionsContext.Provider>
  )
}

function usePageActions(node: React.ReactNode) {
  const ctx = React.useContext(PageActionsContext)
  React.useEffect(() => {
    if (!ctx) return
    ctx.setActions(node)
    return () => ctx.setActions(null)
  }, [ctx, node])
}

type PageBodyProps = React.ComponentProps<"div"> & {
  width?: "default" | "wide"
}

function PageBody({ className, width = "default", ...props }: PageBodyProps) {
  return (
    <div
      data-slot="page-body"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto bg-background text-foreground",
        className
      )}
    >
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-5 px-6 py-5",
          width === "wide" ? "max-w-5xl" : "max-w-3xl"
        )}
        {...props}
      />
    </div>
  )
}

export { PageActionsProvider, usePageActions, PageBody }
