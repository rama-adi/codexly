import { type FormEvent, useEffect, useRef, useState } from 'react'

import { desktopClient } from '../desktop'
import { CommandBar } from './components/CommandBar'
import { ChatPanel } from './components/ChatPanel'
import { ScreenshotQueue } from './components/ScreenshotQueue'
import { SolutionPanel } from './components/SolutionPanel'
import './overlay.css'
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
        answerRef.current = ''
        setAnswer('')
        reasoningRef.current = ''
        setReasoning('')
        setStreaming(false)
        setActivities([])
        setView('queue')
      } else if (event.type === 'transcript.reasoning') {
        if (sessionId && event.sessionId !== sessionId) return
        setView((current) => (current === 'chat' ? 'chat' : 'solution'))
        reasoningRef.current += event.text
        setReasoning(reasoningRef.current)
        setStreaming(true)
      } else if (event.type === 'transcript.delta') {
        if (sessionId && event.sessionId !== sessionId) return
        setView((current) => (current === 'chat' ? 'chat' : 'solution'))
        answerRef.current += event.text
        setAnswer(answerRef.current)
        setStreaming(true)
      } else if (event.type === 'transcript.complete') {
        if (sessionId && event.sessionId !== sessionId) return
        setStreaming(false)
        setMessages((current) =>
          answerRef.current ? [...current, { role: 'assistant', content: answerRef.current }] : current,
        )
        setNotice('Response complete.')
      } else if (event.type === 'transcript.failed') {
        setStreaming(false)
        setNotice(event.message)
      } else if (event.type === 'tool.status') {
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
        setActivities((current) =>
          current.map((activity) =>
            activity.activityId === event.activityId ? { ...activity, output: event.text } : activity,
          ),
        )
      } else if (event.type === 'settings.changed') {
        setAnswerHeight(event.settings.appearance.answerHeight)
      }
    })
  }, [sessionId])

  useEffect(() => {
    if (!root.current || !desktopClient.available) return
    const resize = () => {
      if (!root.current) return
      const width = Math.ceil(Math.min(900, Math.max(360, root.current.scrollWidth)))
      const height = Math.ceil(Math.min(1000, Math.max(48, root.current.scrollHeight)))
      void desktopClient.resizeOverlay(width, height)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(root.current)
    resize()
    return () => observer.disconnect()
  }, [view, attachments.length, answer, messages.length, activities.length])

  useEffect(() => {
    if (view === 'chat') requestAnimationFrame(() => input.current?.focus())
  }, [view])

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
    answerRef.current = ''
    setAnswer('')
    reasoningRef.current = ''
    setReasoning('')
    setActivities([])
    setStreaming(true)
    setBusy(true)
    try {
      const result = await desktopClient.solvePending(modelId)
      setSessionId(result.sessionId)
      setTurnId(result.turnId)
    } catch (error) {
      setStreaming(false)
      setNotice(error instanceof Error ? error.message : 'Unable to process screenshots.')
      setView('queue')
    } finally {
      setBusy(false)
    }
  }

  const sendChat = async (event: FormEvent) => {
    event.preventDefault()
    const message = chatInput.trim()
    if (!message || streaming) return
    setMessages((current) => [...current, { role: 'user', content: message }])
    setChatInput('')
    answerRef.current = ''
    setAnswer('')
    reasoningRef.current = ''
    setReasoning('')
    setActivities([])
    setStreaming(true)
    try {
      const result = await desktopClient.sendMessage({
        ...(sessionId ? { sessionId } : {}),
        message,
        modelId,
        attachmentIds: attachments.map((attachment) => attachment.id),
      })
      setSessionId(result.sessionId)
      setTurnId(result.turnId)
    } catch (error) {
      setStreaming(false)
      setNotice(error instanceof Error ? error.message : 'Unable to send message.')
    }
  }

  const clear = async () => {
    await desktopClient.clearAttachments()
    setAttachments([])
    answerRef.current = ''
    setAnswer('')
    reasoningRef.current = ''
    setReasoning('')
    setActivities([])
    setView('queue')
  }

  const reset = async () => {
    await clear()
    const session = await desktopClient.createSession()
    setSessionId(session.id)
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
            setView('queue')
            setAnswer('')
            setReasoning('')
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
