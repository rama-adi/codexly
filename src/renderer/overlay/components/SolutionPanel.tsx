import { Copy, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { ToolActivity } from '../types'
import { LoadingIndicator } from './LoadingIndicator'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolActivityCard } from './ToolActivityCard'

export function SolutionPanel({
  answer,
  reasoning,
  error,
  streaming,
  modelLabel,
  activities,
  answerHeight,
  onClose,
}: {
  answer: string
  reasoning: string
  error?: string
  streaming: boolean
  modelLabel: string
  activities: ToolActivity[]
  answerHeight: number
  onClose(): void
}) {
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyError, setCopyError] = useState<string>()
  const copiedTimerRef = useRef<number>()

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== undefined) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  const copy = async () => {
    if (!answer || copying) return
    setCopying(true)
    setCopyError(undefined)
    try {
      await navigator.clipboard.writeText(answer)
      setCopied(true)
      if (copiedTimerRef.current !== undefined) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = undefined
        setCopied(false)
      }, 1400)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : 'Could not copy the answer.')
    } finally {
      setCopying(false)
    }
  }

  const isEmpty = !answer && streaming

  return (
    <section className="ov-panel ov-solution">
      <div className="ov-solution-head draggable-area" aria-hidden />
      <div className="ov-panel-actions">
        <button
          aria-label="Copy answer"
          onClick={() => void copy()}
          disabled={!answer || copying}
          title="Copy answer"
        >
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
        ) : error && !answer ? (
          <div className="ov-inline-error" role="alert">{error}</div>
        ) : (
          <div className="ov-answer">
            <Markdown>{answer}</Markdown>
            {streaming && <span className="ov-cursor" />}
          </div>
        )}
        {error && answer && <div className="ov-inline-error" role="alert">{error}</div>}
        {copyError && <div className="ov-inline-error" role="alert">Copy failed: {copyError}</div>}
      </div>

      <footer className="ov-solution-foot">
        <span>{modelLabel}</span>
        {streaming && <span className="ov-live-dot" aria-hidden />}
      </footer>
    </section>
  )
}
