import * as React from 'react'
import {
  Command,
  FolderOpen,
  FolderPlus,
  KeyRound,
  MonitorUp,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { RuntimeStatus, Workspace } from '../../desktop'

interface OverviewPageProps {
  runtime: RuntimeStatus
  workspaces: Workspace[]
  busy: boolean
  available: boolean
  onLaunchOverlay: () => void
  onUseLocalLogin: () => void
  onPickWorkspace: () => void
  onSelectWorkspace: (id: string) => void
  onRemoveWorkspace: (id: string) => void
}

const TILE_ACCENTS = [
  'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  'bg-blue-500/15 text-blue-600 dark:text-blue-300',
]

function formatUpdated(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Saved workspace'
  return `Updated ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
  runtime,
  workspaces,
  busy,
  available,
  onLaunchOverlay,
  onUseLocalLogin,
  onPickWorkspace,
  onSelectWorkspace,
  onRemoveWorkspace,
}) => {
  const ready = runtime.state === 'ready'

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      <section className="grid gap-4 md:grid-cols-[1.5fr_1fr]">
        <div className="hp-hero relative overflow-hidden rounded-2xl border border-border p-6">
          <div className="relative z-10 flex h-full flex-col items-start gap-4">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <Sparkles className="size-3" />
              Local desktop assistant
            </span>
            <div className="space-y-1.5">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                Ask about the work in front of you.
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                Summon the overlay, capture context from your screen, and stream
                an answer without leaving what you are doing.
              </p>
            </div>
            <Button
              size="default"
              disabled={!available}
              onClick={onLaunchOverlay}
              className="mt-1"
            >
              <MonitorUp />
              Launch overlay
            </Button>
            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Command className="size-3.5" />
                <kbd className="hp-kbd">⌘⇧Space</kbd> toggles overlay
              </span>
              <span className="inline-flex items-center gap-1.5">
                <kbd className="hp-kbd">⌘⇧4</kbd> captures the display
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-5">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'size-2 rounded-full',
                  ready ? 'bg-emerald-500' : 'bg-amber-500',
                )}
              />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Authentication
              </span>
            </div>
            <h3 className="text-lg font-semibold tracking-tight text-foreground">
              {runtime.authMode === 'api-key' ? 'OpenAI API key' : 'Local Codex login'}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {runtime.detail}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-4 self-start"
            disabled={!available || busy}
            onClick={onUseLocalLogin}
          >
            <KeyRound />
            Use local login
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              Workspaces
            </h2>
            <p className="text-xs text-muted-foreground">
              Only folders approved through the native picker are visible to Codex.
            </p>
          </div>
          <Button size="sm" disabled={!available || busy} onClick={onPickWorkspace}>
            <FolderPlus />
            Add folder
          </Button>
        </div>

        {workspaces.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {workspaces.map((workspace, index) => (
              <div
                key={workspace.id}
                className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:border-ring/60"
              >
                <span
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-lg',
                    TILE_ACCENTS[index % TILE_ACCENTS.length],
                  )}
                >
                  <FolderOpen className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {workspace.title}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {workspace.canonicalPath}
                  </div>
                  <div className="text-[11px] text-muted-foreground/80">
                    {formatUpdated(workspace.updatedAt)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onSelectWorkspace(workspace.id)}
                  >
                    Select
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${workspace.title}`}
                    disabled={busy}
                    onClick={() => onRemoveWorkspace(workspace.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
            <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FolderOpen className="size-5" />
            </span>
            <div className="space-y-0.5">
              <div className="text-sm font-semibold text-foreground">
                No workspaces yet
              </div>
              <p className="max-w-xs text-xs text-muted-foreground">
                Add a folder to give Codex project context when you launch the
                overlay.
              </p>
            </div>
            <Button size="sm" disabled={!available || busy} onClick={onPickWorkspace}>
              <FolderPlus />
              Add folder
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}
