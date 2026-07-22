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

export function Overlay() {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const answerRef = useRef('')
  const reasoningRef = useRef('')
  const sessionIdRef = useRef<string>()
  const activeTurnRef = useRef<TurnScope>()
  const streamFrameRef = useRef<number>()
  const requestSequenceRef = useRef(0)

  const [view, setView] = useState<View>('queue')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [answer, setAnswer] = useState('')
  const [reasoning, setReasoning] = useState('')
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

  const updateSessionId = useCallback((value: string | undefined) => {
    sessionIdRef.current = value
    setSessionId(value)
  }, [])

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
    setAnswer('')
    setReasoning('')
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
      .catch(() => undefined)
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
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!desktopClient.available) return
    void desktopClient.listAttachments().then(setAttachments).catch(() => undefined)

    return desktopClient.onProductEvent((event) => {
      // Turns started from the homepage (e.g. the history composer) stream
      // into that window; the overlay must not hijack them.
      if ('origin' in event && event.origin === 'homepage') return
      if (event.type === 'overlay.opened') {
        if (!event.fresh && event.sessionId === sessionIdRef.current) return
        requestSequenceRef.current += 1
        activeTurnRef.current = undefined
        resetTranscript()
        setStreaming(false)
        setBusy(false)
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
            .catch(() => undefined)
        } else {
          setView('queue')
        }
        return
      }
      if (event.type === 'attachment.captured') {
        const attachment = event.attachment as Attachment
        setAttachments((current) =>
          current.some((item) => item.id === attachment.id)
            ? current
            : [...current, attachment].slice(0, 5),
        )
        setNotice('Screenshot captured.')
      } else if (event.type === 'attachments.cleared') {
        setAttachments([])
        requestSequenceRef.current += 1
        activeTurnRef.current = undefined
        resetTranscript()
        setStreaming(false)
        setBusy(false)
        setActivities([])
        setView('queue')
      } else if (event.type === 'transcript.reasoning') {
        const scope = matchTurnScope(activeTurnRef.current, event)
        if (!scope) return
        activeTurnRef.current = scope
        if (!sessionIdRef.current) updateSessionId(scope.sessionId)
        reasoningRef.current += event.text
        queueStreamRender()
      } else if (event.type === 'transcript.delta') {
        const scope = matchTurnScope(activeTurnRef.current, event)
        if (!scope) return
        activeTurnRef.current = scope
        if (!sessionIdRef.current) updateSessionId(scope.sessionId)
        answerRef.current += event.text
        queueStreamRender()
      } else if (event.type === 'transcript.complete') {
        const scope = matchTurnScope(activeTurnRef.current, event)
        if (!scope) return
        flushStreamRender()
        activeTurnRef.current = undefined
        setTurnId(undefined)
        setStreaming(false)
        setMessages((current) =>
          answerRef.current ? [...current, { role: 'assistant', content: answerRef.current }] : current,
        )
        setNotice('Response complete.')
      } else if (event.type === 'transcript.failed') {
        const scope = matchTurnScope(activeTurnRef.current, event)
        if (!scope) return
        flushStreamRender()
        activeTurnRef.current = undefined
        setTurnId(undefined)
        setStreaming(false)
        setNotice(event.message)
      } else if (event.type === 'tool.status') {
        const scope = matchTurnScope(activeTurnRef.current, event)
        if (!scope) return
        activeTurnRef.current = scope
        if (!sessionIdRef.current) updateSessionId(scope.sessionId)
        const key = event.activityId ?? event.name
        setActivities((current) => {
          const index = current.findIndex((activity) => activity.key === key)
          const next: ToolActivity = {
            key,
            activityId: event.activityId,
            name: event.name,
            state: event.state,
            detail: event.detail,
            output: index >= 0 ? current[index].output : undefined,
          }
          if (index >= 0) {
            const copy = current.slice()
            copy[index] = next
            return copy
          }
          return [...current, next]
        })
      } else if (event.type === 'tool.output') {
        const scope = matchTurnScope(activeTurnRef.current, event)
        if (!scope) return
        activeTurnRef.current = scope
        if (!sessionIdRef.current) updateSessionId(scope.sessionId)
        setActivities((current) =>
          current.map((activity) =>
            activity.activityId === event.activityId ? { ...activity, output: event.text } : activity,
          ),
        )
      } else if (event.type === 'settings.changed') {
        setAnswerHeight(event.settings.appearance.answerHeight)
      }
    })
  }, [flushStreamRender, queueStreamRender, resetTranscript, updateSessionId])

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
        void desktopClient.resizeOverlay(width, height)
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
    try {
      await desktopClient.capture()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Capture failed.')
    }
  }

  const captureSelection = async () => {
    try {
      await desktopClient.captureSelection()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Selection capture failed.')
    }
  }

  const solve = async () => {
    if (!attachments.length) return
    setView('solution')
    const requestSequence = ++requestSequenceRef.current
    activeTurnRef.current = { sessionId: sessionIdRef.current }
    resetTranscript()
    setActivities([])
    setTurnId(undefined)
    setStreaming(true)
    setBusy(true)
    try {
      const result = await desktopClient.solvePending(modelId)
      if (requestSequence !== requestSequenceRef.current) return
      if (activeTurnRef.current) {
        activeTurnRef.current = result
        setTurnId(result.turnId)
      }
      updateSessionId(result.sessionId)
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) return
      activeTurnRef.current = undefined
      setStreaming(false)
      setNotice(error instanceof Error ? error.message : 'Unable to process screenshots.')
      setView('queue')
    } finally {
      if (requestSequence === requestSequenceRef.current) setBusy(false)
    }
  }

  const sendChat = async (event: FormEvent) => {
    event.preventDefault()
    const message = chatInput.trim()
    if (!message || streaming) return
    setMessages((current) => [...current, { role: 'user', content: message }])
    setChatInput('')
    const requestSequence = ++requestSequenceRef.current
    activeTurnRef.current = { sessionId: sessionIdRef.current }
    resetTranscript()
    setActivities([])
    setTurnId(undefined)
    setStreaming(true)
    try {
      const result = await desktopClient.sendMessage({
        ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
        message,
        modelId,
        attachmentIds: attachments.map((attachment) => attachment.id),
      })
      if (requestSequence !== requestSequenceRef.current) return
      if (activeTurnRef.current) {
        activeTurnRef.current = result
        setTurnId(result.turnId)
      }
      updateSessionId(result.sessionId)
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) return
      activeTurnRef.current = undefined
      setStreaming(false)
      setNotice(error instanceof Error ? error.message : 'Unable to send message.')
    }
  }

  const clear = async () => {
    await desktopClient.clearAttachments()
    setAttachments([])
    requestSequenceRef.current += 1
    activeTurnRef.current = undefined
    resetTranscript()
    setActivities([])
    setView('queue')
  }

  const reset = async () => {
    await clear()
    const session = await desktopClient.createSession()
    updateSessionId(session.id)
    setTurnId(undefined)
    setMessages([])
    setNotice('New session ready.')
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
        onSettings={() =>
          void (async () => {
            await desktopClient.openHome()
            await desktopClient.toggleOverlay()
          })()
        }
        onClose={() => void desktopClient.toggleOverlay()}
      />

      {view === 'queue' && (
        <ScreenshotQueue
          attachments={attachments}
          onDiscard={(id) => {
            void desktopClient.discardAttachment(id)
            setAttachments((current) => current.filter((item) => item.id !== id))
          }}
        />
      )}

      {view === 'solution' && (
        <SolutionPanel
          answer={answer}
          reasoning={reasoning}
          streaming={streaming}
          modelLabel={modelLabel}
          activities={activities}
          answerHeight={answerHeight}
          onClose={() => {
            requestSequenceRef.current += 1
            activeTurnRef.current = undefined
            setView('queue')
            resetTranscript()
            setStreaming(false)
          }}
        />
      )}

      {view === 'chat' && (
        <ChatPanel
          sessionLabel={sessionId ? 'Current session' : 'New session'}
          modelLabel={modelLabel}
          messages={messages}
          answer={answer}
          reasoning={reasoning}
          streaming={streaming}
          activities={activities}
          answerHeight={answerHeight}
          chatInput={chatInput}
          canStop={Boolean(turnId)}
          inputRef={input}
          onChatInputChange={setChatInput}
          onSend={sendChat}
          onStop={() => turnId && void desktopClient.stopTurn(turnId)}
          onClose={() => setView('queue')}
        />
      )}

    </div>
  )
}
