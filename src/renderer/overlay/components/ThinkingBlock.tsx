import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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
    <div className={`ov-thinking ${active ? 'ov-thinking--live' : ''}`}>
      <button
        type="button"
        className="ov-thinking-toggle"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>{active ? 'Thinking…' : 'Thought for a moment'}</span>
      </button>
      {expanded && (
        <div className={`ov-thinking-body ${active ? 'ov-thinking-body--live' : ''}`}>{text}</div>
      )}
    </div>
  )
}
