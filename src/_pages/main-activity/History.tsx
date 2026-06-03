import React, { useEffect, useMemo, useState } from "react"
import { Loader2, MessageSquareText, Send, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import AssistantTranscript from "@/components/AssistantTranscript"
import MarkdownMessage from "@/components/MarkdownMessage"
import { historyService, processingService } from "@/services/desktop"
import { usePageActions } from "@/components/ui/page-header"
import type { ChatSession, HistoryIndexItem } from "@/types/electron"

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

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
})

const History: React.FC = () => {
  const [items, setItems] = useState<HistoryIndexItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedSession, setSelectedSession] = useState<ChatSession | null>(
    null
  )
  const chatInputRef = React.useRef<HTMLInputElement>(null)
  const chatLoadingRef = React.useRef(false)
  const [loading, setLoading] = useState(true)
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)
  const [streamingAnswer, setStreamingAnswer] = useState("")
  const [error, setError] = useState("")

  const selectedIndexItem = useMemo(
    () => items.find(item => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  )

  const load = async () => {
    setError("")
    try {
      const history = await historyService.getIndex()
      setItems(history)
      setSelectedId(current =>
        current && history.some(item => item.id === current)
          ? current
          : history[0]?.id ?? null
      )
    } catch (error) {
      setError(String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const cleanupHistory = historyService.onChanged(history => {
      setItems(history)
      setSelectedId(current =>
        current && history.some(item => item.id === current)
          ? current
          : history[0]?.id ?? null
      )
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
        if (chatLoadingRef.current) setError(error)
      }),
    ]

    return () => {
      cleanupHistory()
      cleanupStream.forEach(cleanup => cleanup())
    }
  }, [])

  useEffect(() => {
    chatLoadingRef.current = chatLoading
  }, [chatLoading])

  useEffect(() => {
    if (!selectedIndexItem) {
      setSelectedSession(null)
      return
    }
    if (chatLoadingRef.current) return
    historyService
      .getSession(selectedIndexItem.id)
      .then(setSelectedSession)
      .catch(error => setError(String(error)))
  }, [selectedIndexItem])

  const reloadSelectedSession = async (sessionId: string) => {
    const session = await historyService.getSession(sessionId)
    setSelectedSession(session)
    return session
  }

  const deleteSelectedSession = async () => {
    if (!selectedSession || chatLoading) return
    const confirmed = window.confirm(
      `Delete "${selectedSession.title}"? This cannot be undone.`
    )
    if (!confirmed) return

    setError("")
    try {
      const deletedId = selectedSession.id
      const result = await historyService.deleteSession(deletedId)
      if (!result.success) throw new Error("Selected session could not be deleted.")
      setSelectedSession(null)
      setSelectedId(current => (current === deletedId ? null : current))
      await load()
    } catch (error) {
      setError(String(error))
    }
  }

  const clearSessions = async () => {
    if (items.length === 0 || chatLoading) return
    const confirmed = window.confirm(
      `Clear ${items.length === 1 ? "1 session" : `${items.length} sessions`}? This cannot be undone.`
    )
    if (!confirmed) return

    setError("")
    try {
      const result = await processingService.clearChatSessions()
      if (!result.success) throw new Error("Sessions could not be cleared.")
      setItems([])
      setSelectedId(null)
      setSelectedSession(null)
    } catch (error) {
      setError(String(error))
    }
  }

  const continueSelectedSession = async () => {
    if (!selectedSession || chatLoading) return

    setError("")
    try {
      const activated = await historyService.activateSession(selectedSession.id)
      if (!activated) throw new Error("Selected session could not be loaded.")
      setSelectedSession(activated)
      requestAnimationFrame(() => chatInputRef.current?.focus())
    } catch (error) {
      setError(String(error))
    }
  }

  const sendMessage = async () => {
    const message = chatInput.trim()
    if (!message || !selectedSession || chatLoading) return

    const sessionId = selectedSession.id
    const optimisticMessage: ChatMessage = {
      id: `pending-user-${Date.now()}`,
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
    }
    setChatLoading(true)
    setStreamingAnswer("")
    setChatInput("")
    setError("")
    setSelectedSession(current =>
      current && current.id === sessionId
        ? {
            ...current,
            messageCount: current.messageCount + 1,
            updatedAt: optimisticMessage.createdAt,
            messages: [...current.messages, optimisticMessage],
          }
        : current
    )
    try {
      const activated = await historyService.activateSession(sessionId)
      if (!activated) throw new Error("Selected session could not be loaded.")
      await processingService.chat(message)
      await reloadSelectedSession(sessionId)
      await load()
    } catch (error) {
      setError(String(error))
    } finally {
      setChatLoading(false)
      setStreamingAnswer("")
    }
  }

  const titlebarContent = useMemo(
    () =>
      selectedSession ? (
        <div className="flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={continueSelectedSession}
            disabled={chatLoading}
            aria-label="Continue current chat"
            title="Continue current chat"
            className="shrink-0"
          >
            <MessageSquareText />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={deleteSelectedSession}
            disabled={chatLoading}
            aria-label="Delete current chat"
            title="Delete current chat"
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 />
          </Button>
          <h2
            className="min-w-0 flex-1 truncate text-sm font-semibold tracking-normal"
            title={selectedSession.title}
          >
            {selectedSession.title}
          </h2>
        </div>
      ) : null,
    [chatLoading, selectedSession]
  )
  usePageActions(titlebarContent)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#f3f5f6] p-2 text-foreground">
      {error && (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,260px)_minmax(0,1fr)] overflow-hidden rounded-xl border border-[#dfe3e6] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.08),0_16px_42px_rgba(15,23,42,0.05)]">
        <div className="min-h-0 overflow-y-auto border-r border-border bg-card">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>
              {items.length === 1
                ? "1 session"
                : `${items.length} sessions`}
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={clearSessions}
              disabled={items.length === 0 || chatLoading}
              aria-label="Clear all sessions"
              className="h-6 px-1.5 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-destructive"
            >
              Clear
            </Button>
          </div>
          {items.length === 0 ? (
            <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <MessageSquareText className="size-5" />
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium">No history yet</div>
                <div className="max-w-56 text-xs leading-relaxed text-muted-foreground">
                  Toolbar sessions will appear here after the first answer.
                </div>
              </div>
            </div>
          ) : (
            items.map(item => {
              const active = selectedIndexItem?.id === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`flex min-h-14 w-full flex-col items-start gap-0.5 border-b border-border px-4 py-2.5 text-left transition-colors ${
                    active ? "bg-muted" : "hover:bg-muted/60"
                  }`}
                >
                  <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                    {item.title}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {dateFormatter.format(new Date(item.updatedAt))} ·{" "}
                    {item.messageCount} messages
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="flex min-h-0 flex-col bg-background">
          {selectedSession ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-5">
                  <div className="flex flex-col gap-3">
                    {selectedSession.messages.map(message => {
                      const screenshots = messageScreenshots(message)

                      return (
                        <div
                          key={message.id}
                          className={`flex ${
                            message.role === "user"
                              ? "justify-end"
                              : "justify-start"
                          }`}
                        >
                          <div
                            className={`max-w-[86%] rounded-md px-3 py-2 text-sm leading-relaxed ${
                              message.role === "user"
                                ? "bg-primary text-primary-foreground"
                                : "border border-border bg-card text-card-foreground"
                            }`}
                          >
                            <div className="mb-1 flex items-center justify-between gap-3 text-[10px] font-medium uppercase tracking-wide opacity-60">
                              <span>{message.role}</span>
                              <span className="shrink-0">
                                {dateFormatter.format(new Date(message.createdAt))}
                              </span>
                            </div>
                            {screenshots.length > 0 && (
                              <div className="mb-2 grid grid-cols-2 gap-2">
                                {screenshots.map(screenshot => (
                                  <img
                                    key={`${screenshot.path}-${screenshot.dataUrl.slice(0, 48)}`}
                                    src={screenshot.dataUrl}
                                    alt="Screenshot"
                                    className="max-h-44 rounded border border-current/10 object-cover"
                                  />
                                ))}
                              </div>
                            )}
                            {message.role === "assistant" ? (
                              <AssistantTranscript markdown={message.content} className="text-sm leading-relaxed" />
                            ) : (
                              <MarkdownMessage markdown={message.content} className="text-sm leading-relaxed" />
                            )}
                          </div>
                        </div>
                      )
                    })}
                    {chatLoading && (
                      <div className="flex justify-start">
                        <div className="max-w-[86%] rounded-md border border-border bg-card px-3 py-2 text-sm leading-relaxed text-card-foreground">
                          {streamingAnswer ? (
                            <AssistantTranscript markdown={streamingAnswer} streaming className="text-sm leading-relaxed" />
                          ) : (
                            <div className="inline-flex items-center gap-2 text-muted-foreground">
                              <Loader2 className="size-3.5 animate-spin" />
                              Replying...
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <form
                className="border-t border-border bg-background px-6 py-3"
                onSubmit={event => {
                  event.preventDefault()
                  sendMessage()
                }}
              >
                <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
                  <input
                    ref={chatInputRef}
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
                    value={chatInput}
                    onChange={event => setChatInput(event.target.value)}
                    placeholder="Continue this session..."
                    disabled={chatLoading}
                  />
                  <Button type="submit" size="sm" disabled={chatLoading || !chatInput.trim()}>
                    {chatLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send data-icon="inline-start" />
                    )}
                    Send
                  </Button>
                </div>
              </form>
            </>
          ) : (
            <div className="flex h-full min-h-56 items-center justify-center p-6 text-sm text-muted-foreground">
              Select a session to view it.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default History
