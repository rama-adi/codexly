import {
  Camera,
  Copy,
  MessageSquare,
  RotateCcw,
  Send,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { desktopClient } from '../desktop'

type View = 'queue' | 'solution' | 'chat'
type Attachment = { id: string; name: string; preview: string }
type Tool = { name: string; state: 'running' | 'complete' | 'error' }

const Key = ({ children }: { children: ReactNode }) => (
  <span className="shortcut-key">{children}</span>
)

export function Overlay() {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const answerRef = useRef('')
  const [view, setView] = useState<View>('queue')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [answer, setAnswer] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [tools, setTools] = useState<Tool[]>([])
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [sessionId, setSessionId] = useState<string>()
  const [turnId, setTurnId] = useState<string>()
  const [modelId, setModelId] = useState('gpt-5.5')
  const [notice, setNotice] = useState('Screenshot queue ready.')

  useEffect(() => {
    if (!desktopClient.available) return
    void desktopClient.listAttachments().then(setAttachments).catch(() => undefined)
    return desktopClient.onProductEvent((event) => {
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
        setStreaming(false)
        setView('queue')
      } else if (event.type === 'transcript.delta') {
        if (sessionId && event.sessionId !== sessionId) return
        setView((current) => current === 'chat' ? 'chat' : 'solution')
        answerRef.current += event.text
        setAnswer(answerRef.current)
        setStreaming(true)
      } else if (event.type === 'transcript.complete') {
        if (sessionId && event.sessionId !== sessionId) return
        setStreaming(false)
        setMessages((current) => answerRef.current ? [...current, { role: 'assistant', content: answerRef.current }] : current)
        setNotice('Response complete.')
      } else if (event.type === 'transcript.failed') {
        setStreaming(false)
        setNotice(event.message)
      } else if (event.type === 'tool.status') {
        setTools((current) => [
          ...current.filter((tool) => tool.name !== event.name),
          { name: event.name, state: event.state },
        ])
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
  }, [view, attachments.length, answer, messages.length])

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

  const solve = async () => {
    if (!attachments.length) return
    setView('solution')
    answerRef.current = ''
    setAnswer('')
    setTools([])
    setStreaming(true)
    try {
      const result = await desktopClient.solvePending(modelId)
      setSessionId(result.sessionId)
      setTurnId(result.turnId)
    } catch (error) {
      setStreaming(false)
      setNotice(error instanceof Error ? error.message : 'Unable to process screenshots.')
      setView('queue')
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
    setTools([])
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

  return (
    <div ref={root} className="legacy-overlay-root" data-clickable-root>
      <span className="sr-only" aria-live="polite">{notice}</span>
      <CommandBar
        attachments={attachments.length}
        chatOpen={view === 'chat'}
        onCapture={() => void capture()}
        onSolve={() => void solve()}
        onClear={() => void clear()}
        onReset={() => void reset()}
        onChat={() => setView((current) => current === 'chat' ? 'queue' : 'chat')}
        onSettings={() => void (async () => {
          await desktopClient.openHome()
          await desktopClient.toggleOverlay()
        })()}
        onClose={() => void desktopClient.toggleOverlay()}
      />

      {view === 'queue' && attachments.length > 0 && (
        <div className="screenshot-queue">
          {attachments.map((attachment, index) => (
            <figure key={attachment.id} className="screenshot-item">
              <img src={attachment.preview} alt={`Screenshot ${index + 1}`} />
              <button aria-label={`Delete screenshot ${index + 1}`} onClick={() => {
                void desktopClient.discardAttachment(attachment.id)
                setAttachments((current) => current.filter((item) => item.id !== attachment.id))
              }}><X /></button>
            </figure>
          ))}
        </div>
      )}

      {view === 'solution' && (
        <section className="solution-panel">
          <div className="solution-actions">
            <button aria-label="Copy answer" onClick={() => void navigator.clipboard.writeText(answer)}><Copy /></button>
            <button aria-label="Close answer" onClick={() => { setView('queue'); setAnswer(''); setStreaming(false) }}><X /></button>
          </div>
          <div className="answer-markdown">{answer || (streaming ? `${modelId} is working…` : 'No answer received.')}{streaming && <span className="stream-cursor" />}</div>
          {tools.length > 0 && <div className="legacy-tool-stack">{tools.map((tool) => <div key={tool.name}><b>{tool.name}</b><span>{tool.state}</span></div>)}</div>}
        </section>
      )}

      {view === 'chat' && (
        <section className="chat-panel">
          <header><div><b>{sessionId ? 'Current session' : 'New session'}</b><small>{modelId}</small></div><button aria-label="Close chat" onClick={() => setView('queue')}><X /></button></header>
          <div className="chat-messages">
            {!messages.length && !answer ? <p>Chat with <code>{modelId}</code><small>Continue the current Codex session.</small></p> : messages.map((message, index) => <div key={index} className={message.role}>{message.content}</div>)}
            {streaming && <div className="assistant">{answer || `${modelId} is replying…`}<span className="stream-cursor" /></div>}
          </div>
          <form onSubmit={sendChat}>
            <input ref={input} value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Type your message…" disabled={streaming} />
            <button type="submit" disabled={!chatInput.trim() || streaming}><Send />Send</button>
          </form>
        </section>
      )}

      <select className="overlay-model" aria-label="Codex model" value={modelId} onChange={(event) => setModelId(event.target.value)}>
        <option value="gpt-5.5">gpt-5.5</option>
        <option value="gpt-5.4">gpt-5.4</option>
        <option value="gpt-5.3-codex">gpt-5.3-codex</option>
        <option value="gpt-5.2-codex">gpt-5.2-codex</option>
      </select>
      {streaming && turnId && <button className="stop-fab" onClick={() => void desktopClient.stopTurn(turnId)}>Stop</button>}
    </div>
  )
}

function CommandBar({ attachments, chatOpen, onCapture, onSolve, onClear, onReset, onChat, onSettings, onClose }: {
  attachments: number
  chatOpen: boolean
  onCapture(): void
  onSolve(): void
  onClear(): void
  onReset(): void
  onChat(): void
  onSettings(): void
  onClose(): void
}) {
  return <div className="legacy-command-bar draggable-area">
    <button onClick={onCapture} title="Capture display (Cmd+H)"><Camera />Capture <Key>⌘H</Key></button>
    {attachments > 0 && <button onClick={onSolve}>Solve <Key>⌘↵</Key></button>}
    <button onClick={onClear}><Trash2 />Clear <Key>⌘K</Key></button>
    <button onClick={onReset}><RotateCcw />Reset <Key>⌘R</Key></button>
    <span className="command-divider" />
    <button className={chatOpen ? 'active' : ''} onClick={onChat}><MessageSquare />Chat</button>
    <button onClick={onSettings} aria-label="Open settings"><Settings /></button>
    <button onClick={onClose} aria-label="Hide overlay"><X /></button>
  </div>
}
