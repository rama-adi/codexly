import { CheckCircle2, ChevronDown, CircleDotDashed, XCircle } from 'lucide-react'
import { useState } from 'react'

import type { ToolActivity } from '../types'

function StateIcon({ state }: { state: ToolActivity['state'] }) {
  if (state === 'complete') return <CheckCircle2 size={13} className="ov-tool-icon ov-tool-icon--ok" />
  if (state === 'error') return <XCircle size={13} className="ov-tool-icon ov-tool-icon--err" />
  return <CircleDotDashed size={13} className="ov-tool-icon ov-tool-icon--run ov-spin" />
}

export function ToolActivityCard({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false)
  const hasOutput = Boolean(activity.output && activity.output.trim())

  return (
    <div className={`ov-tool ov-tool--${activity.state}`}>
      <button
        type="button"
        className="ov-tool-head"
        onClick={() => hasOutput && setExpanded((current) => !current)}
        aria-expanded={hasOutput ? expanded : undefined}
      >
        <StateIcon state={activity.state} />
        <span className="ov-tool-text">
          <b>{activity.name}</b>
          {activity.detail && <small>{activity.detail}</small>}
        </span>
        {hasOutput && <ChevronDown size={12} className={`ov-tool-chevron ${expanded ? 'is-open' : ''}`} />}
      </button>
      {hasOutput && expanded && <pre className="ov-tool-output">{activity.output}</pre>}
    </div>
  )
}
