import React from "react"
import { IoLogOutOutline } from "react-icons/io5"
import { RotateCcw, Settings, Trash2, X } from "lucide-react"

interface QueueCommandsProps {
  onTooltipVisibilityChange?: (visible: boolean, height: number) => void
  screenshots: Array<{ path: string; preview: string }>
  onChatToggle?: () => void
  onSettingsOpen: () => void
  onClearBuffer?: () => void
  onResetSession?: () => void
  chatControl?: React.ReactNode
}

const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] leading-none text-white/80">
    {children}
  </span>
)

const QueueCommands: React.FC<QueueCommandsProps> = ({
  screenshots,
  onChatToggle,
  onSettingsOpen,
  onClearBuffer,
  onResetSession,
  chatControl
}) => {
  return (
    <div className="draggable-area inline-flex items-center gap-3 px-3 h-8 rounded-lg bg-black/60 border border-white/10 text-white/90 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="text-white/70">Show/Hide</span>
        <Key>⌘</Key>
        <Key>B</Key>
      </div>

      {screenshots.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="text-white/70">Solve</span>
          <Key>⌘</Key>
          <Key>↵</Key>
        </div>
      )}

      <button
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-white/80 transition-colors hover:bg-white/10"
        onClick={onClearBuffer}
        type="button"
        title="Clear current screenshot buffer (Cmd+K)"
        aria-label="Clear current screenshot buffer"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Clear
        <Key>⌘K</Key>
      </button>

      <button
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-white/80 transition-colors hover:bg-white/10"
        onClick={onResetSession}
        type="button"
        title="Reset session (Cmd+R)"
        aria-label="Reset session"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Reset
        <Key>⌘R</Key>
      </button>

      <div className="h-4 w-px bg-white/15" />

      {chatControl ?? (
        <button
          className="px-2 py-1 rounded hover:bg-white/10 transition-colors text-white/80"
          onClick={onChatToggle}
          type="button"
        >
          Chat
        </button>
      )}

      <button
        className="w-6 h-6 rounded hover:bg-white/10 transition-colors text-white/80 inline-flex items-center justify-center"
        onClick={onSettingsOpen}
        type="button"
        title="Settings"
        aria-label="Settings"
      >
        <Settings className="w-4 h-4" />
      </button>

      <div className="h-4 w-px bg-white/15" />

      <button
        className="text-red-400/70 hover:text-red-400 transition-colors"
        title="Hide overlay"
        aria-label="Hide overlay"
        onClick={() => window.electronAPI.hideMainWindow()}
      >
        <IoLogOutOutline className="w-4 h-4" />
      </button>

      <button
        className="text-red-400/70 hover:text-red-400 transition-colors"
        title="Close app"
        aria-label="Close app"
        onClick={() => window.electronAPI.closeCurrentWindow()}
        type="button"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

export default QueueCommands
