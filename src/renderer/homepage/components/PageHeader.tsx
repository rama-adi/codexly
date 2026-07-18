import * as React from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  actions?: React.ReactNode
  /** Reserve room for the Windows/Linux titleBarOverlay window controls. */
  controlsInset: number
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  actions,
  controlsInset,
}) => (
  <header
    className="hp-drag flex h-13 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/80 px-6 backdrop-blur"
    style={{ paddingRight: controlsInset ? controlsInset : undefined }}
  >
    <div className="min-w-0">
      <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      {description ? (
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
    {actions ? (
      <div className="hp-nodrag flex shrink-0 items-center gap-2">{actions}</div>
    ) : null}
  </header>
)
