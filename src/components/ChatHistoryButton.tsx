import React, { useEffect, useState } from "react"
import { MessageSquareText, X } from "lucide-react"

type ChatMessage = {
  role: "user" | "assistant"
  text: string
}

const CHAT_HISTORY_KEY = "wingman-chat-history"

const loadChatHistory = (): ChatMessage[] => {
  try {
    const saved = window.localStorage.getItem(CHAT_HISTORY_KEY)
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

const ChatHistoryButton: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChatHistory())
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const refresh = () => setMessages(loadChatHistory())
    window.addEventListener("storage", refresh)
    window.addEventListener("focus", refresh)
    refresh()

    return () => {
      window.removeEventListener("storage", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [])

  return (
    <div className="relative w-fit">
      <button
        type="button"
        onClick={() => {
          setMessages(loadChatHistory())
          setOpen(value => !value)
        }}
        className="inline-flex h-6 items-center gap-1.5 rounded px-2 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        title="Chat history"
        aria-label="Chat history"
      >
        <MessageSquareText className="h-3.5 w-3.5" />
        Chat history
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-96 rounded-lg border border-white/10 bg-black/85 p-3 text-white shadow-lg backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="truncate text-xs font-medium text-white/75">
              Chat history
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-white/55 transition-colors hover:bg-white/10 hover:text-white/85"
              title="Close"
              aria-label="Close chat history"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {messages.length === 0 ? (
              <div className="rounded border border-white/10 bg-white/5 px-2.5 py-2 text-xs text-white/55">
                No chat history yet.
              </div>
            ) : (
              messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded px-2.5 py-1.5 text-xs leading-relaxed ${
                      message.role === "user"
                        ? "bg-white/15 text-white/95"
                        : "border border-white/10 bg-white/5 text-white/85"
                    }`}
                    style={{ wordBreak: "break-word" }}
                  >
                    {message.text}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default ChatHistoryButton
