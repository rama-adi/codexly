import { ChevronDown } from 'lucide-react'

import type { ModelChoice } from '../types'

export function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: ModelChoice[]
  value: string
  onChange(id: string): void
}) {
  return (
    <div className="ov-model">
      <select
        aria-label="Codex model"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
          </option>
        ))}
      </select>
      <ChevronDown size={10} />
    </div>
  )
}
