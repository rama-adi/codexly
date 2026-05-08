import React, { useEffect, useState } from "react"
import { Loader2, Save } from "lucide-react"

import { Button } from "@/components/ui/button"
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
    window.electronAPI.getPersonalization()
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

    const unsubscribe = window.electronAPI.onPersonalizationChanged(next => {
      setConfig(next)
      setDraft(next)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const dirty = JSON.stringify(config) !== JSON.stringify(draft)
  const updateDraft = <Key extends keyof PersonalizationConfig>(
    key: Key,
    value: PersonalizationConfig[Key]
  ) => setDraft(current => ({ ...current, [key]: value }))

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      const next = await window.electronAPI.updatePersonalization(draft)
      setConfig(next)
      setDraft(next)
    } catch (error) {
      setError(String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Personalization</h2>
          <p className="mt-1 text-xs text-[#5f6368]">
            Prompt behavior saved in the local app settings folder.
          </p>
        </div>
        <Button size="sm" onClick={save} disabled={loading || saving || !dirty}>
          {saving ? <Loader2 data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          Save
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="divide-y divide-black/10 rounded-md border border-black/10 bg-white">
        <SelectRow
          label="Mode"
          value={draft.mode}
          disabled={loading}
          options={[
            { value: "question", label: "Question" },
            { value: "coding", label: "Coding" }
          ]}
          onChange={value => updateDraft("mode", value as PersonalizationConfig["mode"])}
        />
        <SelectRow
          label="Verbosity"
          value={draft.verbosity}
          disabled={loading}
          options={[
            { value: "concise", label: "Concise" },
            { value: "verbose", label: "Verbose" }
          ]}
          onChange={value => updateDraft("verbosity", value as PersonalizationConfig["verbosity"])}
        />
        <SwitchRow
          label="Custom instructions"
          checked={draft.customInstructionsEnabled}
          disabled={loading}
          onChange={value => updateDraft("customInstructionsEnabled", value)}
        />
        <label className="flex flex-col gap-2 px-3 py-3">
          <span className="text-sm font-medium">Instructions</span>
          <textarea
            value={draft.customInstructions}
            disabled={loading || !draft.customInstructionsEnabled}
            rows={8}
            onChange={event => updateDraft("customInstructions", event.target.value)}
            className="min-h-40 resize-y rounded-md border border-black/15 bg-[#f7f7f5] px-2 py-2 text-xs leading-relaxed text-[#1f2328] outline-none transition-colors hover:bg-[#eeeeea] focus:bg-white disabled:cursor-default disabled:opacity-60"
          />
        </label>
      </div>
    </section>
  )
}

const SelectRow: React.FC<{
  label: string
  value: string
  disabled?: boolean
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}> = ({ label, value, disabled = false, options, onChange }) => (
  <label className="flex min-h-12 items-center justify-between gap-4 px-3 py-2">
    <span className="text-sm font-medium">{label}</span>
    <select
      value={value}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      className="h-8 max-w-[220px] rounded-md border border-black/15 bg-[#f7f7f5] px-2 text-xs text-[#1f2328] outline-none transition-colors hover:bg-[#eeeeea] disabled:cursor-default disabled:opacity-60"
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  </label>
)

const SwitchRow: React.FC<{
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}> = ({ label, checked, disabled = false, onChange }) => (
  <div className="flex min-h-12 items-center justify-between gap-4 px-3 py-2">
    <div className="text-sm font-medium">{label}</div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 rounded-full transition-colors disabled:cursor-default disabled:opacity-60 ${
        checked ? "bg-[#1f883d]" : "bg-black/20"
      }`}
    >
      <span
        className={`absolute left-0 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  </div>
)

export default Personalization
