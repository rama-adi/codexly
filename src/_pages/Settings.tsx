import React, { useEffect, useState } from "react"
import {
  CheckCircle2,
  Loader2,
  Settings as SettingsIcon,
  XCircle
} from "lucide-react"

type ConnectionStatus = "idle" | "testing" | "success" | "error"

interface ModelConfig {
  provider: string
  model: string
}

const statusCopy: Record<ConnectionStatus, string> = {
  idle: "Not tested",
  testing: "Testing",
  success: "Connected",
  error: "Failed"
}

const Settings: React.FC = () => {
  const [config, setConfig] = useState<ModelConfig | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [status, setStatus] = useState<ConnectionStatus>("idle")
  const [errorMessage, setErrorMessage] = useState("")

  useEffect(() => {
    ;(async () => {
      try {
        setConfig(await window.electronAPI.getCurrentLlmConfig())
      } catch (error) {
        console.error("Error loading LLM config:", error)
      } finally {
        setLoadingConfig(false)
      }
    })()
  }, [])

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

  return (
    <main className="min-h-screen bg-[#f7f7f5] text-[#1f2328]" data-clickable-root>
      <header className="draggable-area flex h-12 items-center gap-2 border-b border-black/10 bg-white px-4">
        <SettingsIcon className="h-4 w-4 text-[#5f6368]" />
        <h1 className="text-sm font-semibold tracking-normal">Settings</h1>
      </header>

      <section className="p-4">
        <div className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[#5f6368]">
            Model
          </h2>
          <div className="divide-y divide-black/10 rounded-md border border-black/10 bg-white">
            <SettingRow label="Provider" value={loadingConfig ? "Loading" : config?.provider ?? "OpenAI"} />
            <SettingRow label="Model" value={loadingConfig ? "Loading" : config?.model ?? "gpt-5.4"} monospace />
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
            <SettingRow label="Capture protection" value="Managed by overlay window" />
            <SettingRow label="More settings" value="Coming soon" />
          </div>
        </div>
      </section>
    </main>
  )
}

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
