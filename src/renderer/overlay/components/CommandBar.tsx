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

import type { ModelChoice } from '../types'
import { Key } from './Key'
import { ModelSelect } from './ModelSelect'

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
    <div className="ov-bar draggable-area">
      <div className="ov-grip" aria-hidden title="Drag to move">
        <GripVertical size={14} />
      </div>

      <div className="ov-bar-group draggable-area">
        <button onClick={onCapture} title="Capture display">
          <Camera size={13} />
          <span>Capture</span>
          <Key>{captureKey}</Key>
        </button>
        <button onClick={onCaptureSelection} title="Capture a screen region">
          <Crop size={13} />
          <span>Select</span>
          <Key>{captureSelectionKey}</Key>
        </button>
      </div>

      {attachments > 0 && (
        <button className="ov-solve" onClick={onSolve} disabled={busy}>
          <Sparkles size={13} />
          <span>Solve</span>
          <Key>{solveKey}</Key>
        </button>
      )}

      <div className="ov-bar-group draggable-area">
        <button onClick={onClear} title="Clear queue" disabled={!attachments || busy}>
          <Trash2 size={13} />
        </button>
        <button onClick={onReset} title="Reset session" disabled={busy}>
          <RotateCcw size={13} />
        </button>
      </div>

      <span className="ov-divider draggable-area" />

      <ModelSelect models={models} value={modelId} onChange={onModelChange} disabled={busy} />

      <button className={chatOpen ? 'active' : ''} onClick={onChat} title="Toggle chat">
        <MessageSquare size={13} />
        <span>Chat</span>
      </button>
      <button onClick={onSettings} aria-label="Open settings" title="Settings">
        <Settings size={13} />
      </button>
      <button onClick={onClose} aria-label="Hide overlay" title="Hide overlay">
        <X size={13} />
      </button>
    </div>
  )
}
