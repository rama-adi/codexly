import {
  Camera,
  Crop,
  GripVertical,
  MessageSquare,
  RotateCcw,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ModelChoice } from '../types'
import { Key } from './Key'
import { ModelSelect } from './ModelSelect'

const barButton =
  'inline-flex h-7 items-center gap-[5px] rounded-hud-sm border-0 bg-transparent px-2 text-[11px] font-medium text-hud-dim transition-colors enabled:hover:bg-white/9 enabled:hover:text-hud-text disabled:cursor-default disabled:opacity-35 [&>svg]:shrink-0 [&>svg]:opacity-85'

const barGroup = 'inline-flex items-center gap-1 px-0.5'

export function CommandBar({
  attachments,
  chatOpen,
  busy,
  models,
  modelId,
  onModelChange,
  onCapture,
  onCaptureSelection,
  onSolve,
  onClear,
  onReset,
  onChat,
  onSettings,
  onClose,
  captureKey,
  captureSelectionKey,
  solveKey,
}: {
  attachments: number
  chatOpen: boolean
  busy: boolean
  models: ModelChoice[]
  modelId: string
  onModelChange(id: string): void
  onCapture(): void
  onCaptureSelection(): void
  onSolve(): void
  onClear(): void
  onReset(): void
  onChat(): void
  onSettings(): void
  onClose(): void
  captureKey: string
  captureSelectionKey: string
  solveKey: string
}) {
  return (
    <div className="draggable-area inline-flex h-[38px] animate-hud-rise items-center gap-1 rounded-hud border border-hud-line bg-hud-bg px-2.5 whitespace-nowrap shadow-hud backdrop-blur-[28px] backdrop-saturate-[1.4]">
      <div
        className="draggable-area mr-0.5 grid size-7 cursor-grab place-items-center rounded-[7px] text-hud-faint active:cursor-grabbing"
        aria-hidden
        title="Drag to move"
      >
        <GripVertical size={14} />
      </div>

      <div className={cn(barGroup, 'draggable-area')}>
        <button className={barButton} onClick={onCapture} title="Capture display">
          <Camera size={13} />
          <span>Capture</span>
          <Key>{captureKey}</Key>
        </button>
        <button className={barButton} onClick={onCaptureSelection} title="Capture a screen region">
          <Crop size={13} />
          <span>Select</span>
          <Key>{captureSelectionKey}</Key>
        </button>
      </div>

      {attachments > 0 && (
        <button
          className={cn(
            barButton,
            'animate-hud-fade bg-hud-accent-soft font-[650] text-hud-accent enabled:hover:bg-hud-accent-strong enabled:hover:text-hud-accent',
          )}
          onClick={onSolve}
          disabled={busy}
        >
          <Sparkles size={13} />
          <span>Solve</span>
          <Key>{solveKey}</Key>
        </button>
      )}

      <div className={cn(barGroup, 'draggable-area')}>
        <button
          className={barButton}
          onClick={onClear}
          title="Clear queue"
          disabled={!attachments || busy}
        >
          <Trash2 size={13} />
        </button>
        <button className={barButton} onClick={onReset} title="Reset session" disabled={busy}>
          <RotateCcw size={13} />
        </button>
      </div>

      <span className="draggable-area mx-[3px] h-4 w-px bg-hud-line-strong" />

      <ModelSelect models={models} value={modelId} onChange={onModelChange} disabled={busy} />

      <button
        className={cn(barButton, chatOpen && 'bg-white/9 text-hud-text')}
        onClick={onChat}
        title="Toggle chat"
      >
        <MessageSquare size={13} />
        <span>Chat</span>
      </button>
      <button
        className={barButton}
        onClick={onSettings}
        aria-label="Open settings"
        title="Settings"
      >
        <Settings size={13} />
      </button>
      <button className={barButton} onClick={onClose} aria-label="Hide overlay" title="Hide overlay">
        <X size={13} />
      </button>
    </div>
  )
}
