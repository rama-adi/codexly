import * as React from 'react'
import { Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { RuntimeStatus } from '../../desktop'
import type { NavId, NavItem } from '../navigation'

interface SidebarProps {
  items: readonly NavItem[]
  active: NavId
  onNavigate: (id: NavId) => void
  runtime: RuntimeStatus
  isMac: boolean
}

export const Sidebar: React.FC<SidebarProps> = ({
  items,
  active,
  onNavigate,
  runtime,
  isMac,
}) => {
  const primary = items.filter((item) => item.group !== 'footer')
  const footer = items.filter((item) => item.group === 'footer')

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-secondary/40">
      <div
        className="hp-drag flex h-13 shrink-0 items-center gap-2.5"
        style={{ paddingLeft: isMac ? 80 : 16, paddingRight: 16 }}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <Sparkles className="size-3.5" />
        </span>
        <span className="text-sm font-semibold tracking-tight text-foreground">
          Codexly
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3 py-3">
        {primary.map((item) => (
          <SidebarButton
            key={item.id}
            item={item}
            active={active === item.id}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="px-3 pb-3">
        <div className="mb-2 flex flex-col gap-0.5">
          {footer.map((item) => (
            <SidebarButton
              key={item.id}
              item={item}
              active={active === item.id}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        <RuntimePill runtime={runtime} />
      </div>
    </aside>
  )
}

const SidebarButton: React.FC<{
  item: NavItem
  active: boolean
  onNavigate: (id: NavId) => void
}> = ({ item, active, onNavigate }) => {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.id)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-card text-foreground shadow-sm ring-1 ring-border'
          : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
      )}
    >
      <Icon
        className={cn(
          'size-4 shrink-0 transition-colors',
          active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
        )}
      />
      {item.label}
    </button>
  )
}

const RuntimePill: React.FC<{ runtime: RuntimeStatus }> = ({ runtime }) => {
  const ready = runtime.state === 'ready'
  const authLabel =
    runtime.authMode === 'api-key' ? 'API key' : 'Codex login'
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-2">
      <span className="relative flex size-2 shrink-0">
        {ready && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
        )}
        <span
          className={cn(
            'relative inline-flex size-2 rounded-full',
            ready ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-xs font-semibold text-foreground">
          {ready ? 'Runtime ready' : runtime.state === 'unauthorized' ? 'Sign-in needed' : 'Runtime offline'}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{authLabel}</div>
      </div>
    </div>
  )
}
