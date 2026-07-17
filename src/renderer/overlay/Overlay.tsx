import {
  Camera,
  Copy,
  Home,
  LoaderCircle,
  Plus,
  Send,
  Square,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { desktopClient } from '../desktop'

type Attachment = { id: string; name: string }
type Tool = { name: string; state: 'running' | 'complete' | 'error'; detail?: string }

export function Overlay() {
  const [prompt, setPrompt] = useState('')
  const [modelId, setModelId] = useState('gpt-5.4')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [transcript, setTranscript] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [tools, setTools] = useState<Tool[]>([])
  const [notice, setNotice] = useState('Composer ready.')
  const [sessionId, setSessionId] = useState<string>()
  const [turnId, setTurnId] = useState<string>()
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    input.current?.focus()
    if (!desktopClient.available) return
    return desktopClient.onProductEvent((event) => {
      if ('sessionId' in event && sessionId && event.sessionId !== sessionId) return
      if (event.type === 'transcript.delta') {
        setTranscript((current) => current + event.text)
        setStreaming(true)
      } else if (event.type === 'transcript.complete') {
        setStreaming(false)
        setNotice('Response complete.')
      } else if (event.type === 'transcript.failed') {
        setStreaming(false)
        setNotice(event.message)
      } else if (event.type === 'tool.status') {
        setTools((current) => [
          ...current.filter((tool) => tool.name !== event.name),
          { name: event.name, state: event.state },
        ])
      } else if (event.type === 'attachment.captured') {
        const attachment = event.attachment as Attachment
        setAttachments((current) =>
          current.some((item) => item.id === attachment.id)
            ? current
            : [...current, attachment].slice(0, 5),
        )
        setNotice('Screenshot attached.')
      }
    })
  }, [sessionId])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const message = prompt.trim()
    if (!message || streaming) return
    setStreaming(true)
    setTranscript('')
    setTools([])
    setNotice('Sending your message to Codex.')
    try {
      const result = await desktopClient.sendMessage({
        ...(sessionId ? { sessionId } : {}),
        message,
        modelId,
        attachmentIds: attachments.map((item) => item.id),
      })
      setSessionId(result.sessionId)
      setTurnId(result.turnId)
      setPrompt('')
    } catch (error) {
      setStreaming(false)
      setNotice(error instanceof Error ? error.message : 'Unable to start the turn.')
    }
  }

  const capture = async () => {
    try {
      const outcome = await desktopClient.capture() as { kind: string; attachment?: Attachment }
      if (outcome.kind === 'cancelled') setNotice('Capture cancelled.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Capture failed.')
    }
  }

  return (
    <main className="overlay-shell" data-clickable-root aria-label="Codexly composer">
      <span className="sr-only" aria-live="polite">{notice}</span>
      <header className="overlay-titlebar draggable-area">
        <span className="overlay-brand">⌘ CODEXLY</span>
        <span className="drag-hint">Ask about your work</span>
        <Button size="icon-xs" variant="ghost" className="interactive" aria-label="Open home" onClick={() => void desktopClient.openHome()}><Home /></Button>
      </header>
      <section className="overlay-panel">
        <div className="transcript" aria-live="polite" aria-busy={streaming}>
          {transcript ? <p>{transcript}{streaming && <span className="stream-cursor" aria-label="Streaming" />}</p> : <p className="muted">Bring a question or capture the display. Codexly streams the answer here.</p>}
        </div>
        {tools.length > 0 && <div className="tool-stack" aria-label="Runtime activity">
          {tools.map((tool) => <div className={`tool-card ${tool.state}`} key={tool.name}>
            {tool.state === 'running' ? <LoaderCircle className="spin" /> : <Square />}
            <span><b>{tool.name}</b><small>{tool.detail ?? tool.state}</small></span>
          </div>)}
        </div>}
        <form onSubmit={submit}>
          <div className="attachment-strip" aria-label="Attachments">
            {attachments.map((file) => <span className="attachment" key={file.id}>{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttachments(attachments.filter((item) => item.id !== file.id))}><X /></button></span>)}
            <Button type="button" size="icon-xs" variant="ghost" onClick={() => void capture()} disabled={attachments.length >= 5} aria-label="Capture display"><Camera /></Button>
            <small>{attachments.length}/5</small>
          </div>
          <textarea ref={input} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask Codexly…" aria-label="Message for Codexly" onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event as unknown as FormEvent)
          }} />
          <footer>
            <select aria-label="Codex model" value={modelId} onChange={(event) => setModelId(event.target.value)}>
              <option value="gpt-5.4">GPT-5.4</option>
              <option value="gpt-5.3-codex">GPT-5.3 Codex</option>
              <option value="gpt-5.2-codex">GPT-5.2 Codex</option>
            </select>
            <div>
              {transcript && <Button type="button" size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(transcript)}><Copy />Copy</Button>}
              <Button type="button" size="sm" variant="ghost" onClick={() => {
                setSessionId(undefined); setTurnId(undefined); setTranscript(''); setTools([]); setAttachments([]); setNotice('New session started.')
              }}><Plus />New</Button>
              {streaming ? <Button type="button" variant="destructive" size="sm" onClick={() => {
                if (turnId) void desktopClient.stopTurn(turnId)
              }}><Square />Stop</Button> : <Button disabled={!prompt.trim()} type="submit" size="sm"><Send />Send</Button>}
            </div>
          </footer>
        </form>
      </section>
    </main>
  )
}
