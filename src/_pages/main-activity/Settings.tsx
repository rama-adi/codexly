import React, { useEffect, useState } from "react"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { llmService, processingService, settingsService } from "@/services/desktop"
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
  model: string
  name: string
  displayName: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts: Array<{
    reasoningEffort: string
    description?: string
  }>
  inputModalities: string[]
  isDefault: boolean
}

const statusCopy: Record<ConnectionStatus, string> = {
  idle: "Not tested",
  testing: "Testing",
  success: "Connected",
  error: "Failed"
}

const allowedReasoningEfforts: ReasoningEffort[] = [
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
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [savingModel, setSavingModel] = useState(false)
  const [savingStealth, setSavingStealth] = useState(false)
  const [savingWebSearch, setSavingWebSearch] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>("idle")
  const [errorMessage, setErrorMessage] = useState("")
  const modelDiscoveryFailed = !loadingConfig && models.length === 0
  const selectedModel = models.find(model => model.id === config?.model)
  const reasoningOptions = getReasoningOptions(selectedModel, reasoningEffort)

  useEffect(() => {
    ;(async () => {
      try {
        const [currentConfig, settings] = await Promise.all([
          llmService.getCurrentConfig(),
          settingsService.getAppSettings()
        ])
        setConfig(currentConfig)
        processingService.prepareCodex().catch(error => {
          console.warn("Codex prelaunch failed while loading settings:", error)
        })
        const availableModels = await llmService.getAvailableModels()
        setModels(availableModels)
        setStealthEnabled(settings.stealthEnabled)
        setReasoningEffort(settings.reasoningEffort)
        setWebSearchEnabled(settings.webSearchEnabled)
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
      const nextConfig = await llmService.setCurrentModel(model)
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
      const result = await llmService.testConnection()
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
    if (!allowedReasoningEfforts.includes(nextEffort)) return
    const previous = reasoningEffort
    setReasoningEffort(nextEffort)
    try {
      const settings = await settingsService.updateAppSettings({
        reasoningEffort: nextEffort
      })
      setReasoningEffort(settings.reasoningEffort)
    } catch (error) {
      setReasoningEffort(previous)
      setErrorMessage(String(error))
      setStatus("error")
    }
  }

  useEffect(() => {
    if (loadingConfig || !selectedModel || reasoningOptions.length === 0) return
    if (reasoningOptions.some(option => option.reasoningEffort === reasoningEffort)) return

    const defaultEffort = selectedModel.defaultReasoningEffort
    const nextEffort = reasoningOptions.find(option => option.reasoningEffort === defaultEffort)
      ?? reasoningOptions[0]
    changeReasoningEffort(nextEffort.reasoningEffort)
  }, [loadingConfig, selectedModel, reasoningOptions, reasoningEffort])

  const changeStealth = async (enabled: boolean) => {
    const previous = stealthEnabled
    setStealthEnabled(enabled)
    setSavingStealth(true)
    try {
      const result = await settingsService.setStealthEnabled(enabled)
      setStealthEnabled(result.stealthEnabled)
    } catch (error) {
      setStealthEnabled(previous)
      setErrorMessage(String(error))
      setStatus("error")
    } finally {
      setSavingStealth(false)
    }
  }

  const changeWebSearch = async (enabled: boolean) => {
    const previous = webSearchEnabled
    setWebSearchEnabled(enabled)
    setSavingWebSearch(true)
    setStatus("idle")
    setErrorMessage("")
    try {
      const settings = await settingsService.updateAppSettings({
        webSearchEnabled: enabled
      })
      setWebSearchEnabled(settings.webSearchEnabled)
    } catch (error) {
      setWebSearchEnabled(previous)
      setErrorMessage(String(error))
      setStatus("error")
    } finally {
      setSavingWebSearch(false)
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
                    No image-capable Codex models returned. Check connection.
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
              description={
                selectedModel
                  ? `Options for ${selectedModel.displayName}.`
                  : "Options are loaded from Codex for the selected model."
              }
              className="items-start"
              control={
                loadingConfig ? (
                  <Skeleton className="h-20 w-[340px]" />
                ) : (
                  <div className="flex w-[340px] flex-col gap-2">
                    {reasoningOptions.map(option => (
                      <label
                        key={option.reasoningEffort}
                        className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                          reasoningEffort === option.reasoningEffort
                            ? "border-primary bg-primary/5"
                            : "border-border bg-background hover:bg-accent/60"
                        }`}
                      >
                        <input
                          type="radio"
                          name="reasoning-effort"
                          value={option.reasoningEffort}
                          checked={reasoningEffort === option.reasoningEffort}
                          onChange={() => changeReasoningEffort(option.reasoningEffort)}
                          className="mt-0.5 size-3.5 accent-primary"
                        />
                        <span className="min-w-0">
                          <span className="block text-xs font-medium capitalize text-foreground">
                            {option.reasoningEffort}
                          </span>
                          {option.description && (
                            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )
              }
            />
          </CardRows>
        </Card>

        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Tools</CardTitle>
              <CardDescription>
                Enable optional Codex capabilities for future answers.
              </CardDescription>
            </div>
          </CardHeader>
          <CardRows>
            <SettingRow
              label="Web search"
              description="Allow Codex to use live web search when current information is needed."
              control={
                <Switch
                  checked={webSearchEnabled}
                  disabled={loadingConfig || savingWebSearch}
                  onCheckedChange={changeWebSearch}
                />
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

function getReasoningOptions(
  model: ModelOption | undefined,
  currentEffort: ReasoningEffort
): Array<{ reasoningEffort: ReasoningEffort; description?: string }> {
  const options = (model?.supportedReasoningEfforts ?? [])
    .map(option => ({
      reasoningEffort: option.reasoningEffort as ReasoningEffort,
      description: option.description,
    }))
    .filter(option => allowedReasoningEfforts.includes(option.reasoningEffort))

  if (options.length > 0) return options
  return [{ reasoningEffort: currentEffort, description: "Current saved setting." }]
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
