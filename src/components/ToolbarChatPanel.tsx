import React, { useEffect, useMemo, useRef, useState } from "react"
import { Trash2, X } from "lucide-react"

import AssistantTranscript from "@/components/AssistantTranscript"
import MarkdownMessage from "@/components/MarkdownMessage"
import { historyService, llmService, processingService } from "@/services/desktop"
import type { ChatSession } from "@/shared/ipc"

type ChatMessage = ChatSession["messages"][number]

const messageScreenshots = (message: ChatMessage) => {
  const screenshots = [
    ...(message.screenshots ?? []),
    ...(message.screenshotDataUrls?.map((dataUrl, index) => ({
      path: message.screenshotPaths?.[index] ?? `${message.id}-${index}`,
      dataUrl,
    })) ?? []),
  ]
  const seen = new Set<string>()
  return screenshots.filter(screenshot => {
    const key = `${screenshot.path}\n${screenshot.dataUrl}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const ToolbarChatPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [chatInput, setChatInput] = useState("")
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null)
  const [chatLoading, setChatLoading] = useState(false)
  const chatLoadingRef = useRef(false)
  const [streamingAnswer, setStreamingAnswer] = useState("")
  const [currentModel, setCurrentModel] = useState<{ provider: string; model: string }>({
    provider: "codex",
    model: "gpt-5.4",
  })
  const chatInputRef = useRef<HTMLInputElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    llmService.getCurrentConfig().then(setCurrentModel).catch(() => undefined)
    const cleanupModel = llmService.onConfigChanged(setCurrentModel)
    historyService.getActiveSession().then(setActiveSession).catch(() => undefined)
    const cleanupHistory = historyService.onChanged(() => {
      if (chatLoadingRef.current) return
      historyService.getActiveSession().then(setActiveSession).catch(() => undefined)
    })
    const cleanupStream = [
      processingService.onChatStreamStart(() => {
        if (chatLoadingRef.current) setStreamingAnswer("")
      }),
      processingService.onChatStreamDelta(delta => {
        if (chatLoadingRef.current) setStreamingAnswer(current => current + delta)
      }),
      processingService.onChatStreamComplete(data => {
        if (chatLoadingRef.current) setStreamingAnswer(current => current || data.answer)
      }),
      processingService.onChatStreamError(error => {
        if (chatLoadingRef.current) setStreamingAnswer(`Error: ${error}`)
      }),
    ]
    requestAnimationFrame(() => chatInputRef.current?.focus())
    return () => {
      cleanupModel()
      cleanupHistory()
      cleanupStream.forEach(cleanup => cleanup())
    }
  }, [])

  useEffect(() => {
    chatLoadingRef.current = chatLoading
  }, [chatLoading])

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight })
  }, [activeSession?.messages, streamingAnswer, chatLoading])

  const chatMessages = activeSession?.messages ?? []
  const displayedMessages = useMemo(() => {
    if (!chatLoading || !streamingAnswer) return chatMessages
    return [
      ...chatMessages,
      {
        id: "streaming-assistant",
        role: "assistant" as const,
        content: streamingAnswer,
        createdAt: new Date().toISOString(),
      },
    ]
  }, [chatLoading, chatMessages, streamingAnswer])

  const handleChatSend = async () => {
    const message = chatInput.trim()
    if (!message) return
    const timestamp = new Date().toISOString()
    const optimisticMessage: ChatMessage = {
      id: `pending-user-${Date.now()}`,
      role: "user",
      content: message,
      createdAt: timestamp,
    }
    setChatLoading(true)
    setStreamingAnswer("")
    setChatInput("")
    setActiveSession(current =>
      current
        ? {
            ...current,
            messageCount: current.messageCount + 1,
            updatedAt: timestamp,
            messages: [...current.messages, optimisticMessage],
          }
        : {
            id: "pending-active-session",
            title: message,
            createdAt: timestamp,
            updatedAt: timestamp,
            messageCount: 1,
            messages: [optimisticMessage],
          }
    )
    try {
      await processingService.chat(message)
      setActiveSession(await historyService.getActiveSession())
    } catch (err) {
      setActiveSession(current =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: `error-${Date.now()}`,
                  role: "assistant",
                  content: "Error: " + String(err),
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : current
      )
    } finally {
      setChatLoading(false)
      setStreamingAnswer("")
      chatInputRef.current?.focus()
    }
  }

  const clearChat = async () => {
    await processingService.clearChatHistory()
    setActiveSession(await historyService.getActiveSession())
  }

  return (
    <div className="w-96 rounded-lg bg-black/60 border border-white/10 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-white/75">
            {activeSession?.title ?? "New session"}
          </div>
          <div className="truncate text-[11px] text-white/40">{currentModel.model}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={clearChat}
            disabled={chatLoading || chatMessages.length === 0}
            className="inline-flex h-7 w-7 items-center justify-center rounded bg-white/5 text-white/60 transition-colors hover:bg-white/10 hover:text-white/85 disabled:cursor-default disabled:opacity-35"
            title="Clear chat"
            aria-label="Clear chat"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded bg-white/5 text-white/60 transition-colors hover:bg-white/10 hover:text-white/85"
            title="Close chat"
            aria-label="Close chat"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div
        ref={messagesRef}
        className="flex-1 overflow-y-auto max-h-64 min-h-[120px] rounded bg-black/30 border border-white/5 p-2 space-y-2"
      >
        {displayedMessages.length === 0 ? (
          <div className="text-xs text-white/50 text-center py-6">
            Chat with <span className="font-mono text-white/70">{currentModel.model}</span>
            <div className="mt-1 text-[11px] text-white/35">
              Continue the current Codex session.
            </div>
          </div>
        ) : (
          displayedMessages.map(msg => {
            const screenshots = messageScreenshots(msg)

            return (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] px-2.5 py-1.5 rounded text-xs leading-relaxed ${
                    msg.role === "user"
                      ? "bg-white/15 text-white/95"
                      : "bg-white/5 text-white/85 border border-white/10"
                  }`}
                  style={{ wordBreak: "break-word" }}
                >
                  {screenshots.length > 0 && (
                    <div className="mb-2 grid grid-cols-2 gap-1.5">
                      {screenshots.map(screenshot => (
                        <img
                          key={`${screenshot.path}-${screenshot.dataUrl.slice(0, 48)}`}
                          src={screenshot.dataUrl}
                          alt="Screenshot"
                          className="max-h-24 rounded border border-white/10 object-cover"
                        />
                      ))}
                    </div>
                  )}
                  {msg.role === "assistant" ? (
                    <AssistantTranscript markdown={msg.content} compact />
                  ) : (
                    <MarkdownMessage markdown={msg.content} className="space-y-2" />
                  )}
                </div>
              </div>
            )
          })
        )}
        {chatLoading && !streamingAnswer && (
          <div className="flex justify-start">
            <div className="max-w-[85%] bg-white/5 border border-white/10 px-2.5 py-1.5 rounded text-xs text-white/85">
              <span className="animate-pulse text-white/60">{currentModel.model} is replying...</span>
            </div>
          </div>
        )}
      </div>
      <form
        className="flex gap-2 items-center"
        onSubmit={e => {
          e.preventDefault()
          handleChatSend()
        }}
      >
        <input
          ref={chatInputRef}
          className="flex-1 px-2.5 py-1.5 rounded bg-white/5 border border-white/10 text-xs text-white/95 placeholder-white/40 focus:outline-none focus:border-white/25"
          placeholder="Type your message..."
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          disabled={chatLoading}
        />
        <button
          type="submit"
          className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 disabled:opacity-40 text-xs text-white/90 transition-colors"
          disabled={chatLoading || !chatInput.trim()}
          aria-label="Send"
        >
          Send
        </button>
      </form>
    </div>
  )
}

export default ToolbarChatPanel
