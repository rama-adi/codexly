import React, { useState, useEffect, useRef } from "react"
import { useQuery } from "react-query"
import ScreenshotQueue from "@/components/Queue/ScreenshotQueue"
import { Trash2 } from "lucide-react"
import MarkdownMessage from "@/components/MarkdownMessage"
import {
  Toast,
  ToastTitle,
  ToastDescription,
  ToastVariant,
  ToastMessage
} from "@/components/ui/toast"
import QueueCommands from "@/components/Queue/QueueCommands"
import type { ChatSession } from "@/types/electron"

interface QueueProps {
  setView: React.Dispatch<
    React.SetStateAction<"queue" | "solutions" | "home" | "settings">
  >
}

const Queue: React.FC<QueueProps> = ({ setView }) => {
  const [toastOpen, setToastOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<ToastMessage>({
    title: "",
    description: "",
    variant: "neutral"
  })

  const contentRef = useRef<HTMLDivElement>(null)

  const [chatInput, setChatInput] = useState("")
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null)
  const [chatLoading, setChatLoading] = useState(false)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const chatInputRef = useRef<HTMLInputElement>(null)
  
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
    const message = chatInput
    setChatLoading(true)
    setChatInput("")
    try {
      await window.electronAPI.chat(message)
      setActiveSession(await window.electronAPI.getActiveChatSession())
    } catch (err) {
      setActiveSession(current =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: `error-${Date.now()}`,
                  role: "assistant",
                  content: "Error: " + String(err),
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : current
      )
    } finally {
      setChatLoading(false)
      chatInputRef.current?.focus()
    }
  }

  const clearChat = async () => {
    await window.electronAPI.clearChatHistory()
    setActiveSession(await window.electronAPI.getActiveChatSession())
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

    const unsubscribe = window.electronAPI.onLlmConfigChanged((config) => {
      setCurrentModel({ provider: config.provider, model: config.model });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    window.electronAPI.getActiveChatSession().then(setActiveSession).catch(() => undefined)
    return window.electronAPI.onHistoryChanged(() => {
      window.electronAPI.getActiveChatSession().then(setActiveSession).catch(() => undefined)
    })
  }, [])

  useEffect(() => {
    const updateDimensions = () => {
      if (contentRef.current) {
        const contentHeight = contentRef.current.scrollHeight
        const contentWidth = contentRef.current.scrollWidth
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
      window.electronAPI.onResetView(() => {
        setActiveSession(null)
        refetch()
      }),
      window.electronAPI.onSolutionStreamError((error: string) => {
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
  }, [])

  const handleChatToggle = () => {
    setIsChatOpen(open => {
      const next = !open
      if (next) requestAnimationFrame(() => chatInputRef.current?.focus())
      return next
    })
  }

  const chatMessages = activeSession?.messages ?? []

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
      <div className="px-2 py-2 space-y-1.5 w-fit" data-clickable-root>
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
          screenshots={isChatOpen ? [] : screenshots}
          onChatToggle={handleChatToggle}
          onSettingsOpen={() => window.electronAPI.openSettingsWindow()}
        />

        {!isChatOpen && screenshots.length > 0 && (
          <div className="w-fit rounded-lg border border-white/10 bg-black/60 p-1.5">
            <ScreenshotQueue
              isLoading={false}
              screenshots={screenshots}
              onDeleteScreenshot={handleDeleteScreenshot}
            />
          </div>
        )}

        {isChatOpen && (
          <div className="w-96 rounded-lg bg-black/60 border border-white/10 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-xs font-medium text-white/70">
                {currentModel.model}
              </div>
              <button
                type="button"
                onClick={clearChat}
                disabled={chatLoading || chatMessages.length === 0}
                className="inline-flex h-7 w-7 items-center justify-center rounded bg-white/5 text-white/60 transition-colors hover:bg-white/10 hover:text-white/85 disabled:cursor-default disabled:opacity-35"
                title="Clear chat"
                aria-label="Clear chat"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto max-h-64 min-h-[120px] rounded bg-black/30 border border-white/5 p-2 space-y-2">
              {chatMessages.length === 0 ? (
                <div className="text-xs text-white/50 text-center py-6">
                  Chat with <span className="font-mono text-white/70">{currentModel.model}</span>
                  <div className="mt-1 text-[11px] text-white/35">
                    Take screenshots, then press ⌘↵ to solve.
                  </div>
                </div>
              ) : (
                chatMessages.map(msg => {
                  const messageScreenshots =
                    msg.screenshots ??
                    msg.screenshotDataUrls?.map((dataUrl, index) => ({
                      path: msg.screenshotPaths?.[index] ?? `${msg.id}-${index}`,
                      dataUrl,
                    })) ??
                    []

                  return (
                    <div
                      key={msg.id}
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
                        {messageScreenshots.length > 0 && (
                          <div className="mb-2 grid grid-cols-2 gap-1.5">
                            {messageScreenshots.map(screenshot => (
                              <img
                                key={screenshot.path}
                                src={screenshot.dataUrl}
                                alt="Screenshot"
                                className="max-h-24 rounded border border-white/10 object-cover"
                              />
                            ))}
                          </div>
                        )}
                        <MarkdownMessage markdown={msg.content} className="space-y-2" />
                      </div>
                    </div>
                  )
                })
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
