import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'

import { desktopClient } from '../desktop'
import { CommandBar } from './components/CommandBar'
import { ChatPanel } from './components/ChatPanel'
import { ScreenshotQueue } from './components/ScreenshotQueue'
import { SolutionPanel } from './components/SolutionPanel'
import './overlay.css'
import { matchTurnScope, type TurnScope } from './stream-state'
import type { Attachment, ChatMessage, ModelChoice, ToolActivity, View } from './types'

const FALLBACK_MODELS: ModelChoice[] = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4' },
]
const DEFAULT_ANSWER_HEIGHT = 340
const MAX_TOOL_OUTPUT_LENGTH = 64 * 1024

function appendToolOutput(current: string | undefined, chunk: string) {
  const existing = current ?? ''
  if (existing.length >= MAX_TOOL_OUTPUT_LENGTH) return existing
  return existing + chunk.slice(0, MAX_TOOL_OUTPUT_LENGTH - existing.length)
}

type ActiveRequest = {
  kind: 'solve' | 'chat'
  scope: TurnScope
  commandSettled: boolean
  terminal: boolean
  dismissed: boolean
  stopPromise?: Promise<boolean>
}

export function Overlay() {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const answerRef = useRef('')
  const reasoningRef = useRef('')
  const sessionIdRef = useRef<string>()
  const activeTurnRef = useRef<TurnScope>()
  const activeRequestRef = useRef<ActiveRequest>()
  const ignoredTurnIdsRef = useRef(new Set<string>())
  const actionLocksRef = useRef(new Set<string>())
  const pendingToolOutputsRef = useRef(new Map<string, string>())
  const removedAttachmentIdsRef = useRef(new Set<string>())
  const attachmentLoadInvalidatedRef = useRef(false)
  const streamFrameRef = useRef<number>()

  const [view, setView] = useState<View>('queue')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [answer, setAnswer] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [streamError, setStreamError] = useState<string>()
  const [streaming, setStreaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activities, setActivities] = useState<ToolActivity[]>([])
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string>()
  const [turnId, setTurnId] = useState<string>()
  const [models, setModels] = useState<ModelChoice[]>(FALLBACK_MODELS)
  const [modelId, setModelId] = useState(FALLBACK_MODELS[0].id)
  const [answerHeight, setAnswerHeight] = useState(DEFAULT_ANSWER_HEIGHT)
  const [notice, setNotice] = useState('Screenshot queue ready.')
  const [visibleError, setVisibleError] = useState<string>()

  const updateSessionId = useCallback((value: string | undefined) => {
    sessionIdRef.current = value
    setSessionId(value)
  }, [])

  const reportError = useCallback((error: unknown, fallback: string) => {
    const message = error instanceof Error && error.message ? error.message : fallback
    setNotice(message)
    setVisibleError(message)
  }, [])

  const retireTurn = useCallback((turnId: string | undefined) => {
    if (!turnId) return
    const ignored = ignoredTurnIdsRef.current
    ignored.add(turnId)
    if (ignored.size > 64) ignored.delete(ignored.values().next().value as string)
  }, [])

  const finishRequest = useCallback((request: ActiveRequest) => {
    if (activeRequestRef.current !== request) return
    activeRequestRef.current = undefined
    activeTurnRef.current = undefined
    setTurnId(undefined)
    setStreaming(false)
    setBusy(false)
  }, [])

  const stopRequest = useCallback(
    (request: ActiveRequest, turnIdToStop: string) => {
      if (request.stopPromise) return request.stopPromise
      request.stopPromise = desktopClient
        .stopTurn(turnIdToStop)
        .then((stopped) => {
          if (!stopped) {
            throw new Error('The response could not be stopped. It is still running.')
          }
          retireTurn(turnIdToStop)
          activeTurnRef.current = undefined
          if (request.commandSettled) finishRequest(request)
          return true
        })
        .catch((error) => {
          request.stopPromise = undefined
          if (!request.terminal && activeRequestRef.current === request) {
            request.dismissed = false
            activeTurnRef.current = request.scope
            setTurnId(request.scope.turnId)
            setStreaming(true)
            setBusy(true)
            setView(request.kind === 'solve' ? 'solution' : 'chat')
            reportError(error, 'Could not stop the active response. It is still running.')
          }
          return false
        })
      return request.stopPromise
    },
    [finishRequest, reportError, retireTurn],
  )

  const acceptEventScope = useCallback(
    (event: { sessionId: string; turnId: string }) => {
      const request = activeRequestRef.current
      if (!request || ignoredTurnIdsRef.current.has(event.turnId)) return undefined
      const scope = matchTurnScope(request.scope, event)
      if (!scope) return undefined
      request.scope = scope
      activeTurnRef.current = scope
      if (!sessionIdRef.current) updateSessionId(scope.sessionId)
      setTurnId(scope.turnId)
      return { request, scope }
    },
    [updateSessionId],
  )

  const settleCommand = useCallback(
    async (request: ActiveRequest, result: { sessionId: string; turnId: string }) => {
      if (activeRequestRef.current !== request) return
      request.commandSettled = true
      const scope = matchTurnScope(request.scope, result)
      if (!scope) {
        try {
          const stopped = await desktopClient.stopTurn(result.turnId)
          if (!stopped) {
            reportError(
              new Error('The conflicting response could not be stopped.'),
              'The conflicting response could not be stopped.',
            )
            return
          }
          retireTurn(result.turnId)
          reportError(
            new Error('The response identity changed while streaming. The conflicting turn was stopped.'),
            'The response could not be matched safely.',
          )
        } catch (error) {
          reportError(error, 'Could not stop the conflicting response.')
          return
        }
        finishRequest(request)
        return
      }
      request.scope = scope
      activeTurnRef.current = scope
      if (request.dismissed) {
        const stopped = await stopRequest(request, result.turnId)
        if (stopped) finishRequest(request)
        return
      }
      updateSessionId(scope.sessionId)
      setTurnId(scope.turnId)
      if (request.terminal) {
        finishRequest(request)
      }
    },
    [finishRequest, reportError, retireTurn, stopRequest, updateSessionId],
  )

  const flushStreamRender = useCallback(() => {
    if (streamFrameRef.current !== undefined) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = undefined
    }
    setAnswer(answerRef.current)
    setReasoning(reasoningRef.current)
  }, [])

  const queueStreamRender = useCallback(() => {
    if (streamFrameRef.current !== undefined) return
    streamFrameRef.current = requestAnimationFrame(() => {
      streamFrameRef.current = undefined
      setAnswer(answerRef.current)
      setReasoning(reasoningRef.current)
    })
  }, [])

  const resetTranscript = useCallback(() => {
    if (streamFrameRef.current !== undefined) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = undefined
    }
    answerRef.current = ''
    reasoningRef.current = ''
    pendingToolOutputsRef.current.clear()
    setAnswer('')
    setReasoning('')
    setStreamError(undefined)
  }, [])

  // Load canonical settings + available models once on mount.
  useEffect(() => {
    if (!desktopClient.available) return
    void desktopClient
      .getSettings()
      .then((settings) => {
        setAnswerHeight(settings.appearance.answerHeight)
        setModelId((current) =>
          current === FALLBACK_MODELS[0].id ? settings.assistant.model : current,
        )
      })
      .catch((error) => reportError(error, 'Could not load overlay settings.'))
    void desktopClient
      .listModels()
      .then((list) => {
        const visible = list.filter((model) => !model.hidden)
        if (!visible.length) return
        setModels(visible.map((model) => ({ id: model.id, displayName: model.displayName })))
        setModelId((current) => {
          if (visible.some((model) => model.id === current)) return current
          return visible.find((model) => model.isDefault)?.id ?? visible[0].id
        })
      })
      .catch((error) => reportError(error, 'Could not load available models.'))
  }, [reportError])

  useEffect(() => {
    if (!desktopClient.available) return
    void desktopClient
      .listAttachments()
      .then((loaded) => {
        if (attachmentLoadInvalidatedRef.current) return
        setAttachments((current) => {
          const currentIds = new Set(current.map((item) => item.id))
          return [
            ...current,
            ...loaded.filter(
              (item) =>
                !removedAttachmentIdsRef.current.has(item.id) && !currentIds.has(item.id),
            ),
          ].slice(0, 5)
        })
      })
      .catch((error) => reportError(error, 'Could not load the screenshot queue.'))

    return desktopClient.onProductEvent((event) => {
      // Turns started from the homepage (e.g. the history composer) stream
      // into that window; the overlay must not hijack them.
      if ('origin' in event && event.origin === 'homepage') return
      if (event.type === 'conversation.started') {
        if (event.consumedAttachmentIds.length) {
          const consumed = new Set(event.consumedAttachmentIds)
          event.consumedAttachmentIds.forEach((id) => removedAttachmentIdsRef.current.add(id))
          setAttachments((current) => current.filter((item) => !consumed.has(item.id)))
        }
        let request = activeRequestRef.current
        if (request) {
          const scope = matchTurnScope(request.scope, event)
          if (!scope) return
          request.scope = scope
          activeTurnRef.current = scope
          if (request.dismissed) {
            void stopRequest(request, event.turnId)
            return
          }
        } else {
          request = {
            kind: event.consumedAttachmentIds.length ? 'solve' : 'chat',
            scope: { sessionId: event.sessionId, turnId: event.turnId },
            commandSettled: true,
            terminal: false,
            dismissed: false,
          }
          activeRequestRef.current = request
          activeTurnRef.current = request.scope
          resetTranscript()
          setActivities([])
          setVisibleError(undefined)
        }
        updateSessionId(event.sessionId)
        setTurnId(event.turnId)
        setStreaming(true)
        setBusy(true)
        if (event.consumedAttachmentIds.length) {
          setView('solution')
        } else if (request.kind === 'chat') {
          setView('chat')
        }
        return
      }
      if (event.type === 'overlay.opened') {
        if (!event.fresh && event.sessionId === sessionIdRef.current) return
        const active = activeRequestRef.current
        if (active) {
          active.dismissed = true
          const knownTurnId = active.scope.turnId
          if (knownTurnId) void stopRequest(active, knownTurnId)
        } else {
          activeTurnRef.current = undefined
          setStreaming(false)
          setBusy(false)
        }
        resetTranscript()
        setActivities([])
        setMessages([])
        setTurnId(undefined)
        updateSessionId(event.sessionId ?? undefined)
        if (event.sessionId) {
          // Continuing a session from history: preload its conversation.
          const continuedId = event.sessionId
          setView('chat')
          void desktopClient
            .getSession(continuedId)
            .then((session) => {
              if (!session || sessionIdRef.current !== continuedId) return
              setMessages(
                session.messages
                  .filter((message) => message.role === 'user' || message.role === 'assistant')
                  .map((message) => ({
                    role: message.role as 'user' | 'assistant',
                    content: message.content,
                  })),
              )
            })
            .catch((error) => reportError(error, 'Could not load the continued session.'))
        } else {
          setView('queue')
        }
        return
      }
      if (event.type === 'attachment.captured') {
        const attachment = event.attachment as Attachment
        removedAttachmentIdsRef.current.delete(attachment.id)
        setAttachments((current) =>
          current.some((item) => item.id === attachment.id)
            ? current
            : [...current, attachment].slice(0, 5),
        )
        setNotice('Screenshot captured.')
      } else if (event.type === 'attachments.cleared') {
        attachmentLoadInvalidatedRef.current = true
        setAttachments([])
        setNotice('Screenshot queue cleared.')
      } else if (event.type === 'transcript.reasoning') {
        if (!acceptEventScope(event)) return
        reasoningRef.current += event.text
        queueStreamRender()
      } else if (event.type === 'transcript.delta') {
        if (!acceptEventScope(event)) return
        answerRef.current += event.text
        setStreamError(undefined)
        queueStreamRender()
      } else if (event.type === 'transcript.complete') {
        const accepted = acceptEventScope(event)
        if (!accepted) return
        flushStreamRender()
        accepted.request.terminal = true
        retireTurn(event.turnId)
        activeTurnRef.current = undefined
        setTurnId(undefined)
        setStreaming(false)
        if (!answerRef.current.trim()) {
          setStreamError('Codex completed without returning an answer. Please try again.')
        }
        setMessages((current) =>
          answerRef.current ? [...current, { role: 'assistant', content: answerRef.current }] : current,
        )
        setNotice('Response complete.')
        if (accepted.request.commandSettled) finishRequest(accepted.request)
      } else if (event.type === 'transcript.failed') {
        const accepted = acceptEventScope(event)
        if (!accepted) return
        flushStreamRender()
        accepted.request.terminal = true
        retireTurn(event.turnId)
        activeTurnRef.current = undefined
        setTurnId(undefined)
        setStreaming(false)
        setStreamError(event.message)
        if (accepted.request.kind === 'chat' && answerRef.current) {
          const partialAnswer = answerRef.current
          setMessages((current) => [...current, { role: 'assistant', content: partialAnswer }])
          answerRef.current = ''
          setAnswer('')
        }
        setNotice(event.message)
        if (accepted.request.commandSettled) finishRequest(accepted.request)
      } else if (event.type === 'tool.status') {
        if (!acceptEventScope(event)) return
        const key = event.activityId ?? event.name
        setActivities((current) => {
          const index = current.findIndex((activity) => activity.key === key)
          const next: ToolActivity = {
            key,
            activityId: event.activityId,
            name: event.name,
            state: event.state,
            detail: event.detail,
            output:
              (event.activityId && pendingToolOutputsRef.current.get(event.activityId)) ??
              (index >= 0 ? current[index].output : undefined),
          }
          if (event.activityId) pendingToolOutputsRef.current.delete(event.activityId)
          if (index >= 0) {
            const copy = current.slice()
            copy[index] = next
            return copy
          }
          return [...current, next]
        })
      } else if (event.type === 'tool.output') {
        if (!acceptEventScope(event)) return
        setActivities((current) => {
          if (!current.some((activity) => activity.activityId === event.activityId)) {
            pendingToolOutputsRef.current.set(
              event.activityId,
              appendToolOutput(pendingToolOutputsRef.current.get(event.activityId), event.text),
            )
            return current
          }
          return current.map((activity) =>
            activity.activityId === event.activityId
              ? { ...activity, output: appendToolOutput(activity.output, event.text) }
              : activity,
          )
        })
      } else if (event.type === 'settings.changed') {
        setAnswerHeight(event.settings.appearance.answerHeight)
      }
    })
  }, [
    acceptEventScope,
    finishRequest,
    flushStreamRender,
    queueStreamRender,
    reportError,
    resetTranscript,
    retireTurn,
    stopRequest,
    updateSessionId,
  ])

  useEffect(
    () => () => {
      if (streamFrameRef.current !== undefined) cancelAnimationFrame(streamFrameRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!root.current || !desktopClient.available) return
    let frame: number | undefined
    let lastWidth = 0
    let lastHeight = 0
    const resize = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!root.current) return
        const width = Math.ceil(Math.min(900, Math.max(360, root.current.scrollWidth)))
        const height = Math.ceil(Math.min(1000, Math.max(48, root.current.scrollHeight)))
        if (width === lastWidth && height === lastHeight) return
        lastWidth = width
        lastHeight = height
        void desktopClient.resizeOverlay(width, height).catch(() => undefined)
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(root.current)
    resize()
    return () => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [])

  const capture = async () => {
    if (actionLocksRef.current.has('capture')) return
    actionLocksRef.current.add('capture')
    setVisibleError(undefined)
    try {
      await desktopClient.capture()
    } catch (error) {
      reportError(error, 'Capture failed.')
    } finally {
      actionLocksRef.current.delete('capture')
    }
  }

  const captureSelection = async () => {
    if (actionLocksRef.current.has('selection')) return
    actionLocksRef.current.add('selection')
    setVisibleError(undefined)
    try {
      await desktopClient.captureSelection()
    } catch (error) {
      reportError(error, 'Selection capture failed.')
    } finally {
      actionLocksRef.current.delete('selection')
    }
  }

  const solve = async () => {
    if (!attachments.length || activeRequestRef.current) return
    const consumedIds = new Set(attachments.map((attachment) => attachment.id))
    setView('solution')
    const request: ActiveRequest = {
      kind: 'solve',
      scope: { sessionId: sessionIdRef.current },
      commandSettled: false,
      terminal: false,
      dismissed: false,
    }
    activeRequestRef.current = request
    activeTurnRef.current = request.scope
    resetTranscript()
    setVisibleError(undefined)
    setActivities([])
    setTurnId(undefined)
    setStreaming(true)
    setBusy(true)
    try {
      const result = await desktopClient.solvePending(modelId)
      if (activeRequestRef.current !== request) return
      consumedIds.forEach((id) => removedAttachmentIdsRef.current.add(id))
      setAttachments((current) => current.filter((item) => !consumedIds.has(item.id)))
      await settleCommand(request, result)
    } catch (error) {
      if (activeRequestRef.current !== request) return
      request.commandSettled = true
      finishRequest(request)
      if (!request.dismissed) {
        reportError(error, 'Unable to process screenshots.')
        setView('queue')
      }
    }
  }

  const sendChat = async (event: FormEvent) => {
    event.preventDefault()
    const message = chatInput.trim()
    if (!message || activeRequestRef.current) return
    setMessages((current) => [...current, { role: 'user', content: message }])
    setChatInput('')
    const request: ActiveRequest = {
      kind: 'chat',
      scope: { sessionId: sessionIdRef.current },
      commandSettled: false,
      terminal: false,
      dismissed: false,
    }
    activeRequestRef.current = request
    activeTurnRef.current = request.scope
    resetTranscript()
    setActivities([])
    setTurnId(undefined)
    setStreaming(true)
    setBusy(true)
    setVisibleError(undefined)
    try {
      const result = await desktopClient.sendMessage({
        ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
        message,
        modelId,
        attachmentIds: attachments.map((attachment) => attachment.id),
      })
      await settleCommand(request, result)
    } catch (error) {
      if (activeRequestRef.current !== request) return
      request.commandSettled = true
      finishRequest(request)
      setMessages((current) => {
        const last = current[current.length - 1]
        return last?.role === 'user' && last.content === message ? current.slice(0, -1) : current
      })
      setChatInput((current) => current || message)
      const messageText = error instanceof Error ? error.message : 'Unable to send message.'
      setStreamError(`Message was not sent: ${messageText}`)
      reportError(error, 'Unable to send message.')
    }
  }

  const clear = async () => {
    if (actionLocksRef.current.has('clear') || activeRequestRef.current) return false
    actionLocksRef.current.add('clear')
    setVisibleError(undefined)
    try {
      await desktopClient.clearAttachments()
      attachmentLoadInvalidatedRef.current = true
      setAttachments([])
      resetTranscript()
      setActivities([])
      setView('queue')
      return true
    } catch (error) {
      reportError(error, 'Could not clear the screenshot queue.')
      return false
    } finally {
      actionLocksRef.current.delete('clear')
    }
  }

  const reset = async () => {
    if (actionLocksRef.current.has('reset') || activeRequestRef.current) return
    actionLocksRef.current.add('reset')
    setVisibleError(undefined)
    try {
      await desktopClient.clearAttachments()
      attachmentLoadInvalidatedRef.current = true
      setAttachments([])
      const session = await desktopClient.createSession()
      updateSessionId(session.id)
      resetTranscript()
      setActivities([])
      setTurnId(undefined)
      setMessages([])
      setView('queue')
      setNotice('New session ready.')
    } catch (error) {
      reportError(error, 'Could not reset the session.')
    } finally {
      actionLocksRef.current.delete('reset')
    }
  }

  const discard = async (id: string) => {
    const lock = `discard:${id}`
    if (actionLocksRef.current.has(lock)) return
    actionLocksRef.current.add(lock)
    setVisibleError(undefined)
    try {
      await desktopClient.discardAttachment(id)
      removedAttachmentIdsRef.current.add(id)
      setAttachments((current) => current.filter((item) => item.id !== id))
    } catch (error) {
      reportError(error, 'Could not remove the screenshot. It is still queued.')
    } finally {
      actionLocksRef.current.delete(lock)
    }
  }

  const dismissSolution = () => {
    const request = activeRequestRef.current
    setView('queue')
    if (!request) {
      setStreaming(false)
      return
    }
    request.dismissed = true
    if (request.terminal) {
      if (request.commandSettled) finishRequest(request)
      return
    }
    const knownTurnId = request.scope.turnId
    if (knownTurnId) void stopRequest(request, knownTurnId)
  }

  const stopActiveChat = () => {
    const request = activeRequestRef.current
    const knownTurnId = request?.scope.turnId
    if (!request || !knownTurnId) return
    request.dismissed = true
    setStreamError('Response stopped.')
    void stopRequest(request, knownTurnId)
  }

  const openSettings = async () => {
    if (actionLocksRef.current.has('settings')) return
    actionLocksRef.current.add('settings')
    setVisibleError(undefined)
    try {
      await desktopClient.openHome()
      await desktopClient.toggleOverlay()
    } catch (error) {
      reportError(error, 'Could not open settings.')
    } finally {
      actionLocksRef.current.delete('settings')
    }
  }

  const hideOverlay = async () => {
    if (actionLocksRef.current.has('hide')) return
    actionLocksRef.current.add('hide')
    setVisibleError(undefined)
    try {
      await desktopClient.toggleOverlay()
    } catch (error) {
      reportError(error, 'Could not hide the overlay.')
    } finally {
      actionLocksRef.current.delete('hide')
    }
  }

  const modelLabel = models.find((model) => model.id === modelId)?.displayName ?? modelId

  return (
    <div ref={root} className="ov-root" data-clickable-root>
      <span className="sr-only" aria-live="polite">
        {notice}
      </span>

      <CommandBar
        attachments={attachments.length}
        chatOpen={view === 'chat'}
        busy={busy}
        models={models}
        modelId={modelId}
        onModelChange={setModelId}
        onCapture={() => void capture()}
        onCaptureSelection={() => void captureSelection()}
        onSolve={() => void solve()}
        onClear={() => void clear()}
        onReset={() => void reset()}
        onChat={() => setView((current) => (current === 'chat' ? 'queue' : 'chat'))}
        onSettings={() => void openSettings()}
        onClose={() => void hideOverlay()}
      />

      {visibleError && <div className="ov-visible-notice" role="alert">{visibleError}</div>}

      {view === 'queue' && (
        <ScreenshotQueue
          attachments={attachments}
          onDiscard={(id) => void discard(id)}
        />
      )}

      {view === 'solution' && (
        <SolutionPanel
          answer={answer}
          reasoning={reasoning}
          error={streamError}
          streaming={streaming}
          modelLabel={modelLabel}
          activities={activities}
          answerHeight={answerHeight}
          onClose={dismissSolution}
        />
      )}

      {view === 'chat' && (
        <ChatPanel
          sessionLabel={sessionId ? 'Current session' : 'New session'}
          modelLabel={modelLabel}
          messages={messages}
          answer={answer}
          reasoning={reasoning}
          error={streamError}
          streaming={streaming}
          activities={activities}
          answerHeight={answerHeight}
          chatInput={chatInput}
          canStop={Boolean(turnId)}
          inputRef={input}
          onChatInputChange={setChatInput}
          onSend={sendChat}
          onStop={stopActiveChat}
          onClose={() => setView('queue')}
        />
      )}

    </div>
  )
}
