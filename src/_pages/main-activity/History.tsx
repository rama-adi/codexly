import React, { useEffect, useMemo, useState } from "react"
import { Loader2, MessageSquareText, Plus, RotateCcw, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import MarkdownMessage from "@/components/MarkdownMessage"
import { usePageActions } from "@/components/ui/page-header"
import type { ChatSession, HistoryIndexItem } from "@/types/electron"

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
  const [loading, setLoading] = useState(true)
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)
  const [error, setError] = useState("")

  const selectedIndexItem = useMemo(
    () => items.find(item => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  )

  const load = async () => {
    setError("")
    try {
      const history = await window.electronAPI.getChatHistoryIndex()
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
    return window.electronAPI.onHistoryChanged(history => {
      setItems(history)
      setSelectedId(current =>
        current && history.some(item => item.id === current)
          ? current
          : history[0]?.id ?? null
      )
    })
  }, [])

  useEffect(() => {
    if (!selectedIndexItem) {
      setSelectedSession(null)
      return
    }
    window.electronAPI
      .getChatSession(selectedIndexItem.id)
      .then(setSelectedSession)
      .catch(error => setError(String(error)))
  }, [selectedIndexItem])

  const newSession = async () => {
    await window.electronAPI.newChatSession()
    await load()
  }

  const reloadSelectedSession = async (sessionId: string) => {
    const session = await window.electronAPI.getChatSession(sessionId)
    setSelectedSession(session)
    return session
  }

  const sendMessage = async () => {
    const message = chatInput.trim()
    if (!message || !selectedSession || chatLoading) return

    const sessionId = selectedSession.id
    setChatLoading(true)
    setChatInput("")
    setError("")
    try {
      const activated = await window.electronAPI.activateChatSession(sessionId)
      if (!activated) throw new Error("Selected session could not be loaded.")
      setSelectedSession(activated)
      await window.electronAPI.chat(message)
      await reloadSelectedSession(sessionId)
      await load()
    } catch (error) {
      setError(String(error))
    } finally {
      setChatLoading(false)
    }
  }

  const headerActions = useMemo(
    () => (
      <>
        <Button
          size="sm"
          variant="ghost"
          onClick={load}
          disabled={loading}
          aria-label="Refresh history"
        >
          <RotateCcw />
        </Button>
        <Button size="sm" onClick={newSession}>
          <Plus data-icon="inline-start" />
          New session
        </Button>
      </>
    ),
    [loading]
  )
  usePageActions(headerActions)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      {error && (
        <div className="mx-6 mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,0.4fr)_minmax(320px,1fr)] overflow-hidden">
        <div className="min-h-0 overflow-y-auto border-r border-border bg-card">
          <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {items.length === 1
              ? "1 session"
              : `${items.length} sessions`}
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
                  <div className="border-b border-border pb-3">
                    <h3 className="line-clamp-2 text-sm font-semibold">
                      {selectedSession.title}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {dateFormatter.format(new Date(selectedSession.createdAt))}
                      {selectedSession.workingDirectory
                        ? ` · ${selectedSession.workingDirectory}`
                        : ""}
                    </p>
                  </div>

                  <div className="flex flex-col gap-3">
                    {selectedSession.messages.map(message => {
                      const screenshots =
                        message.screenshots ??
                        message.screenshotDataUrls?.map((dataUrl, index) => ({
                          path: message.screenshotPaths?.[index] ?? `${message.id}-${index}`,
                          dataUrl,
                        })) ??
                        []

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
                            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-60">
                              {message.role}
                            </div>
                            {screenshots.length > 0 && (
                              <div className="mb-2 grid grid-cols-2 gap-2">
                                {screenshots.map(screenshot => (
                                  <img
                                    key={screenshot.path}
                                    src={screenshot.dataUrl}
                                    alt="Screenshot"
                                    className="max-h-44 rounded border border-current/10 object-cover"
                                  />
                                ))}
                              </div>
                            )}
                            <MarkdownMessage markdown={message.content} className="text-sm leading-relaxed" />
                          </div>
                        </div>
                      )
                    })}
                    {chatLoading && (
                      <div className="flex justify-start">
                        <div className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          Replying...
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
