import React, { useEffect, useState } from "react"
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Minus,
  Settings as SettingsIcon,
  X,
  XCircle
} from "lucide-react"

type ConnectionStatus = "idle" | "testing" | "success" | "error"
type AppMode = "simpleQA" | "coding"
type ResponseType = "concise" | "thorough"

interface ModelConfig {
  provider: string
  model: string
}

interface ModelOption {
  id: string
  name: string
}

const statusCopy: Record<ConnectionStatus, string> = {
  idle: "Not tested",
  testing: "Testing",
  success: "Connected",
  error: "Failed"
}

const Settings: React.FC = () => {
  const isMac = window.electronAPI.platform === "darwin"
  const [config, setConfig] = useState<ModelConfig | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [stealthEnabled, setStealthEnabled] = useState(true)
  const [mode, setMode] = useState<AppMode>("simpleQA")
  const [responseType, setResponseType] = useState<ResponseType>("concise")
  const [codingLanguage, setCodingLanguage] = useState<string>("javascript")
  const [responseLanguage, setResponseLanguage] = useState<string>("")
  const [answerHeight, setAnswerHeight] = useState<number>(600)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [savingModel, setSavingModel] = useState(false)
  const [savingStealth, setSavingStealth] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>("idle")
  const [errorMessage, setErrorMessage] = useState("")

  useEffect(() => {
    ;(async () => {
      try {
        const [currentConfig, availableModels, settings] = await Promise.all([
          window.electronAPI.getCurrentLlmConfig(),
          window.electronAPI.getAvailableLlmModels(),
          window.electronAPI.getAppSettings()
        ])
        setConfig(currentConfig)
        setModels(availableModels)
        setStealthEnabled(settings.stealthEnabled)
        setMode(settings.mode)
        setResponseType(settings.responseType)
        setCodingLanguage(settings.codingLanguage ?? "")
        setResponseLanguage(settings.responseLanguage ?? "")
        setAnswerHeight(settings.answerHeight ?? 600)
      } catch (error) {
        console.error("Error loading LLM config:", error)
      } finally {
        setLoadingConfig(false)
      }
    })()
  }, [])

  const changeModel = async (model: string) => {
    if (!model || model === config?.model) return

    setSavingModel(true)
    setStatus("idle")
    setErrorMessage("")

    try {
      const nextConfig = await window.electronAPI.setCurrentLlmModel(model)
      setConfig(nextConfig)
    } catch (error) {
      setErrorMessage(String(error))
      setStatus("error")
    } finally {
      setSavingModel(false)
    }
  }

  const testConnection = async () => {
    setStatus("testing")
    setErrorMessage("")

    try {
      const result = await window.electronAPI.testLlmConnection()
      if (result.success) {
        setStatus("success")
      } else {
        setStatus("error")
        setErrorMessage(result.error || "Unknown error")
      }
    } catch (error) {
      setStatus("error")
      setErrorMessage(String(error))
    }
  }

  const changeStealth = async (enabled: boolean) => {
    setStealthEnabled(enabled)
    setSavingStealth(true)
    try {
      const result = await window.electronAPI.setStealthEnabled(enabled)
      setStealthEnabled(result.stealthEnabled)
    } catch (error) {
      setStealthEnabled(!enabled)
      setErrorMessage(String(error))
      setStatus("error")
    } finally {
      setSavingStealth(false)
    }
  }

  const changeMode = async (nextMode: AppMode) => {
    setMode(nextMode)
    try {
      const settings = await window.electronAPI.updateAppSettings({ mode: nextMode })
      setMode(settings.mode)
    } catch (error) {
      setMode(mode)
      setErrorMessage(String(error))
      setStatus("error")
    }
  }

  const changeResponseType = async (nextResponseType: ResponseType) => {
    setResponseType(nextResponseType)
    try {
      const settings = await window.electronAPI.updateAppSettings({ responseType: nextResponseType })
      setResponseType(settings.responseType)
    } catch (error) {
      setResponseType(responseType)
      setErrorMessage(String(error))
      setStatus("error")
    }
  }

  const changeCodingLanguage = async (nextCodingLanguage: string) => {
    const trimmed = nextCodingLanguage.trim()
    try {
      const settings = await window.electronAPI.updateAppSettings({ codingLanguage: trimmed })
      setCodingLanguage(settings.codingLanguage ?? "")
    } catch (error) {
      setErrorMessage(String(error))
      setStatus("error")
    }
  }

  const ANSWER_HEIGHT_MIN = 200
  const ANSWER_HEIGHT_MAX = 1400
  const ANSWER_HEIGHT_STEP = 50

  const changeAnswerHeight = async (nextHeight: number) => {
    const clamped = Math.min(ANSWER_HEIGHT_MAX, Math.max(ANSWER_HEIGHT_MIN, Math.round(nextHeight)))
    if (clamped === answerHeight) return
    const previous = answerHeight
    setAnswerHeight(clamped)
    try {
      const settings = await window.electronAPI.updateAppSettings({ answerHeight: clamped })
      setAnswerHeight(settings.answerHeight ?? clamped)
    } catch (error) {
      setAnswerHeight(previous)
      setErrorMessage(String(error))
      setStatus("error")
    }
  }

  const changeResponseLanguage = async (nextResponseLanguage: string) => {
    const trimmed = nextResponseLanguage.trim()
    try {
      const settings = await window.electronAPI.updateAppSettings({ responseLanguage: trimmed })
      setResponseLanguage(settings.responseLanguage ?? "")
    } catch (error) {
      setErrorMessage(String(error))
      setStatus("error")
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f7f5] text-[#1f2328]" data-clickable-root>
      <header
        className={`draggable-area sticky top-0 z-10 flex h-12 items-center justify-between gap-2 border-b border-black/10 bg-white ${
          isMac ? "pl-[78px]" : ""
        }`}
      >
        <div className="flex min-w-0 items-center gap-2 px-4">
          <SettingsIcon className="h-4 w-4 shrink-0 text-[#5f6368]" />
          <h1 className="truncate text-sm font-semibold tracking-normal">Settings</h1>
        </div>
        {!isMac && <SettingsWindowControls />}
      </header>

      <section className="p-4">
        <div className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[#5f6368]">
            Model
          </h2>
          <div className="divide-y divide-black/10 rounded-md border border-black/10 bg-white">
            <SettingRow label="Provider" value={loadingConfig ? "Loading" : config?.provider ?? "OpenAI"} />
            <div className="flex min-h-12 items-center justify-between gap-4 px-3 py-2">
              <div className="text-sm font-medium">Model</div>
              <div className="relative min-w-0">
                <select
                  value={config?.model ?? ""}
                  onChange={event => changeModel(event.target.value)}
                  disabled={loadingConfig || savingModel}
                  className="h-8 max-w-[210px] appearance-none rounded-md border border-black/15 bg-[#f7f7f5] py-0 pl-3 pr-8 font-mono text-xs text-[#1f2328] outline-none transition-colors hover:bg-[#eeeeea] disabled:cursor-default disabled:opacity-60"
                  title={config?.model}
                >
                  {config && !models.some(model => model.id === config.model) && (
                    <option value={config.model}>{config.model}</option>
                  )}
                  {models.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
                {savingModel ? (
                  <Loader2 className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-[#5f6368]" />
                ) : (
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5f6368]" />
                )}
              </div>
            </div>
            <div className="flex min-h-12 items-center justify-between gap-4 px-3 py-2">
              <div>
                <div className="text-sm font-medium">Connection</div>
                <ConnectionStatus status={status} errorMessage={errorMessage} />
              </div>
              <button
                type="button"
                onClick={testConnection}
                disabled={status === "testing"}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-black/15 bg-[#f7f7f5] px-3 text-xs font-medium text-[#1f2328] transition-colors hover:bg-[#eeeeea] disabled:cursor-default disabled:opacity-60"
              >
                {status === "testing" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Test
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[#5f6368]">
            General
          </h2>
          <div className="rounded-md border border-black/10 bg-white">
            <SelectSettingRow
              label="Mode"
              value={mode}
              disabled={loadingConfig}
              options={[
                { value: "simpleQA", label: "Simple QA" },
                { value: "coding", label: "Coding" }
              ]}
              onChange={value => changeMode(value as AppMode)}
            />
            <SelectSettingRow
              label="Response"
              value={responseType}
              disabled={loadingConfig}
              options={[
                { value: "concise", label: "Concise" },
                { value: "thorough", label: "Thorough" }
              ]}
              onChange={value => changeResponseType(value as ResponseType)}
            />
            {mode === "coding" && (
              <TextSettingRow
                label="Language"
                value={codingLanguage}
                placeholder="e.g. javascript, python, rust"
                disabled={loadingConfig}
                onCommit={changeCodingLanguage}
              />
            )}
            <TextSettingRow
              label="Response language"
              value={responseLanguage}
              placeholder="Leave empty to auto-detect"
              disabled={loadingConfig}
              onCommit={changeResponseLanguage}
            />
            <div className="flex min-h-12 items-center justify-between gap-4 border-b border-black/10 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">Answer view height</div>
                <div className="mt-0.5 truncate text-xs text-[#5f6368]">
                  Max height of the solutions panel
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label="Decrease answer height"
                  disabled={loadingConfig || answerHeight <= ANSWER_HEIGHT_MIN}
                  onClick={() => changeAnswerHeight(answerHeight - ANSWER_HEIGHT_STEP)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-black/15 bg-[#f7f7f5] text-sm leading-none text-[#1f2328] transition-colors hover:bg-[#eeeeea] disabled:cursor-default disabled:opacity-60"
                >
                  −
                </button>
                <div className="w-16 text-center font-mono text-xs tabular-nums text-[#1f2328]">
                  {answerHeight}px
                </div>
                <button
                  type="button"
                  aria-label="Increase answer height"
                  disabled={loadingConfig || answerHeight >= ANSWER_HEIGHT_MAX}
                  onClick={() => changeAnswerHeight(answerHeight + ANSWER_HEIGHT_STEP)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-black/15 bg-[#f7f7f5] text-sm leading-none text-[#1f2328] transition-colors hover:bg-[#eeeeea] disabled:cursor-default disabled:opacity-60"
                >
                  +
                </button>
              </div>
            </div>
            <div className="flex min-h-12 items-center justify-between gap-4 border-b border-black/10 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">Answer view preview</div>
                <div className="mt-0.5 truncate text-xs text-[#5f6368]">
                  Open the overlay with sample content to test the height
                </div>
              </div>
              <button
                type="button"
                onClick={() => window.electronAPI.showAnswerPreview()}
                className="inline-flex h-8 shrink-0 items-center rounded-md border border-black/15 bg-[#f7f7f5] px-3 text-xs font-medium text-[#1f2328] transition-colors hover:bg-[#eeeeea]"
              >
                Show preview
              </button>
            </div>
            <div className="flex min-h-12 items-center justify-between gap-4 px-3 py-2">
              <div>
                <div className="text-sm font-medium">Stealth behavior</div>
                <div className="mt-0.5 text-xs text-[#5f6368]">
                  Hide overlay during screenshots
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={stealthEnabled}
                disabled={loadingConfig || savingStealth}
                onClick={() => changeStealth(!stealthEnabled)}
                className={`relative h-6 w-10 rounded-full transition-colors disabled:cursor-default disabled:opacity-60 ${
                  stealthEnabled ? "bg-[#1f883d]" : "bg-black/20"
                }`}
              >
                <span
                  className={`absolute left-0 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    stealthEnabled ? "translate-x-5" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

const SettingsWindowControls: React.FC = () => (
  <div className="interactive flex h-full shrink-0 items-stretch">
    <button
      type="button"
      aria-label="Minimize"
      title="Minimize"
      onClick={() => window.electronAPI.minimizeSettingsWindow()}
      className="flex h-12 w-11 items-center justify-center text-[#5f6368] transition-colors hover:bg-black/10 active:bg-black/15"
    >
      <Minus className="h-4 w-4" strokeWidth={1.75} />
    </button>
    <button
      type="button"
      aria-label="Close"
      title="Close"
      onClick={() => window.electronAPI.closeSettingsWindow()}
      className="flex h-12 w-11 items-center justify-center text-[#5f6368] transition-colors hover:bg-[#c42b1c] hover:text-white active:bg-[#a82014]"
    >
      <X className="h-4 w-4" strokeWidth={1.75} />
    </button>
  </div>
)

const SettingRow: React.FC<{
  label: string
  value: string
  monospace?: boolean
}> = ({ label, value, monospace = false }) => (
  <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
    <div className="text-sm font-medium">{label}</div>
    <div
      className={`max-w-[190px] truncate text-right text-sm text-[#5f6368] ${
        monospace ? "font-mono" : ""
      }`}
      title={value}
    >
      {value}
    </div>
  </div>
)

const SelectSettingRow: React.FC<{
  label: string
  value: string
  disabled?: boolean
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}> = ({ label, value, disabled = false, options, onChange }) => (
  <div className="flex min-h-12 items-center justify-between gap-4 border-b border-black/10 px-3 py-2">
    <div className="text-sm font-medium">{label}</div>
    <div className="relative min-w-0">
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled}
        className="h-8 max-w-[210px] appearance-none rounded-md border border-black/15 bg-[#f7f7f5] py-0 pl-3 pr-8 text-xs text-[#1f2328] outline-none transition-colors hover:bg-[#eeeeea] disabled:cursor-default disabled:opacity-60"
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5f6368]" />
    </div>
  </div>
)

const TextSettingRow: React.FC<{
  label: string
  value: string
  placeholder?: string
  disabled?: boolean
  onCommit: (value: string) => void
}> = ({ label, value, placeholder, disabled = false, onCommit }) => {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const commit = () => {
    if (draft === value) return
    onCommit(draft)
  }

  return (
    <div className="flex min-h-12 items-center justify-between gap-4 border-b border-black/10 px-3 py-2">
      <div className="text-sm font-medium">{label}</div>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.currentTarget.blur()
          }
        }}
        className="h-8 max-w-[210px] rounded-md border border-black/15 bg-[#f7f7f5] px-2 text-xs text-[#1f2328] outline-none transition-colors hover:bg-[#eeeeea] focus:bg-white disabled:cursor-default disabled:opacity-60"
      />
    </div>
  )
}

const ConnectionStatus: React.FC<{
  status: ConnectionStatus
  errorMessage: string
}> = ({ status, errorMessage }) => {
  const icon =
    status === "testing" ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#6b7280]" />
    ) : status === "success" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-[#188038]" />
    ) : status === "error" ? (
      <XCircle className="h-3.5 w-3.5 text-[#c5221f]" />
    ) : null

  return (
    <div className="mt-0.5 flex max-w-[220px] items-center gap-1.5 text-xs text-[#5f6368]">
      {icon}
      <span className="truncate" title={errorMessage || statusCopy[status]}>
        {status === "error" && errorMessage
          ? errorMessage
          : statusCopy[status]}
      </span>
    </div>
  )
}

export default Settings
