import React, { useState, useEffect, useRef } from "react"
import { useQuery } from "react-query"
import ScreenshotQueue from "../components/Queue/ScreenshotQueue"
import {
  Toast,
  ToastTitle,
  ToastDescription,
  ToastVariant,
  ToastMessage
} from "../components/ui/toast"
import QueueCommands from "../components/Queue/QueueCommands"
import ModelSelector from "../components/ui/ModelSelector"

interface QueueProps {
  setView: React.Dispatch<React.SetStateAction<"queue" | "solutions" | "debug">>
}

const Queue: React.FC<QueueProps> = ({ setView }) => {
  const [toastOpen, setToastOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<ToastMessage>({
    title: "",
    description: "",
    variant: "neutral"
  })

  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const [tooltipHeight, setTooltipHeight] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  const [chatInput, setChatInput] = useState("")
  const [chatMessages, setChatMessages] = useState<{role: "user"|"assistant", text: string}[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const chatInputRef = useRef<HTMLInputElement>(null)
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [currentModel, setCurrentModel] = useState<{ provider: string; model: string }>({ provider: "openai", model: "gpt-5.4" })

  const barRef = useRef<HTMLDivElement>(null)

  const { data: screenshots = [], refetch } = useQuery<Array<{ path: string; preview: string }>, Error>(
    ["screenshots"],
    async () => {
      try {
        const existing = await window.electronAPI.getScreenshots()
        return existing
      } catch (error) {
        console.error("Error loading screenshots:", error)
        showToast("Error", "Failed to load existing screenshots", "error")
        return []
      }
    },
    {
      staleTime: Infinity,
      cacheTime: Infinity,
      refetchOnWindowFocus: true,
      refetchOnMount: true
    }
  )

  const showToast = (
    title: string,
    description: string,
    variant: ToastVariant
  ) => {
    setToastMessage({ title, description, variant })
    setToastOpen(true)
  }

  const handleDeleteScreenshot = async (index: number) => {
    const screenshotToDelete = screenshots[index]

    try {
      const response = await window.electronAPI.deleteScreenshot(
        screenshotToDelete.path
      )

      if (response.success) {
        refetch()
      } else {
        console.error("Failed to delete screenshot:", response.error)
        showToast("Error", "Failed to delete the screenshot file", "error")
      }
    } catch (error) {
      console.error("Error deleting screenshot:", error)
    }
  }

  const handleChatSend = async () => {
    if (!chatInput.trim()) return
    setChatMessages((msgs) => [...msgs, { role: "user", text: chatInput }])
    setChatLoading(true)
    setChatInput("")
    try {
      const response = await window.electronAPI.invoke("chat", chatInput)
      setChatMessages((msgs) => [...msgs, { role: "assistant", text: response }])
    } catch (err) {
      setChatMessages((msgs) => [...msgs, { role: "assistant", text: "Error: " + String(err) }])
    } finally {
      setChatLoading(false)
      chatInputRef.current?.focus()
    }
  }

  // Load current model configuration on mount
  useEffect(() => {
    const loadCurrentModel = async () => {
      try {
        const config = await window.electronAPI.getCurrentLlmConfig();
        setCurrentModel({ provider: config.provider, model: config.model });
      } catch (error) {
        console.error('Error loading current model config:', error);
      }
    };
    loadCurrentModel();
  }, []);

  useEffect(() => {
    const updateDimensions = () => {
      if (contentRef.current) {
        let contentHeight = contentRef.current.scrollHeight
        const contentWidth = contentRef.current.scrollWidth
        if (isTooltipVisible) {
          contentHeight += tooltipHeight
        }
        window.electronAPI.updateContentDimensions({
          width: contentWidth,
          height: contentHeight
        })
      }
    }

    const resizeObserver = new ResizeObserver(updateDimensions)
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current)
    }
    updateDimensions()

    const cleanupFunctions = [
      window.electronAPI.onScreenshotTaken(() => refetch()),
      window.electronAPI.onResetView(() => refetch()),
      window.electronAPI.onSolutionError((error: string) => {
        showToast(
          "Processing Failed",
          "There was an error processing your screenshots.",
          "error"
        )
        setView("queue")
        console.error("Processing error:", error)
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast(
          "No Screenshots",
          "There are no screenshots to process.",
          "neutral"
        )
      })
    ]

    return () => {
      resizeObserver.disconnect()
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [isTooltipVisible, tooltipHeight])

  // Seamless screenshot-to-LLM flow
  useEffect(() => {
    // Listen for screenshot taken event
    const unsubscribe = window.electronAPI.onScreenshotTaken(async (data) => {
      // Refetch screenshots to update the queue
      await refetch();
      // Show loading in chat
      setChatLoading(true);
      try {
        // Get the latest screenshot path
        const latest = data?.path || (Array.isArray(data) && data.length > 0 && data[data.length - 1]?.path);
        if (latest) {
          // Call the LLM to process the screenshot
          const response = await window.electronAPI.invoke("analyze-image-file", latest);
          setChatMessages((msgs) => [...msgs, { role: "assistant", text: response.text }]);
        }
      } catch (err) {
        setChatMessages((msgs) => [...msgs, { role: "assistant", text: "Error: " + String(err) }]);
      } finally {
        setChatLoading(false);
      }
    });
    return () => {
      unsubscribe && unsubscribe();
    };
  }, [refetch]);

  const handleTooltipVisibilityChange = (visible: boolean, height: number) => {
    setIsTooltipVisible(visible)
    setTooltipHeight(height)
  }

  const handleChatToggle = () => {
    setIsChatOpen(!isChatOpen)
  }

  const handleSettingsToggle = () => {
    setIsSettingsOpen(!isSettingsOpen)
  }



  return (
    <div
      ref={barRef}
      style={{
        position: "relative",
        width: "100%",
        pointerEvents: "auto"
      }}
      className="select-none"
    >
      <div className="px-2 py-2 space-y-2 w-fit" data-clickable-root>
        <Toast
          open={toastOpen}
          onOpenChange={setToastOpen}
          variant={toastMessage.variant}
          duration={3000}
        >
          <ToastTitle>{toastMessage.title}</ToastTitle>
          <ToastDescription>{toastMessage.description}</ToastDescription>
        </Toast>

        <QueueCommands
          screenshots={screenshots}
          onTooltipVisibilityChange={handleTooltipVisibilityChange}
          onChatToggle={handleChatToggle}
          onSettingsToggle={handleSettingsToggle}
        />

        {isSettingsOpen && (
          <div className="w-80">
            <ModelSelector onChatOpen={() => setIsChatOpen(true)} />
          </div>
        )}

        {isChatOpen && (
          <div className="w-96 rounded-lg bg-black/60 border border-white/10 p-3 flex flex-col gap-2">
            <div className="flex-1 overflow-y-auto max-h-64 min-h-[120px] rounded bg-black/30 border border-white/5 p-2 space-y-2">
              {chatMessages.length === 0 ? (
                <div className="text-xs text-white/50 text-center py-6">
                  Chat with <span className="font-mono text-white/70">{currentModel.model}</span>
                  <div className="mt-1 text-[11px] text-white/35">
                    Take a screenshot (⌘H) or select an area (⇧⌘H) for auto-analysis
                  </div>
                </div>
              ) : (
                chatMessages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[85%] px-2.5 py-1.5 rounded text-xs leading-relaxed ${
                        msg.role === "user"
                          ? "bg-white/15 text-white/95"
                          : "bg-white/5 text-white/85 border border-white/10"
                      }`}
                      style={{ wordBreak: "break-word" }}
                    >
                      {msg.text}
                    </div>
                  </div>
                ))
              )}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-white/5 border border-white/10 px-2.5 py-1.5 rounded text-xs text-white/60">
                    <span className="animate-pulse">{currentModel.model} is replying…</span>
                  </div>
                </div>
              )}
            </div>
            <form
              className="flex gap-2 items-center"
              onSubmit={e => {
                e.preventDefault()
                handleChatSend()
              }}
            >
              <input
                ref={chatInputRef}
                className="flex-1 px-2.5 py-1.5 rounded bg-white/5 border border-white/10 text-xs text-white/95 placeholder-white/40 focus:outline-none focus:border-white/25"
                placeholder="Type your message…"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                disabled={chatLoading}
              />
              <button
                type="submit"
                className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 disabled:opacity-40 text-xs text-white/90 transition-colors"
                disabled={chatLoading || !chatInput.trim()}
                aria-label="Send"
              >
                Send
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}

export default Queue
