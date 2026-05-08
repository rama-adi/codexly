import React, { useEffect, useMemo, useState } from "react"
import { MessageSquareText, Plus, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
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
  const [selectedSession, setSelectedSession] = useState<ChatSession | null>(null)
  const [loading, setLoading] = useState(true)
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
    window.electronAPI.getChatSession(selectedIndexItem.id)
      .then(setSelectedSession)
      .catch(error => setError(String(error)))
  }, [selectedIndexItem])

  const newSession = async () => {
    await window.electronAPI.newChatSession()
    await load()
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">History</h2>
          <p className="mt-1 text-xs text-[#5f6368]">
            {items.length === 1 ? "1 saved session" : `${items.length} saved sessions`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RotateCcw data-icon="inline-start" />
            Refresh
          </Button>
          <Button size="sm" onClick={newSession}>
            <Plus data-icon="inline-start" />
            New session
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(190px,0.42fr)_minmax(260px,1fr)] overflow-hidden rounded-md border border-black/10 bg-white">
        <div className="min-h-0 overflow-y-auto border-r border-black/10">
          {items.length === 0 ? (
            <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 p-6 text-center">
              <MessageSquareText className="text-[#5f6368]" />
              <div className="text-sm font-medium">No history yet</div>
              <div className="max-w-56 text-xs leading-relaxed text-[#5f6368]">
                Toolbar sessions will appear here after the first answer.
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
                  className={`flex min-h-16 w-full flex-col items-start gap-1 border-b border-black/10 px-3 py-2 text-left transition-colors ${
                    active ? "bg-[#eeeeea]" : "hover:bg-[#f7f7f5]"
                  }`}
                >
                  <span className="line-clamp-2 text-sm font-medium leading-snug text-[#1f2328]">
                    {item.title}
                  </span>
                  <span className="text-xs text-[#5f6368]">
                    {dateFormatter.format(new Date(item.updatedAt))} · {item.messageCount} messages
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="min-h-0 overflow-y-auto">
          {selectedSession ? (
            <div className="flex min-h-full flex-col gap-4 p-4">
              <div className="border-b border-black/10 pb-3">
                <h3 className="line-clamp-2 text-sm font-semibold">
                  {selectedSession.title}
                </h3>
                <p className="mt-1 text-xs text-[#5f6368]">
                  {dateFormatter.format(new Date(selectedSession.createdAt))}
                  {selectedSession.workingDirectory ? ` · ${selectedSession.workingDirectory}` : ""}
                </p>
              </div>

              <div className="flex flex-col gap-3">
                {selectedSession.messages.map(message => (
                  <div
                    key={message.id}
                    className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[86%] rounded-md px-3 py-2 text-sm leading-relaxed ${
                        message.role === "user"
                          ? "bg-[#1f2328] text-white"
                          : "border border-black/10 bg-[#f7f7f5] text-[#1f2328]"
                      }`}
                    >
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide opacity-60">
                        {message.role}
                      </div>
                      <div className="whitespace-pre-wrap break-words">
                        {message.content}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-56 items-center justify-center p-6 text-sm text-[#5f6368]">
              Select a history item.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export default History
