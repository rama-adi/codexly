import { Square, X } from 'lucide-react'
import { type FormEvent, type RefObject, useEffect, useRef } from 'react'

import type { ChatMessage, ToolActivity } from '../types'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolActivityCard } from './ToolActivityCard'

export function ChatPanel({
  sessionLabel,
  modelLabel,
  messages,
  answer,
  reasoning,
  streaming,
  activities,
  answerHeight,
  chatInput,
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
  streaming: boolean
  activities: ToolActivity[]
  answerHeight: number
  chatInput: string
  inputRef: RefObject<HTMLInputElement>
  onChatInputChange(value: string): void
  onSend(event: FormEvent): void
  onStop(): void
  onClose(): void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, answer])

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
              {message.content}
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
            {answer || (reasoning ? '' : `${modelLabel} is thinking…`)}
            {(answer || !reasoning) && <span className="ov-cursor" />}
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
          <button type="button" className="ov-stop" onClick={onStop} aria-label="Stop generating">
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
