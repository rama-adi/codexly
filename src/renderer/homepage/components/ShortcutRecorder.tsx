import * as React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  acceleratorTokens,
  detectPlatform,
  eventToAccelerator,
} from '../../../shared/shortcuts/accelerator'

interface ShortcutRecorderProps {
  /** The current Electron accelerator, e.g. "CommandOrControl+Shift+Space". */
  value: string
  /** The default accelerator; when set and different, a reset control appears. */
  defaultValue?: string
  /** True when the OS/another app refused to register this accelerator. */
  conflicted?: boolean
  disabled?: boolean
  onChange: (accelerator: string) => void
}

const platform = detectPlatform()

export const ShortcutRecorder: React.FC<ShortcutRecorderProps> = ({
  value,
  defaultValue,
  conflicted = false,
  disabled = false,
  onChange,
}) => {
  const [recording, setRecording] = React.useState(false)
  const [hint, setHint] = React.useState<string | null>(null)
  const buttonRef = React.useRef<HTMLButtonElement>(null)

  const stop = React.useCallback(() => {
    setRecording(false)
    setHint(null)
  }, [])

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!recording) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        stop()
        return
      }
      const result = eventToAccelerator(event.nativeEvent)
      if (result.accelerator) {
        if (result.accelerator !== value) onChange(result.accelerator)
        stop()
        buttonRef.current?.blur()
        return
      }
      if (result.reason === 'needs-modifier') {
        setHint('Include ⌘, ⌃, or ⌥')
      }
    },
    [recording, value, onChange, stop],
  )

  const tokens = acceleratorTokens(value, platform)
  const canReset = Boolean(defaultValue) && value !== defaultValue

  return (
    <div className="flex items-center gap-1.5">
      {conflicted && !recording && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400"
          title="Another app may be using this shortcut. Pick a different combination."
        >
          <AlertTriangle className="size-3.5" />
          In use
        </span>
      )}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={
          recording ? 'Recording shortcut, press a key combination' : 'Change shortcut'
        }
        onClick={() => {
          if (disabled) return
          setHint(null)
          setRecording(true)
        }}
        onKeyDown={handleKeyDown}
        onBlur={stop}
        className={cn(
          'inline-flex min-w-[132px] items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
          recording
            ? 'border-primary bg-primary/5 text-primary'
            : conflicted
              ? 'border-amber-500/60 bg-background text-foreground hover:bg-accent/50'
              : 'border-border bg-background text-foreground hover:bg-accent/50',
        )}
      >
        {recording ? (
          <span className="text-muted-foreground">{hint ?? 'Press keys…'}</span>
        ) : (
          tokens.map((token, index) => (
            <kbd
              key={`${token}-${index}`}
              className="hp-kbd min-w-[1.4em] text-center"
            >
              {token}
            </kbd>
          ))
        )}
      </button>
      <button
        type="button"
        aria-label="Reset to default"
        title="Reset to default"
        disabled={disabled || !canReset}
        onClick={() => defaultValue && onChange(defaultValue)}
        className={cn(
          'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
          (!canReset || disabled) && 'invisible',
        )}
      >
        <RotateCcw className="size-3.5" />
      </button>
    </div>
  )
}
