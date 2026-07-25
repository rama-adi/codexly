import { CheckCircle2, ChevronDown, CircleDotDashed, XCircle } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'
import type { ToolActivity } from '../types'

function StateIcon({ state }: { state: ToolActivity['state'] }) {
  if (state === 'complete') return <CheckCircle2 size={13} className="text-hud-accent" />
  if (state === 'error') return <XCircle size={13} className="text-hud-danger" />
  return <CircleDotDashed size={13} className="animate-hud-spin text-hud-dim" />
}

const cardState: Record<ToolActivity['state'], string> = {
  running: '',
  complete: 'border-hud-accent/22',
  error: 'border-hud-danger/32 bg-hud-danger/6',
}

export function ToolActivityCard({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false)
  const hasOutput = Boolean(activity.output && activity.output.trim())

  return (
    <div
      className={cn(
        'animate-hud-fade overflow-hidden rounded-hud-sm border border-hud-line bg-white/3',
        cardState[activity.state],
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 border-0 bg-transparent px-[9px] py-[7px] text-left"
        onClick={() => hasOutput && setExpanded((current) => !current)}
        aria-expanded={hasOutput ? expanded : undefined}
      >
        <StateIcon state={activity.state} />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <b className="overflow-hidden text-[11px] font-[550] text-ellipsis whitespace-nowrap text-hud-text">
            {activity.name}
          </b>
          {activity.detail && (
            <small className="overflow-hidden text-[10px] text-ellipsis whitespace-nowrap text-hud-faint">
              {activity.detail}
            </small>
          )}
        </span>
        {hasOutput && (
          <ChevronDown
            size={12}
            className={cn(
              'shrink-0 text-hud-faint transition-transform duration-150',
              expanded && 'rotate-180',
            )}
          />
        )}
      </button>
      {hasOutput && expanded && (
        <pre className="m-0 max-h-[180px] animate-hud-fade overflow-auto border-t border-hud-line bg-black/45 px-[9px] py-2 font-hud-mono text-[10.5px] leading-[1.55] whitespace-pre-wrap text-[rgba(214,226,242,0.88)]">
          {activity.output}
        </pre>
      )}
    </div>
  )
}
