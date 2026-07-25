import { Square, X } from 'lucide-react'
import { type FormEvent, type RefObject, useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'
import {
  hudBubble,
  hudIconButton,
  hudInlineError,
  hudPanel,
  hudToolStack,
} from '../styles'
import type { ChatMessage, ToolActivity } from '../types'
import { Cursor } from './Cursor'
import { LoadingIndicator } from './LoadingIndicator'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolActivityCard } from './ToolActivityCard'

const bubbleTone: Record<ChatMessage['role'], string> = {
  user: 'self-end border border-hud-accent/22 bg-hud-accent-soft text-[rgba(232,240,250,0.95)]',
  assistant: 'self-start border border-hud-line bg-white/5 text-[rgba(245,246,248,0.92)]',
}

export function ChatPanel({
  sessionLabel,
  modelLabel,
  messages,
  answer,
  reasoning,
  error,
  streaming,
  activities,
  answerHeight,
  chatInput,
  canStop,
  inputRef,
  onChatInputChange,
  onSend,
  onStop,
  onClose,
}: {
  sessionLabel: string
  modelLabel: string
  messages: ChatMessage[]
  answer: string
  reasoning: string
  error?: string
  streaming: boolean
  activities: ToolActivity[]
  answerHeight: number
  chatInput: string
  canStop: boolean
  inputRef: RefObject<HTMLInputElement>
  onChatInputChange(value: string): void
  onSend(event: FormEvent): void
  onStop(): void
  onClose(): void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef<number>()

  useEffect(() => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
      scrollFrameRef.current = undefined
    })
    return () => {
      if (scrollFrameRef.current !== undefined) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = undefined
      }
    }
  }, [messages.length, answer, reasoning, activities.length, streaming])

  const isEmpty = messages.length === 0 && !answer

  return (
    <section className={cn(hudPanel, 'w-96 p-2.5')}>
      <header className="draggable-area flex items-center justify-between pb-2">
        <div className="flex flex-col gap-px">
          <b className="text-[11px] font-semibold">{sessionLabel}</b>
          <small className="text-[10px] text-hud-faint">{modelLabel}</small>
        </div>
        <button
          className={cn(hudIconButton, 'size-[22px]')}
          aria-label="Close chat"
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </header>

      <div
        className="mb-2 flex min-h-[110px] flex-col gap-[7px] overflow-y-auto rounded-hud-sm border border-hud-line bg-black/28 p-[9px]"
        ref={scrollRef}
        style={{ maxHeight: answerHeight }}
      >
        {isEmpty ? (
          <p className="m-auto py-3.5 text-center text-[11px] text-hud-dim">
            Chat with <code className="font-hud-mono text-hud-accent">{modelLabel}</code>
            <small className="mt-1 block text-[10.5px] text-hud-faint">
              Continue the current Codex session.
            </small>
          </p>
        ) : (
          messages.map((message, index) => (
            <div key={index} className={cn(hudBubble, bubbleTone[message.role])}>
              {message.role === 'assistant' ? (
                <Markdown>{message.content}</Markdown>
              ) : (
                message.content
              )}
            </div>
          ))
        )}

        {activities.length > 0 && (
          <div className={cn(hudToolStack, 'mt-0.5')}>
            {activities.map((activity) => (
              <ToolActivityCard key={activity.key} activity={activity} />
            ))}
          </div>
        )}

        {streaming && (
          <div className={cn(hudBubble, bubbleTone.assistant)}>
            <ThinkingBlock text={reasoning} active={streaming && !answer} />
            {answer ? (
              <Markdown>{answer}</Markdown>
            ) : reasoning ? (
              ''
            ) : (
              <LoadingIndicator label={`${modelLabel} is thinking…`} />
            )}
            {answer && <Cursor />}
          </div>
        )}

        {error && (
          <div className={hudInlineError} role="alert">
            {error}
          </div>
        )}
      </div>

      <form className="flex gap-1.5" onSubmit={onSend}>
        <input
          className="h-[30px] min-w-0 flex-1 rounded-hud-sm border border-hud-line bg-white/5 px-[9px] text-[11.5px] text-hud-text transition-colors placeholder:text-hud-faint focus-visible:border-hud-accent"
          ref={inputRef}
          value={chatInput}
          onChange={(event) => onChatInputChange(event.target.value)}
          placeholder="Type your message…"
          disabled={streaming}
        />
        {streaming ? (
          <button
            type="button"
            className="grid size-[30px] shrink-0 place-items-center rounded-hud-sm border border-hud-danger/35 bg-hud-danger/14 text-hud-danger hover:bg-hud-danger/24"
            onClick={onStop}
            aria-label="Stop generating"
            disabled={!canStop}
          >
            <Square size={11} />
          </button>
        ) : (
          <button
            type="submit"
            className="h-[30px] rounded-hud-sm border-0 bg-hud-accent-soft px-[13px] text-[11px] font-[650] text-hud-accent transition-colors enabled:hover:bg-hud-accent-strong disabled:cursor-default disabled:opacity-35"
            disabled={!chatInput.trim()}
          >
            Send
          </button>
        )}
      </form>
    </section>
  )
}
