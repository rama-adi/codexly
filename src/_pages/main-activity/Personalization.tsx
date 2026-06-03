import React, { useEffect, useMemo, useState } from "react"
import { Loader2, Save } from "lucide-react"

import { Button } from "@/components/ui/button"
import { personalizationService } from "@/services/desktop"
import {
  Card,
  CardDescription,
  CardHeader,
  CardRows,
  CardTitle
} from "@/components/ui/card"
import { usePageActions } from "@/components/ui/page-header"
import { Select } from "@/components/ui/select"
import { SettingRow } from "@/components/ui/setting-row"
import { Switch } from "@/components/ui/switch"
import type { PersonalizationConfig } from "@/types/electron"

const defaults: PersonalizationConfig = {
  mode: "question",
  verbosity: "concise",
  customInstructionsEnabled: false,
  customInstructions: ""
}

const Personalization: React.FC = () => {
  const [config, setConfig] = useState(defaults)
  const [draft, setDraft] = useState(defaults)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let mounted = true
    personalizationService
      .get()
      .then(next => {
        if (!mounted) return
        setConfig(next)
        setDraft(next)
      })
      .catch(error => {
        if (mounted) setError(String(error))
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })

    const unsubscribe = personalizationService.onChanged(next => {
      setConfig(next)
      setDraft(next)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(draft),
    [config, draft]
  )

  const updateDraft = <Key extends keyof PersonalizationConfig>(
    key: Key,
    value: PersonalizationConfig[Key]
  ) => setDraft(current => ({ ...current, [key]: value }))

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      const next = await personalizationService.update(draft)
      setConfig(next)
      setDraft(next)
    } catch (error) {
      setError(String(error))
    } finally {
      setSaving(false)
    }
  }

  const saveAction = useMemo(
    () => (
      <Button
        size="sm"
        onClick={save}
        disabled={loading || saving || !dirty}
      >
        {saving ? (
          <Loader2 data-icon="inline-start" className="animate-spin" />
        ) : (
          <Save data-icon="inline-start" />
        )}
        Save
      </Button>
    ),
    [loading, saving, dirty, draft]
  )
  usePageActions(saveAction)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#f3f5f6] text-foreground">
      <div className="m-2 min-h-[calc(100vh-4rem)] rounded-xl border border-[#dfe3e6] bg-white px-5 py-5 shadow-[0_1px_2px_rgba(15,23,42,0.08),0_16px_42px_rgba(15,23,42,0.05)]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Behavior</CardTitle>
              <CardDescription>
                Saved locally in the app settings folder.
              </CardDescription>
            </div>
          </CardHeader>
          <CardRows>
            <SettingRow
              label="Mode"
              control={
                <Select
                  value={draft.mode}
                  disabled={loading}
                  onChange={event =>
                    updateDraft(
                      "mode",
                      event.target.value as PersonalizationConfig["mode"]
                    )
                  }
                  className="max-w-[160px]"
                >
                  <option value="question">Question</option>
                  <option value="coding">Coding</option>
                </Select>
              }
            />
            <SettingRow
              label="Verbosity"
              control={
                <Select
                  value={draft.verbosity}
                  disabled={loading}
                  onChange={event =>
                    updateDraft(
                      "verbosity",
                      event.target.value as PersonalizationConfig["verbosity"]
                    )
                  }
                  className="max-w-[160px]"
                >
                  <option value="concise">Concise</option>
                  <option value="verbose">Verbose</option>
                </Select>
              }
            />
            <SettingRow
              label="Custom instructions"
              description="Append your own preamble to every prompt."
              control={
                <Switch
                  checked={draft.customInstructionsEnabled}
                  disabled={loading}
                  onCheckedChange={value =>
                    updateDraft("customInstructionsEnabled", value)
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
              <CardDescription>
                Used when custom instructions is on.
              </CardDescription>
            </div>
          </CardHeader>
          <div className="p-4">
            <textarea
              value={draft.customInstructions}
              disabled={loading || !draft.customInstructionsEnabled}
              rows={8}
              onChange={event =>
                updateDraft("customInstructions", event.target.value)
              }
              placeholder="e.g. Always answer in Indonesian. Avoid emojis."
              className="min-h-40 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs leading-relaxed text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60"
            />
          </div>
        </Card>
        </div>
      </div>
    </div>
  )
}

export default Personalization
