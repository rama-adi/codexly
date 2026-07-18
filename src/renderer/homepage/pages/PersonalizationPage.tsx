import * as React from 'react'
import { Loader2, RotateCcw, Save } from 'lucide-react'

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
import { Textarea } from '@/components/ui/textarea'
import type {
  AssistantMode,
  AssistantVerbosity,
  CanonicalSettings,
} from '../../../shared/schemas/settings'
import type { SettingsPatch } from '../hooks/useSettings'

interface PersonalizationPageProps {
  settings: CanonicalSettings | null
  update: (patch: SettingsPatch) => Promise<CanonicalSettings | null>
  saving: boolean
  available: boolean
}

interface Draft {
  mode: AssistantMode
  codingLanguage: string
  verbosity: AssistantVerbosity
  responseLanguage: string
  customInstructionsEnabled: boolean
  customInstructions: string
}

function toDraft(settings: CanonicalSettings): Draft {
  const { assistant } = settings
  return {
    mode: assistant.mode,
    codingLanguage: assistant.codingLanguage,
    verbosity: assistant.verbosity,
    responseLanguage: assistant.responseLanguage,
    customInstructionsEnabled: assistant.customInstructionsEnabled,
    customInstructions: assistant.customInstructions,
  }
}

export const PersonalizationPage: React.FC<PersonalizationPageProps> = ({
  settings,
  update,
  saving,
  available,
}) => {
  const [draft, setDraft] = React.useState<Draft | null>(
    settings ? toDraft(settings) : null,
  )
  const savedKey = settings ? JSON.stringify(toDraft(settings)) : null

  React.useEffect(() => {
    if (settings) setDraft(toDraft(settings))
  }, [savedKey, settings])

  if (!settings || !draft) {
    return (
      <div className="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading preferences…
      </div>
    )
  }

  const dirty = savedKey !== JSON.stringify(draft)
  const patch = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current))

  const save = () => {
    const codingLanguage = draft.codingLanguage.trim() || settings.assistant.codingLanguage
    void update({
      assistant: {
        mode: draft.mode,
        codingLanguage,
        verbosity: draft.verbosity,
        responseLanguage: draft.responseLanguage.trim(),
        customInstructionsEnabled: draft.customInstructionsEnabled,
        customInstructions: draft.customInstructions,
      },
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Saved locally and applied to every prompt.
        </p>
        <div className="flex items-center gap-2">
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(toDraft(settings))}
            >
              <RotateCcw />
              Reset
            </Button>
          )}
          <Button size="sm" disabled={!available || !dirty || saving} onClick={save}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Save
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Behavior</CardTitle>
            <CardDescription>
              How Codexly frames and delivers its answers.
            </CardDescription>
          </div>
        </CardHeader>
        <CardRows>
          <SettingRow
            label="Mode"
            htmlFor="pers-mode"
            control={
              <Select
                id="pers-mode"
                className="max-w-[180px]"
                value={draft.mode}
                onChange={(event) => patch('mode', event.target.value as AssistantMode)}
              >
                <option value="question">Question</option>
                <option value="coding">Coding</option>
              </Select>
            }
          />
          {draft.mode === 'coding' && (
            <SettingRow
              label="Coding language"
              htmlFor="pers-lang"
              description="Preferred language for code answers."
              control={
                <Input
                  id="pers-lang"
                  className="max-w-[180px]"
                  value={draft.codingLanguage}
                  placeholder="TypeScript"
                  onChange={(event) => patch('codingLanguage', event.target.value)}
                />
              }
            />
          )}
          <SettingRow
            label="Verbosity"
            htmlFor="pers-verbosity"
            control={
              <Select
                id="pers-verbosity"
                className="max-w-[180px]"
                value={draft.verbosity}
                onChange={(event) =>
                  patch('verbosity', event.target.value as AssistantVerbosity)
                }
              >
                <option value="concise">Concise</option>
                <option value="verbose">Verbose</option>
              </Select>
            }
          />
          <SettingRow
            label="Response language"
            htmlFor="pers-response-lang"
            description="Leave blank to let the model decide."
            control={
              <Input
                id="pers-response-lang"
                className="max-w-[180px]"
                maxLength={35}
                value={draft.responseLanguage}
                placeholder="e.g. English"
                onChange={(event) => patch('responseLanguage', event.target.value)}
              />
            }
          />
          <SettingRow
            label="Custom instructions"
            description="Append your own preamble to every prompt."
            control={
              <Switch
                checked={draft.customInstructionsEnabled}
                onCheckedChange={(checked) =>
                  patch('customInstructionsEnabled', checked)
                }
              />
            }
          />
        </CardRows>
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Instructions</CardTitle>
            <CardDescription>Used when custom instructions is on.</CardDescription>
          </div>
        </CardHeader>
        <div className="p-4 pt-3">
          <Textarea
            rows={7}
            maxLength={4000}
            value={draft.customInstructions}
            disabled={!draft.customInstructionsEnabled}
            placeholder="e.g. Always answer in Indonesian. Avoid emojis."
            onChange={(event) => patch('customInstructions', event.target.value)}
          />
          <div className="mt-1.5 text-right text-[11px] text-muted-foreground">
            {draft.customInstructions.length} / 4000
          </div>
        </div>
      </Card>
    </div>
  )
}
