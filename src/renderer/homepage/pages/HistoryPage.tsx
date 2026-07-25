import * as React from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { StoreApi } from 'zustand/vanilla'
import {
  ChevronRight,
  Loader2,
  MessageSquareText,
  Play,
  Send,
  Square,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { SessionDetail, SessionSummary } from '../../desktop'
import { desktopClient } from '../../desktop'
import { activeTurnId, isBusy, isStreaming } from '../../shared/turn/turn-machine'
import { useConversationEventBridge } from '../hooks/useConversationEventBridge'
import { useSettings } from '../hooks/useSettings'
import { Markdown } from '../lib/markdown'
import { createConversationActions } from '../store/conversation-actions'
import { createConversationStore } from '../store/conversation-store'
import type { ConversationStoreState } from '../store/contract'

interface HistoryPageProps {
  sessions: SessionSummary[]
  available: boolean
  onReactivate: (id: string) => void
  onDelete: (id: string) => Promise<void>
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

export const HistoryPage: React.FC<HistoryPageProps> = ({
  sessions,
  available,
  onReactivate,
  onDelete,
}) => {
  // Assigned in an effect below, once `loadDetail` exists. The store only reads
  // it when a turn actually ends, which is always after the first commit.
  const onTurnEnded = React.useRef<(sessionId: string) => void>(() => undefined)

  // One store per mount, mirroring the overlay: fresh transcript buffers per
  // mount keep test runs isolated. A lazy `useState` initializer owns it so no
  // ref is written during render.
  const [store] = React.useState<StoreApi<ConversationStoreState>>(() =>
    createConversationStore({
      transport: { stopTurn: (id) => desktopClient.stopTurn(id) },
      onTurnEnded: (sessionId) => onTurnEnded.current(sessionId),
    }),
  )

  const actions = React.useMemo(
    () =>
      createConversationActions(store, {
        sendMessage: (payload) => desktopClient.sendMessage(payload),
      }),
    [store],
  )

  const s = useStore(
    store,
    useShallow((state) => ({
      sessionId: state.sessionId,
      turn: state.turn,
      answer: state.answer,
      reasoning: state.reasoning,
      thinkingExpanded: state.thinkingExpanded,
      pendingUser: state.pendingUser,
      composerText: state.composerText,
      composerError: state.composerError,
    })),
  )

  const [detail, setDetail] = React.useState<SessionDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [confirmTarget, setConfirmTarget] = React.useState<SessionSummary | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  // Resolved image previews for message attachments, keyed by attachment id.
  const [attachmentPreviews, setAttachmentPreviews] = React.useState<
    Record<string, { name: string; preview: string }>
  >({})

  const { settings } = useSettings()
  const modelId = settings?.assistant.model

  const scrollAnchorRef = React.useRef<HTMLDivElement | null>(null)
  const conversationRef = React.useRef<HTMLDivElement | null>(null)

  const streaming = isStreaming(s.turn)
  const busy = isBusy(s.turn)
  const stopTurnId = activeTurnId(s.turn)
  const selectedId = s.sessionId

  const loadDetail = React.useCallback(
    (sessionId: string) => {
      desktopClient
        .getSession(sessionId)
        .then((next) => {
          if (store.getState().sessionId === sessionId) setDetail(next)
        })
        .catch(() => undefined)
    },
    [store],
  )
  // Declared before the event bridge so the assignment lands before the bridge
  // subscribes and can deliver a turn-ended event.
  React.useEffect(() => {
    onTurnEnded.current = loadDetail
  }, [loadDetail])

  useConversationEventBridge(store)

  // Keep a valid selection as the session list changes. Switching sessions
  // abandons any in-flight turn in the store (it keeps running, and the refetch
  // below brings in whatever got persisted).
  React.useEffect(() => {
    const current = store.getState().sessionId
    if (sessions.length === 0) {
      store.getState().selectSession(null)
      return
    }
    if (!current || !sessions.some((session) => session.id === current)) {
      store.getState().selectSession(sessions[0].id)
    }
  }, [sessions, store])

  React.useEffect(() => {
    if (!selectedId || !available) {
      setDetail(null)
      return
    }
    let active = true
    setDetailLoading(true)
    desktopClient
      .getSession(selectedId)
      .then((next) => {
        if (active) setDetail(next)
      })
      .catch(() => {
        if (active) setDetail(null)
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })
    return () => {
      active = false
    }
  }, [selectedId, available, sessions])

  React.useEffect(() => {
    setAttachmentPreviews({})
  }, [selectedId])

  // Resolve previews for any image attachments referenced by the session's
  // messages. Stored blobs are recoverable by id even after the turn was sent.
  React.useEffect(() => {
    if (!detail || !available) return
    const ids = Array.from(new Set(detail.messages.flatMap((message) => message.attachmentIds)))
    const missing = ids.filter((id) => !attachmentPreviews[id])
    if (missing.length === 0) return
    let active = true
    desktopClient
      .getAttachmentPreviews(missing)
      .then((previews) => {
        if (!active || previews.length === 0) return
        setAttachmentPreviews((current) => {
          const next = { ...current }
          for (const preview of previews) {
            next[preview.id] = { name: preview.name, preview: preview.preview }
          }
          return next
        })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [detail, available, attachmentPreviews])

  React.useEffect(() => {
    if (!streaming && !s.pendingUser) return
    scrollAnchorRef.current?.scrollIntoView({ block: 'end' })
  }, [s.answer, s.reasoning, s.pendingUser, streaming])

  const canSend = Boolean(
    available && selectedId && modelId && s.composerText.trim() && !busy,
  )

  const handleSend = () => {
    if (!canSend || !modelId) return
    void actions.send(modelId)
  }

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  const confirmDelete = async () => {
    if (!confirmTarget) return
    setDeleting(true)
    try {
      await onDelete(confirmTarget.id)
      setConfirmTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="grid h-full grid-cols-[minmax(220px,280px)_minmax(0,1fr)] overflow-hidden">
      <div className="flex min-h-0 flex-col border-r border-border bg-secondary/30">
        <div className="flex h-10 shrink-0 items-center border-b border-border px-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {sessions.length === 1 ? '1 session' : `${sessions.length} sessions`}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 p-6 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <MessageSquareText className="size-5" />
              </span>
              <div className="text-sm font-medium text-foreground">No history yet</div>
              <p className="max-w-52 text-xs text-muted-foreground">
                Overlay conversations appear here after the first answer.
              </p>
            </div>
          ) : (
            sessions.map((session) => {
              const active = selectedId === session.id
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => store.getState().selectSession(session.id)}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 border-b border-border px-4 py-3 text-left transition-colors',
                    active ? 'bg-card' : 'hover:bg-card/60',
                  )}
                >
                  <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                    {session.title}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {dateFormatter.format(new Date(session.updatedAt))} ·{' '}
                    {session.messageCount} messages
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-col bg-background">
        {detailLoading && !detail ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading session…
          </div>
        ) : detail ? (
          <>
            <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
              <h2
                className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground"
                title={detail.title}
              >
                {detail.title}
              </h2>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!available}
                  onClick={() => onReactivate(detail.id)}
                >
                  <Play />
                  Continue
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete session"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    setConfirmTarget(
                      sessions.find((session) => session.id === detail.id) ?? null,
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <div ref={conversationRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-5">
                {detail.messages.filter((message) =>
                  message.role === 'user' || message.role === 'assistant',
                ).length === 0 &&
                !s.pendingUser &&
                !streaming ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    This session has no messages yet.
                  </p>
                ) : (
                  detail.messages
                    .filter(
                      (message) =>
                        message.role === 'user' || message.role === 'assistant',
                    )
                    .map((message) => (
                      <div
                        key={message.id}
                        className={cn(
                          'flex',
                          message.role === 'user' ? 'justify-end' : 'justify-start',
                        )}
                      >
                        <div
                          className={cn(
                            'max-w-[86%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                            message.role === 'user'
                              ? 'bg-primary text-primary-foreground'
                              : 'border border-border bg-card text-card-foreground',
                          )}
                        >
                          {message.attachmentIds.length > 0 && (
                            <div className="mb-2 flex flex-wrap gap-2">
                              {message.attachmentIds.map((id) => {
                                const preview = attachmentPreviews[id]
                                return preview ? (
                                  <img
                                    key={id}
                                    src={preview.preview}
                                    alt={preview.name}
                                    className="h-16 w-auto max-w-[160px] rounded-md border border-border/40 object-cover"
                                  />
                                ) : (
                                  <div
                                    key={id}
                                    className="h-16 w-24 animate-pulse rounded-md border border-border/40 bg-muted"
                                  />
                                )
                              })}
                            </div>
                          )}
                          {message.role === 'assistant' ? (
                            <Markdown text={message.content} />
                          ) : (
                            <p className="whitespace-pre-wrap">{message.content}</p>
                          )}
                        </div>
                      </div>
                    ))
                )}

                {s.pendingUser && (
                  <div className="flex justify-end">
                    <div className="max-w-[86%] rounded-2xl bg-primary px-3.5 py-2.5 text-sm leading-relaxed text-primary-foreground">
                      <p className="whitespace-pre-wrap">{s.pendingUser.content}</p>
                    </div>
                  </div>
                )}

                {streaming && (
                  <div className="flex justify-start">
                    <div className="max-w-[86%] rounded-2xl border border-border bg-card px-3.5 py-2.5 text-sm leading-relaxed text-card-foreground">
                      {s.reasoning && (
                        <div className="mb-2 border-b border-border/60 pb-2">
                          <button
                            type="button"
                            onClick={() =>
                              store.getState().set({ thinkingExpanded: !s.thinkingExpanded })
                            }
                            className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
                          >
                            <ChevronRight
                              className={cn(
                                'size-3 transition-transform',
                                s.thinkingExpanded && 'rotate-90',
                              )}
                            />
                            Thinking
                          </button>
                          {s.thinkingExpanded && (
                            <p className="mt-1 whitespace-pre-wrap text-xs italic leading-relaxed text-muted-foreground">
                              {s.reasoning}
                            </p>
                          )}
                        </div>
                      )}
                      {s.answer ? (
                        <Markdown text={s.answer} />
                      ) : (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          Thinking…
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div ref={scrollAnchorRef} />
              </div>
            </div>

            {s.composerError && (
              <div className="mx-6 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {s.composerError}
              </div>
            )}

            <div className="shrink-0 border-t border-border px-6 py-3">
              <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
                <Textarea
                  value={s.composerText}
                  onChange={(event) =>
                    store.getState().set({ composerText: event.target.value })
                  }
                  onKeyDown={handleComposerKeyDown}
                  placeholder={
                    available
                      ? 'Send a message to continue this conversation…'
                      : 'The desktop runtime is unavailable.'
                  }
                  disabled={!available || busy}
                  className="min-h-[44px] max-h-40 flex-1 resize-none"
                  rows={1}
                />
                {busy ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Stop generating"
                    disabled={!stopTurnId}
                    onClick={() => actions.stop()}
                  >
                    <Square />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon-sm"
                    aria-label="Send message"
                    disabled={!canSend}
                    onClick={handleSend}
                  >
                    <Send />
                  </Button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a session to view it.
          </div>
        )}
      </div>

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            <DialogDescription>
              This permanently removes the app-owned local history for “
              {confirmTarget?.title}”. Codex rollout files are untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => setConfirmTarget(null)}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={confirmDelete}>
              {deleting && <Loader2 className="animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
