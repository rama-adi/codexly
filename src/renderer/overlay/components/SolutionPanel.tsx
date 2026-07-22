import { Copy, X } from 'lucide-react'
import { useState } from 'react'

import type { ToolActivity } from '../types'
import { LoadingIndicator } from './LoadingIndicator'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolActivityCard } from './ToolActivityCard'

export function SolutionPanel({
  answer,
  reasoning,
  streaming,
  modelLabel,
  activities,
  answerHeight,
  onClose,
}: {
  answer: string
  reasoning: string
  streaming: boolean
  modelLabel: string
  activities: ToolActivity[]
  answerHeight: number
  onClose(): void
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!answer) return
    await navigator.clipboard.writeText(answer)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const isEmpty = !answer && streaming

  return (
    <section className="ov-panel ov-solution">
      <div className="ov-solution-head draggable-area" aria-hidden />
      <div className="ov-panel-actions">
        <button aria-label="Copy answer" onClick={() => void copy()} disabled={!answer} title="Copy answer">
          <Copy size={12} />
          {copied && <span className="ov-copied">Copied</span>}
        </button>
        <button aria-label="Close answer" onClick={onClose} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="ov-solution-body" style={{ maxHeight: answerHeight }}>
        {activities.length > 0 && (
          <div className="ov-tool-stack">
            {activities.map((activity) => (
              <ToolActivityCard key={activity.key} activity={activity} />
            ))}
          </div>
        )}

        <ThinkingBlock text={reasoning} active={streaming && !answer} />

        {isEmpty ? (
          <>
            <LoadingIndicator label={`${modelLabel} is thinking…`} />
            <div className="ov-shimmer-block" aria-hidden>
              <span className="ov-shimmer-line" style={{ width: '82%' }} />
              <span className="ov-shimmer-line" style={{ width: '64%' }} />
              <span className="ov-shimmer-line" style={{ width: '71%' }} />
            </div>
          </>
        ) : (
          <div className="ov-answer">
            {answer || 'No answer received.'}
            {streaming && <span className="ov-cursor" />}
          </div>
        )}
      </div>

      <footer className="ov-solution-foot">
        <span>{modelLabel}</span>
        {streaming && <span className="ov-live-dot" aria-hidden />}
      </footer>
    </section>
  )
}
