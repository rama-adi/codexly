import { ChevronDown } from 'lucide-react'

import type { ModelChoice } from '../types'

export function ModelSelect({
  models,
  value,
  onChange,
  disabled = false,
}: {
  models: ModelChoice[]
  value: string
  onChange(id: string): void
  disabled?: boolean
}) {
  return (
    <div className="relative mx-0.5 inline-flex items-center">
      <select
        className="h-6 max-w-[130px] appearance-none rounded-md border border-transparent bg-white/6 pl-[7px] pr-[18px] text-[10px] font-medium text-ellipsis text-hud-dim transition-colors hover:bg-white/10 hover:text-hud-text"
        aria-label="Codex model"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
          </option>
        ))}
      </select>
      <ChevronDown size={10} className="pointer-events-none absolute right-1.5 text-hud-faint" />
    </div>
  )
}
