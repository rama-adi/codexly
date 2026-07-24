import * as React from 'react'
import {
  CheckCircle2,
  Eye,
  Globe,
  Keyboard,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Sun,
  XCircle,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardRows,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SettingRow } from '@/components/ui/setting-row'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { ModelOption } from '../../../shared/schemas/models'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_METADATA,
  type CanonicalSettings,
  type ReasoningEffort,
  type Theme,
} from '../../../shared/schemas/settings'
import { desktopClient } from '../../desktop'
import { ShortcutRecorder } from '../components/ShortcutRecorder'
import type { SettingsPatch } from '../hooks/useSettings'

interface SettingsPageProps {
  settings: CanonicalSettings | null
  update: (patch: SettingsPatch) => Promise<CanonicalSettings | null>
  available: boolean
  onSetApiKey: (apiKey: string) => Promise<void>
}

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error'

const REASONING_ORDER: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high']
const ALLOWED_EFFORTS = new Set<string>(REASONING_ORDER)

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export const SettingsPage: React.FC<SettingsPageProps> = ({
  settings,
  update,
  available,
  onSetApiKey,
}) => {
  const [models, setModels] = React.useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = React.useState(true)
  const [status, setStatus] = React.useState<ConnectionStatus>('idle')
  const [statusMessage, setStatusMessage] = React.useState('')
  const [apiKey, setApiKey] = React.useState('')
  const [savingApiKey, setSavingApiKey] = React.useState(false)
  const [shortcutConflicts, setShortcutConflicts] = React.useState<
    Record<string, boolean>
  >({})

  React.useEffect(() => {
    if (!available) return
    const unsubscribe = desktopClient.onProductEvent((event) => {
      if (event.type !== 'shortcut.status') return
      const conflicts: Record<string, boolean> = {}
      for (const [action, status] of Object.entries(event.statuses)) {
        conflicts[action] = status.conflicted
      }
      setShortcutConflicts(conflicts)
    })
    return unsubscribe
  }, [available])

  React.useEffect(() => {
    if (!available) {
      setModelsLoading(false)
      return
    }
    let active = true
    desktopClient
      .listModels()
      .then((next) => {
        if (active) setModels(next.filter((model) => !model.hidden))
      })
      .catch(() => {
        if (active) setModels([])
      })
      .finally(() => {
        if (active) setModelsLoading(false)
      })
    return () => {
      active = false
    }
  }, [available])

  const assistant = settings?.assistant
  const selectedModel = models.find((model) => model.id === assistant?.model)
  const reasoningOptions = (selectedModel?.supportedReasoningEfforts ?? []).filter(
    (option) => ALLOWED_EFFORTS.has(option.reasoningEffort),
  )
  const modelDiscoveryFailed = available && !modelsLoading && models.length === 0

  const changeModel = (modelId: string) => {
    if (!assistant || modelId === assistant.model) return
    const nextModel = models.find((model) => model.id === modelId)
    const supported = (nextModel?.supportedReasoningEfforts ?? []).filter((option) =>
      ALLOWED_EFFORTS.has(option.reasoningEffort),
    )
    const keepEffort = supported.some(
      (option) => option.reasoningEffort === assistant.reasoningEffort,
    )
    const nextEffort =
      keepEffort || supported.length === 0
        ? assistant.reasoningEffort
        : (supported[0].reasoningEffort as ReasoningEffort)
    setStatus('idle')
    void update({ assistant: { model: modelId, reasoningEffort: nextEffort } })
  }

  const testConnection = async () => {
    setStatus('testing')
    setStatusMessage('')
    try {
      const result = await desktopClient.testConnection()
      if (result.success) {
        setStatus('success')
      } else {
        setStatus('error')
        setStatusMessage(result.error ?? 'Unknown error')
      }
    } catch (cause) {
      setStatus('error')
      setStatusMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const saveApiKey = async () => {
    if (!apiKey.trim()) return
    setSavingApiKey(true)
    try {
      await onSetApiKey(apiKey.trim())
      setApiKey('')
    } finally {
      setSavingApiKey(false)
    }
  }

  const disabled = !settings || !available

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-6">
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
            label="Model"
            htmlFor="settings-model"
            description={
              modelDiscoveryFailed
                ? 'No models returned. Check the connection or credentials.'
                : undefined
            }
            control={
              <Select
                id="settings-model"
                monospace
                className="max-w-[220px]"
                value={assistant?.model ?? ''}
                disabled={disabled || modelsLoading || modelDiscoveryFailed}
                onChange={(event) => changeModel(event.target.value)}
              >
                {assistant && !models.some((model) => model.id === assistant.model) && (
                  <option value={assistant.model}>{assistant.model}</option>
                )}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </Select>
            }
          />
          <SettingRow
            label="Connection"
            description={<ConnectionLine status={status} message={statusMessage} />}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || status === 'testing'}
                onClick={testConnection}
              >
                {status === 'testing' && <Loader2 className="animate-spin" />}
                Test
              </Button>
            }
          />
          <SettingRow
            label="Reasoning effort"
            stacked
            description={
              selectedModel
                ? `Options available for ${selectedModel.displayName}.`
                : 'Options load from Codex once a model is selected.'
            }
            control={
              reasoningOptions.length ? (
                <div className="flex flex-col gap-1.5">
                  {reasoningOptions.map((option) => {
                    const active = assistant?.reasoningEffort === option.reasoningEffort
                    return (
                      <label
                        key={option.reasoningEffort}
                        className={cn(
                          'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                          active
                            ? 'border-primary bg-primary/5'
                            : 'border-border bg-background hover:bg-accent/50',
                        )}
                      >
                        <input
                          type="radio"
                          name="reasoning-effort"
                          className="mt-0.5 size-3.5 accent-[var(--primary)]"
                          checked={active}
                          disabled={disabled}
                          onChange={() =>
                            update({
                              assistant: {
                                reasoningEffort: option.reasoningEffort as ReasoningEffort,
                              },
                            })
                          }
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
                    )
                  })}
                </div>
              ) : (
                <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs capitalize text-muted-foreground">
                  {assistant?.reasoningEffort ?? 'default'} (current)
                </p>
              )
            }
          />
        </CardRows>
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Tools & privacy</CardTitle>
            <CardDescription>
              Optional capabilities and overlay behaviour.
            </CardDescription>
          </div>
        </CardHeader>
        <CardRows>
          <SettingRow
            label="Web search"
            description="Let Codex use live web search when current information is needed."
            control={
              <Switch
                checked={assistant?.webSearchEnabled ?? false}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  update({ assistant: { webSearchEnabled: checked } })
                }
              />
            }
          />
          <SettingRow
            label="Stealth mode"
            description="Apply content protection so the overlay is hidden from screen capture."
            control={
              <Switch
                checked={settings?.privacy.stealthMode ?? false}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  update({ privacy: { stealthMode: checked } })
                }
              />
            }
          />
        </CardRows>
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Keyboard className="size-4 text-muted-foreground" />
              Keyboard shortcuts
            </CardTitle>
            <CardDescription>
              Click a shortcut, then press the keys you want. Changes apply
              immediately.
            </CardDescription>
          </div>
        </CardHeader>
        <CardRows>
          {SHORTCUT_ACTIONS.map((action) => (
            <SettingRow
              key={action}
              label={SHORTCUT_METADATA[action].label}
              description={SHORTCUT_METADATA[action].description}
              control={
                <ShortcutRecorder
                  value={settings?.shortcuts[action] ?? DEFAULT_SHORTCUTS[action]}
                  defaultValue={DEFAULT_SHORTCUTS[action]}
                  conflicted={shortcutConflicts[action] ?? false}
                  disabled={disabled}
                  onChange={(accelerator) =>
                    update({ shortcuts: { [action]: accelerator } })
                  }
                />
              }
            />
          ))}
        </CardRows>
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Theme applies instantly across the app.</CardDescription>
          </div>
        </CardHeader>
        <CardRows>
          <SettingRow
            label="Theme"
            control={
              <div className="inline-flex rounded-lg border border-border bg-background p-0.5">
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon
                  const active = settings?.appearance.theme === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => update({ appearance: { theme: option.value } })}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
                        active
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" />
                      {option.label}
                    </button>
                  )
                })}
              </div>
            }
          />
          <SettingRow
            label="Reduced motion"
            description="Minimise animations and transitions."
            control={
              <Switch
                checked={settings?.appearance.reducedMotion ?? false}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  update({ appearance: { reducedMotion: checked } })
                }
              />
            }
          />
        </CardRows>
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>API key</CardTitle>
            <CardDescription>
              Provide an OpenAI API key. It is encrypted with system storage.
            </CardDescription>
          </div>
        </CardHeader>
        <div className="flex items-center gap-2 p-4 pt-3">
          <Input
            type="password"
            autoComplete="off"
            placeholder="sk-…"
            value={apiKey}
            disabled={!available || savingApiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Button
            disabled={!available || savingApiKey || !apiKey.trim()}
            onClick={saveApiKey}
          >
            {savingApiKey ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Save
          </Button>
        </div>
      </Card>

      <p className="flex items-center gap-4 px-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Globe className="size-3.5" /> Web search{' '}
          {assistant?.webSearchEnabled ? 'on' : 'off'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Eye className="size-3.5" /> Stealth{' '}
          {settings?.privacy.stealthMode ? 'on' : 'off'}
        </span>
      </p>
    </div>
  )
}

const ConnectionLine: React.FC<{ status: ConnectionStatus; message: string }> = ({
  status,
  message,
}) => {
  if (status === 'idle') {
    return <span className="text-xs text-muted-foreground">Not tested yet.</span>
  }
  const icon =
    status === 'testing' ? (
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
    ) : status === 'success' ? (
      <CheckCircle2 className="size-3.5 text-emerald-500" />
    ) : (
      <XCircle className="size-3.5 text-destructive" />
    )
  const label =
    status === 'testing'
      ? 'Testing…'
      : status === 'success'
        ? 'Connected'
        : message || 'Failed'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {icon}
      <span className={cn(status === 'error' && 'text-destructive')}>{label}</span>
    </span>
  )
}
