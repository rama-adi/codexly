import React, { useEffect, useRef, useState } from "react"
import { IoLogOutOutline } from "react-icons/io5"

interface QueueCommandsProps {
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  screenshots: Array<{ path: string; preview: string }>
  onChatToggle: () => void
  onSettingsToggle: () => void
}

const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] leading-none text-white/80">
    {children}
  </span>
)

const QueueCommands: React.FC<QueueCommandsProps> = ({
  onTooltipVisibilityChange,
  screenshots,
  onChatToggle,
  onSettingsToggle,
}) => {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = tooltipRef.current && isTooltipVisible ? tooltipRef.current.offsetHeight + 8 : 0
    onTooltipVisibilityChange(isTooltipVisible, h)
  }, [isTooltipVisible])

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

      <div className="h-4 w-px bg-white/15" />

      <button
        className="px-2 py-1 rounded hover:bg-white/10 transition-colors text-white/80"
        onClick={onChatToggle}
        type="button"
      >
        Chat
      </button>

      <button
        className="px-2 py-1 rounded hover:bg-white/10 transition-colors text-white/80"
        onClick={onSettingsToggle}
        type="button"
      >
        Model
      </button>

      <div
        className="relative"
        onMouseEnter={() => setIsTooltipVisible(true)}
        onMouseLeave={() => setIsTooltipVisible(false)}
      >
        <div className="w-5 h-5 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center cursor-help text-[11px] text-white/70">
          ?
        </div>
        {isTooltipVisible && (
          <div ref={tooltipRef} className="absolute top-full right-0 mt-2 w-72 z-50">
            <div className="p-3 rounded-lg bg-black/85 border border-white/10 text-white/85 text-xs space-y-2">
              <Shortcut keys={["⌘", "B"]} title="Toggle Window" desc="Show or hide this window." />
              <Shortcut keys={["⌘", "H"]} title="Take Screenshot" desc="Capture and analyze. Keeps the 5 latest." />
              <Shortcut keys={["⌘", "↵"]} title="Solve" desc="Generate a solution from the current problem." />
            </div>
          </div>
        )}
      </div>

      <div className="h-4 w-px bg-white/15" />

      <button
        className="text-red-400/70 hover:text-red-400 transition-colors"
        title="Quit"
        onClick={() => window.electronAPI.quitApp()}
      >
        <IoLogOutOutline className="w-4 h-4" />
      </button>
    </div>
  )
}

const Shortcut: React.FC<{ keys: string[]; title: string; desc: string }> = ({ keys, title, desc }) => (
  <div>
    <div className="flex items-center justify-between">
      <span className="text-white/90">{title}</span>
      <div className="flex gap-1">
        {keys.map(k => (
          <Key key={k}>{k}</Key>
        ))}
      </div>
    </div>
    <p className="mt-0.5 text-[11px] text-white/55">{desc}</p>
  </div>
)

export default QueueCommands
