import React, { useEffect, useState } from "react"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardHeader,
  CardRows,
  CardTitle
} from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import { SettingRow } from "@/components/ui/setting-row"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"

type ConnectionStatus = "idle" | "testing" | "success" | "error"
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

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

const reasoningOptions: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]

const Settings: React.FC = () => {
  const [config, setConfig] = useState<ModelConfig | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [stealthEnabled, setStealthEnabled] = useState(true)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("low")
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [savingModel, setSavingModel] = useState(false)
  const [savingStealth, setSavingStealth] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>("idle")
  const [errorMessage, setErrorMessage] = useState("")
  const modelDiscoveryFailed = !loadingConfig && models.length === 0

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
        setReasoningEffort(settings.reasoningEffort)
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

  const changeReasoningEffort = async (nextEffort: ReasoningEffort) => {
    const previous = reasoningEffort
    setReasoningEffort(nextEffort)
    try {
      const settings = await window.electronAPI.updateAppSettings({
        reasoningEffort: nextEffort
      })
      setReasoningEffort(settings.reasoningEffort)
    } catch (error) {
      setReasoningEffort(previous)
      setErrorMessage(String(error))
      setStatus("error")
    }
  }

  const changeStealth = async (enabled: boolean) => {
    const previous = stealthEnabled
    setStealthEnabled(enabled)
    setSavingStealth(true)
    try {
      const result = await window.electronAPI.setStealthEnabled(enabled)
      setStealthEnabled(result.stealthEnabled)
    } catch (error) {
      setStealthEnabled(previous)
      setErrorMessage(String(error))
      setStatus("error")
    } finally {
      setSavingStealth(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-5">
        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Model</CardTitle>
              <CardDescription>
                Choose the Codex model and verify the connection.
              </CardDescription>
            </div>
          </CardHeader>
          <CardRows>
            <SettingRow
              label="Provider"
              control={
                loadingConfig ? (
                  <Skeleton className="h-4 w-20" />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {config?.provider ?? "OpenAI"}
                  </span>
                )
              }
            />
            <SettingRow
              label="Model"
              control={
                loadingConfig ? (
                  <Skeleton className="h-8 w-[210px]" />
                ) : (
                  <Select
                    value={config?.model ?? ""}
                    onChange={event => changeModel(event.target.value)}
                    disabled={savingModel || modelDiscoveryFailed}
                    loading={savingModel}
                    monospace
                    title={
                      modelDiscoveryFailed
                        ? "Codex model list is unavailable"
                        : config?.model
                    }
                    className="max-w-[210px]"
                  >
                    {config &&
                      !models.some(model => model.id === config.model) && (
                        <option value={config.model}>{config.model}</option>
                      )}
                    {models.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </Select>
                )
              }
            />
            <SettingRow
              label="Connection"
              description={
                modelDiscoveryFailed ? (
                  <span className="text-xs text-destructive">
                    Codex model list unavailable. Check connection.
                  </span>
                ) : (
                  <ConnectionStatusLine
                    status={status}
                    errorMessage={errorMessage}
                  />
                )
              }
              control={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={testConnection}
                  disabled={status === "testing"}
                >
                  {status === "testing" && (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  )}
                  Test
                </Button>
              }
            />
            <SettingRow
              label="Reasoning effort"
              description="Controls Codex reasoning depth for new turns."
              control={
                <Select
                  value={reasoningEffort}
                  onChange={event =>
                    changeReasoningEffort(event.target.value as ReasoningEffort)
                  }
                  disabled={loadingConfig}
                  className="max-w-[160px]"
                >
                  {reasoningOptions.map(effort => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </Select>
              }
            />
          </CardRows>
        </Card>

        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Privacy</CardTitle>
              <CardDescription>
                Behavior of the overlay and screenshot capture.
              </CardDescription>
            </div>
          </CardHeader>
          <CardRows>
            <SettingRow
              label="Stealth behavior"
              description="Hide the overlay during screenshots."
              control={
                <Switch
                  checked={stealthEnabled}
                  disabled={loadingConfig || savingStealth}
                  onCheckedChange={changeStealth}
                />
              }
            />
          </CardRows>
        </Card>
      </div>
    </div>
  )
}

const ConnectionStatusLine: React.FC<{
  status: ConnectionStatus
  errorMessage: string
}> = ({ status, errorMessage }) => {
  const icon =
    status === "testing" ? (
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
    ) : status === "success" ? (
      <CheckCircle2 className="size-3.5 text-primary" />
    ) : status === "error" ? (
      <XCircle className="size-3.5 text-destructive" />
    ) : null

  return (
    <span className="mt-0.5 inline-flex max-w-[260px] items-center gap-1.5 align-middle">
      {icon}
      <span
        className="truncate"
        title={errorMessage || statusCopy[status]}
      >
        {status === "error" && errorMessage ? errorMessage : statusCopy[status]}
      </span>
    </span>
  )
}

export default Settings
