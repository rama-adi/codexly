import { Square, X } from 'lucide-react'
import { type FormEvent, type RefObject, useEffect, useRef } from 'react'

import type { ChatMessage, ToolActivity } from '../types'
import { LoadingIndicator } from './LoadingIndicator'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolActivityCard } from './ToolActivityCard'

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
    <section className="ov-panel ov-chat">
      <header className="ov-chat-head draggable-area">
        <div>
          <b>{sessionLabel}</b>
          <small>{modelLabel}</small>
        </div>
        <button aria-label="Close chat" onClick={onClose}>
          <X size={12} />
        </button>
      </header>

      <div className="ov-chat-messages" ref={scrollRef} style={{ maxHeight: answerHeight }}>
        {isEmpty ? (
          <p className="ov-chat-empty">
            Chat with <code>{modelLabel}</code>
            <small>Continue the current Codex session.</small>
          </p>
        ) : (
          messages.map((message, index) => (
            <div key={index} className={`ov-bubble ov-bubble--${message.role}`}>
              {message.role === 'assistant' ? (
                <Markdown>{message.content}</Markdown>
              ) : (
                message.content
              )}
            </div>
          ))
        )}

        {activities.length > 0 && (
          <div className="ov-tool-stack ov-tool-stack--chat">
            {activities.map((activity) => (
              <ToolActivityCard key={activity.key} activity={activity} />
            ))}
          </div>
        )}

        {streaming && (
          <div className="ov-bubble ov-bubble--assistant">
            <ThinkingBlock text={reasoning} active={streaming && !answer} />
            {answer ? (
              <Markdown>{answer}</Markdown>
            ) : reasoning ? (
              ''
            ) : (
              <LoadingIndicator label={`${modelLabel} is thinking…`} />
            )}
            {answer && <span className="ov-cursor" />}
          </div>
        )}

        {error && (
          <div className="ov-inline-error" role="alert">
            {error}
          </div>
        )}
      </div>

      <form className="ov-chat-form" onSubmit={onSend}>
        <input
          ref={inputRef}
          value={chatInput}
          onChange={(event) => onChatInputChange(event.target.value)}
          placeholder="Type your message…"
          disabled={streaming}
        />
        {streaming ? (
          <button
            type="button"
            className="ov-stop"
            onClick={onStop}
            aria-label="Stop generating"
            disabled={!canStop}
          >
            <Square size={11} />
          </button>
        ) : (
          <button type="submit" disabled={!chatInput.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  )
}
