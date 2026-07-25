import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'

export function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [expanded, setExpanded] = useState(active)
  const wasActive = useRef(active)

  useEffect(() => {
    if (wasActive.current && !active) {
      // Reasoning finished (answer started or turn completed) — auto-collapse.
      setExpanded(false)
    } else if (!wasActive.current && active) {
      // A fresh reasoning stream started — show it.
      setExpanded(true)
    }
    wasActive.current = active
  }, [active])

  if (!text) return null

  return (
    <div className="mb-2.5">
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-[5px] border-0 bg-transparent py-0.5 text-[10.5px] font-[550] transition-colors hover:text-hud-dim',
          active ? 'text-hud-dim' : 'text-hud-faint',
        )}
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>{active ? 'Thinking…' : 'Thought for a moment'}</span>
      </button>
      {expanded && (
        <div
          className={cn(
            'mt-[5px] animate-hud-fade rounded-hud-sm border border-hud-line bg-white/3 px-2.5 py-2 text-[11px] italic leading-[1.55] whitespace-pre-wrap text-hud-dim',
            active &&
              'animate-hud-shimmer-slow bg-gradient-to-r from-white/3 via-white/7 to-white/3 bg-[length:440px_100%] text-hud-faint',
          )}
        >
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  )
}
