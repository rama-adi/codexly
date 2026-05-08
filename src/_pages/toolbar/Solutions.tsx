import React, { useEffect, useRef, useState } from "react"
import { Copy, X } from "lucide-react"

import QueueCommands from "@/components/Queue/QueueCommands"
import ScreenshotQueue from "@/components/Queue/ScreenshotQueue"
import MarkdownMessage from "@/components/MarkdownMessage"
import {
  Toast,
  ToastDescription,
  ToastMessage,
  ToastTitle,
  ToastVariant
} from "@/components/ui/toast"

type ScreenshotPreview = {
  path: string
  preview: string
}

interface SolutionsProps {
  setView: React.Dispatch<
    React.SetStateAction<"queue" | "solutions" | "home" | "settings">
  >
}

export const ContentSection: React.FC<{
  title: string
  content: React.ReactNode
  isLoading: boolean
}> = ({ title, content, isLoading }) => (
  <section className="rounded-md border border-white/10 bg-black/30 p-3 text-white/85">
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
      {title}
    </h3>
    {isLoading ? (
      <div className="text-xs text-white/45">Loading...</div>
    ) : (
      <div className="text-xs leading-relaxed">{content}</div>
    )}
  </section>
)

export const ComplexitySection: React.FC<{
  timeComplexity: string | null
  spaceComplexity: string | null
  isLoading: boolean
}> = ({ timeComplexity, spaceComplexity, isLoading }) => (
  <ContentSection
    title="Complexity"
    isLoading={isLoading}
    content={
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-white/10 bg-white/5 px-2 py-1.5">
          <div className="text-[11px] text-white/45">Time</div>
          <div className="font-mono text-xs">{timeComplexity}</div>
        </div>
        <div className="rounded border border-white/10 bg-white/5 px-2 py-1.5">
          <div className="text-[11px] text-white/45">Space</div>
          <div className="font-mono text-xs">{spaceComplexity}</div>
        </div>
      </div>
    }
  />
)

const Solutions: React.FC<SolutionsProps> = ({ setView }) => {
  const contentRef = useRef<HTMLDivElement>(null)
  const [answer, setAnswer] = useState("")
  const [streaming, setStreaming] = useState(true)
  const [answerHeight, setAnswerHeight] = useState(600)
  const [isPreview, setIsPreview] = useState(false)
  const [screenshots, setScreenshots] = useState<ScreenshotPreview[]>([])
  const [toastOpen, setToastOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<ToastMessage>({
    title: "",
    description: "",
    variant: "neutral"
  })

  const showToast = (title: string, description: string, variant: ToastVariant) => {
    setToastMessage({ title, description, variant })
    setToastOpen(true)
  }

  useEffect(() => {
    window.electronAPI.getAppSettings().then(settings => {
      setAnswerHeight(settings.answerHeight)
    })
    window.electronAPI.getScreenshots().then(setScreenshots).catch(() => undefined)

    const cleanup = [
      window.electronAPI.onAppSettingsChanged(settings => {
        setAnswerHeight(settings.answerHeight)
      }),
      window.electronAPI.onScreenshotTaken(() => {
        window.electronAPI.getScreenshots().then(setScreenshots).catch(() => undefined)
      }),
      window.electronAPI.onShowAnswerPreview(() => {
        setIsPreview(true)
        setStreaming(false)
        setAnswer(
          "This is a preview of the streamed markdown answer panel.\n\n```ts\nconst ready = true\n```\n\nAdjust the answer height in Settings."
        )
      }),
      window.electronAPI.onSolutionStreamStart(() => {
        setIsPreview(false)
        setStreaming(true)
        setAnswer("")
      }),
      window.electronAPI.onSolutionStreamDelta(delta => {
        setAnswer(current => current + delta)
      }),
      window.electronAPI.onSolutionStreamComplete(data => {
        setStreaming(false)
        setAnswer(current => current || data.answer)
      }),
      window.electronAPI.onSolutionStreamError(error => {
        setStreaming(false)
        showToast("Processing Failed", error, "error")
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast("No Screenshots", "There are no screenshots to process.", "neutral")
      }),
      window.electronAPI.onResetView(() => {
        setIsPreview(false)
        setAnswer("")
        setStreaming(false)
      })
    ]

    return () => cleanup.forEach(fn => fn())
  }, [])

  useEffect(() => {
    if (!contentRef.current) return
    window.electronAPI.updateContentDimensions({
      width: contentRef.current.scrollWidth,
      height: contentRef.current.scrollHeight
    })
  }, [answer, streaming, answerHeight])

  const closeAnswer = async () => {
    setAnswer("")
    setStreaming(false)
    setIsPreview(false)
    setScreenshots([])
    await window.electronAPI.clearScreenshots()
    setView("queue")
  }

  const copyAnswer = async () => {
    if (!answer) return
    await navigator.clipboard.writeText(answer)
    showToast("Copied", "Answer copied to clipboard.", "neutral")
  }

  return (
    <div ref={contentRef} className="relative space-y-2 px-3 py-2" data-clickable-root>
      <Toast open={toastOpen} onOpenChange={setToastOpen} variant={toastMessage.variant} duration={3000}>
        <ToastTitle>{toastMessage.title}</ToastTitle>
        <ToastDescription>{toastMessage.description}</ToastDescription>
      </Toast>

      <QueueCommands
        screenshots={[]}
        onTooltipVisibilityChange={() => undefined}
        onSettingsOpen={() => window.electronAPI.openSettingsWindow()}
      />

      {screenshots.length > 0 && (
        <div className="w-fit rounded-md border border-white/10 bg-black/60 p-1.5">
          <ScreenshotQueue
            isLoading={streaming}
            screenshots={screenshots}
            onDeleteScreenshot={async index => {
              const target = screenshots[index]
              if (!target) return
              await window.electronAPI.deleteScreenshot(target.path)
              setScreenshots(current => current.filter((_, itemIndex) => itemIndex !== index))
            }}
          />
        </div>
      )}

      <div className="relative w-full">
        <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
          <button
            type="button"
            aria-label="Copy answer"
            onClick={copyAnswer}
            className="flex h-6 w-6 items-center justify-center rounded-md bg-black/40 text-white/80 transition-colors hover:bg-black/60 hover:text-white"
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label="Close answer"
            onClick={closeAnswer}
            className="flex h-6 w-6 items-center justify-center rounded-md bg-black/40 text-white/80 transition-colors hover:bg-black/60 hover:text-white"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
        <div
          className="w-full overflow-y-auto rounded-md border border-white/10 bg-black/70 px-3 py-3 pr-14"
          style={isPreview ? { height: `${answerHeight}px` } : { maxHeight: `${answerHeight}px` }}
        >
          <MarkdownMessage
            markdown={answer}
            streaming={streaming}
            className="text-[13px] leading-relaxed text-gray-100"
          />
        </div>
      </div>
    </div>
  )
}

export default Solutions
