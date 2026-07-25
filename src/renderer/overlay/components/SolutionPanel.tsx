import { Copy, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { hudIconButton, hudInlineError, hudPanel, hudToolStack } from '../styles'
import type { ToolActivity } from '../types'
import { Cursor } from './Cursor'
import { LoadingIndicator } from './LoadingIndicator'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolActivityCard } from './ToolActivityCard'

const shimmerLine =
  'h-2.5 animate-hud-shimmer rounded-[5px] bg-[length:440px_100%] bg-gradient-to-r from-white/6 via-white/16 to-white/6'

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
    <section className={cn(hudPanel, 'pt-3.5 pr-11 pb-0 pl-3.5')}>
      <div className="draggable-area absolute inset-x-0 top-0 h-9" aria-hidden />
      <div className="absolute right-1.5 top-1.5 z-1 flex gap-1">
        <button
          className={cn(hudIconButton, 'relative size-6')}
          aria-label="Copy answer"
          onClick={() => void copy()}
          disabled={!answer || copying}
          title="Copy answer"
        >
          <Copy size={12} />
          {copied && (
            <span className="absolute right-0 top-7 animate-hud-fade-fast rounded-[5px] bg-black/85 px-[7px] py-[3px] text-[10px] font-semibold whitespace-nowrap text-hud-accent">
              Copied
            </span>
          )}
        </button>
        <button
          className={cn(hudIconButton, 'size-6')}
          aria-label="Close answer"
          onClick={onClose}
          title="Close"
        >
          <X size={12} />
        </button>
      </div>

      <div className="overflow-y-auto pb-3" style={{ maxHeight: answerHeight }}>
        {activities.length > 0 && (
          <div className={cn(hudToolStack, 'mb-3')}>
            {activities.map((activity) => (
              <ToolActivityCard key={activity.key} activity={activity} />
            ))}
          </div>
        )}

        <ThinkingBlock text={reasoning} active={streaming && !answer} />

        {isEmpty ? (
          <>
            <LoadingIndicator label={`${modelLabel} is thinking…`} />
            <div className="grid gap-[9px] pt-0.5 pb-1.5" aria-hidden>
              <span className={cn(shimmerLine, 'w-[82%]')} />
              <span className={cn(shimmerLine, 'w-[64%]')} />
              <span className={cn(shimmerLine, 'w-[71%]')} />
            </div>
          </>
        ) : error && !answer ? (
          <div className={hudInlineError} role="alert">
            {error}
          </div>
        ) : (
          <div className="animate-hud-fade text-[12.5px] leading-[1.65] whitespace-pre-wrap text-[rgba(245,246,248,0.92)]">
            <Markdown>{answer}</Markdown>
            {streaming && <Cursor />}
          </div>
        )}
        {error && answer && (
          <div className={hudInlineError} role="alert">
            {error}
          </div>
        )}
        {copyError && (
          <div className={hudInlineError} role="alert">
            Copy failed: {copyError}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-1.5 border-t border-hud-line py-2 text-[10.5px] text-hud-faint">
        <span>{modelLabel}</span>
        {streaming && (
          <span className="size-1.5 animate-hud-pulse rounded-full bg-hud-accent" aria-hidden />
        )}
      </footer>
    </section>
  )
}
