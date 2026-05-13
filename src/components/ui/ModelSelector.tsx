import React, { useEffect, useState } from 'react'
import { llmService } from "@/services/desktop"

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error'

interface ModelConfig {
  provider: string
  model: string
}

interface ModelSelectorProps {
  onChatOpen?: () => void
}

const DOT: Record<ConnectionStatus, string> = {
  idle: 'bg-white/40',
  testing: 'bg-yellow-400 animate-pulse',
  success: 'bg-green-400',
  error: 'bg-red-400',
}

const LABEL: Record<ConnectionStatus, string> = {
  idle: 'Ready',
  testing: 'Testing…',
  success: 'Connected',
  error: 'Error',
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ onChatOpen }) => {
  const [config, setConfig] = useState<ModelConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        setConfig(await llmService.getCurrentConfig())
      } catch (err) {
        console.error('Error loading LLM config:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const testConnection = async () => {
    setStatus('testing')
    setErrorMessage('')
    try {
      const result = await llmService.testConnection()
      if (result.success) {
        setStatus('success')
        onChatOpen?.()
      } else {
        setStatus('error')
        setErrorMessage(result.error || 'Unknown error')
      }
    } catch (err) {
      setStatus('error')
      setErrorMessage(String(err))
    }
  }

  if (loading) {
    return (
      <div className="p-3 rounded-lg bg-black/60 border border-white/10 text-xs text-white/60">
        Loading…
      </div>
    )
  }

  return (
    <div className="p-3 rounded-lg bg-black/60 border border-white/10 text-white/90 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-white/90">Model</span>
        <div className="flex items-center gap-1.5 text-[11px] text-white/70">
          <span className={`w-1.5 h-1.5 rounded-full ${DOT[status]}`} />
          {status === 'error' && errorMessage ? `Error: ${errorMessage}` : LABEL[status]}
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-white/55">OpenAI</span>
        <span className="font-mono text-white/85">{config?.model ?? 'gpt-5.4'}</span>
      </div>

      <button
        onClick={testConnection}
        disabled={status === 'testing'}
        className="w-full px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 disabled:opacity-50 text-xs text-white/90 transition-colors"
      >
        {status === 'testing' ? 'Testing…' : 'Test connection'}
      </button>

      <p className="text-[11px] text-white/45 leading-relaxed">
        Auth via OpenAI OAuth. Sign in with your ChatGPT account when prompted.
      </p>
    </div>
  )
}

export default ModelSelector
