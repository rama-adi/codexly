import React from "react"
import {
  CheckCircle2,
  CircleDotDashed,
  Code2,
  FileDiff,
  Image,
  MessageSquareText,
  Search,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react"

import MarkdownMessage from "@/components/MarkdownMessage"
import { cn } from "@/lib/utils"

type AssistantTranscriptProps = {
  markdown: string
  streaming?: boolean
  className?: string
  compact?: boolean
}

type MarkdownSegment = {
  type: "markdown"
  content: string
}

type ToolSegment = {
  type: "tool"
  title: string
  detail?: string
  status: "running" | "complete" | "failed" | "info"
  icon: "search" | "terminal" | "file" | "tool" | "image" | "message" | "code"
  outputs: string[]
}

type Segment = MarkdownSegment | ToolSegment

const statusLinePattern = /^_([^_\n]+)_$/
const fencedBlockPattern = /^```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```$/

function stripInlineCode(value: string): string {
  return value.replace(/`([^`]+)`/g, "$1").trim()
}

function classifyStatus(raw: string): Omit<ToolSegment, "type" | "outputs"> | null {
  const text = stripInlineCode(raw.replace(/\.\s*$/, ""))
  const lower = text.toLowerCase()

  if (lower.startsWith("searching the web")) {
    return { title: text, status: "running", icon: "search" }
  }
  if (lower.startsWith("finished web search")) {
    return { title: text, status: "complete", icon: "search" }
  }
  if (lower.startsWith("running command:")) {
    return {
      title: "Running command",
      detail: text.replace(/^Running command:\s*/i, ""),
      status: "running",
      icon: "terminal",
    }
  }
  if (lower.startsWith("command exited") || lower.startsWith("command ")) {
    return { title: text, status: lower.includes("code 0") ? "complete" : "info", icon: "terminal" }
  }
  if (lower.startsWith("applying file changes")) {
    return { title: text, status: "running", icon: "file" }
  }
  if (lower.startsWith("file changes complete")) {
    return { title: text, status: "complete", icon: "file" }
  }
  if (lower.startsWith("using ")) {
    return { title: text, status: "running", icon: "tool" }
  }
  if (lower.startsWith("tool failed")) {
    return { title: text, status: "failed", icon: "tool" }
  }
  if (lower.startsWith("tool call complete")) {
    return { title: text, status: "complete", icon: "tool" }
  }
  if (lower.startsWith("starting collaboration tool") || lower.startsWith("collaboration tool")) {
    return { title: text, status: lower.startsWith("starting") ? "running" : "complete", icon: "message" }
  }
  if (lower.startsWith("viewing image") || lower.startsWith("image viewed")) {
    return { title: text, status: lower.startsWith("image viewed") ? "complete" : "running", icon: "image" }
  }
  if (lower.startsWith("starting review") || lower.startsWith("review started") || lower.startsWith("review finished")) {
    return { title: text, status: lower.includes("finished") ? "complete" : "info", icon: "message" }
  }
  if (lower.startsWith("compacting conversation context") || lower.startsWith("conversation context compacted")) {
    return { title: text, status: lower.includes("compacted") ? "complete" : "running", icon: "code" }
  }

  return null
}

function splitMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = []
  const lines = markdown.split("\n")
  let buffer: string[] = []
  let inFence = false

  const flush = () => {
    const block = buffer.join("\n").trim()
    if (block) blocks.push(block)
    buffer = []
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      buffer.push(line)
      inFence = !inFence
      if (!inFence) flush()
      continue
    }

    if (!inFence && line.trim() === "") {
      flush()
      continue
    }

    buffer.push(line)
  }

  flush()
  return blocks
}

function parseTranscript(markdown: string): Segment[] {
  const segments: Segment[] = []
  let activeTool: ToolSegment | null = null

  const pushMarkdown = (content: string) => {
    if (!content.trim()) return
    activeTool = null
    const previous = segments.at(-1)
    if (previous?.type === "markdown") {
      previous.content = `${previous.content}\n\n${content.trim()}`
      return
    }
    segments.push({ type: "markdown", content: content.trim() })
  }

  const pushTool = (tool: Omit<ToolSegment, "type" | "outputs">) => {
    const completeOrFailed = tool.status === "complete" || tool.status === "failed"
    if (activeTool && activeTool.icon === tool.icon && completeOrFailed) {
      activeTool.status = tool.status
      activeTool.title = tool.title
      activeTool.detail = tool.detail ?? activeTool.detail
      return
    }

    activeTool = { type: "tool", outputs: [], ...tool }
    segments.push(activeTool)
  }

  for (const block of splitMarkdownBlocks(markdown)) {
    const fenced = fencedBlockPattern.exec(block)
    if (fenced && activeTool) {
      ;(activeTool as ToolSegment).outputs.push(fenced[2].trim())
      continue
    }

    const statusMatch = statusLinePattern.exec(block)
    const tool = statusMatch ? classifyStatus(statusMatch[1]) : null
    if (tool) {
      pushTool(tool)
      continue
    }

    pushMarkdown(block)
  }

  return segments
}

function ToolIcon({ icon, status }: { icon: ToolSegment["icon"]; status: ToolSegment["status"] }) {
  if (status === "complete") return <CheckCircle2 className="size-3.5" />
  if (status === "failed") return <XCircle className="size-3.5" />
  if (icon === "search") return <Search className="size-3.5" />
  if (icon === "terminal") return <Terminal className="size-3.5" />
  if (icon === "file") return <FileDiff className="size-3.5" />
  if (icon === "image") return <Image className="size-3.5" />
  if (icon === "message") return <MessageSquareText className="size-3.5" />
  if (icon === "code") return <Code2 className="size-3.5" />
  return <Wrench className="size-3.5" />
}

function ToolCallCard({ segment, compact = false }: { segment: ToolSegment; compact?: boolean }) {
  const tone =
    segment.status === "failed"
      ? "border-red-500/25 bg-red-500/[0.06] text-red-700 dark:text-red-200"
      : segment.status === "complete"
        ? "border-emerald-500/20 bg-emerald-500/[0.055] text-emerald-800 dark:text-emerald-200"
        : "border-border bg-muted/45 text-muted-foreground"

  return (
    <div className={cn("overflow-hidden rounded-md border", tone)}>
      <div className={cn("flex items-start gap-2", compact ? "px-2 py-1.5" : "px-3 py-2")}>
        <div className="mt-0.5 shrink-0">
          <ToolIcon icon={segment.icon} status={segment.status} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn("font-medium leading-snug", compact ? "text-[11px]" : "text-xs")}>
            {segment.title}
          </div>
          {segment.detail && (
            <div className={cn("mt-0.5 truncate font-mono opacity-75", compact ? "text-[10px]" : "text-[11px]")}>
              {segment.detail}
            </div>
          )}
        </div>
        {segment.status === "running" && (
          <CircleDotDashed className="mt-0.5 size-3.5 shrink-0 animate-spin opacity-70" />
        )}
      </div>
      {segment.outputs.map((output, index) => (
        <pre
          key={index}
          className={cn(
            "max-h-56 overflow-auto border-t border-current/10 bg-black/80 p-2 font-mono text-gray-100",
            compact ? "text-[10px] leading-relaxed" : "text-xs leading-relaxed",
          )}
        >
          {output}
        </pre>
      ))}
    </div>
  )
}

export const AssistantTranscript: React.FC<AssistantTranscriptProps> = ({
  markdown,
  streaming = false,
  className = "",
  compact = false,
}) => {
  const segments = React.useMemo(() => parseTranscript(markdown), [markdown])

  if (!segments.length) {
    return <MarkdownMessage markdown={markdown} streaming={streaming} className={className} />
  }

  return (
    <div className={cn("space-y-3", className)}>
      {segments.map((segment, index) =>
        segment.type === "tool" ? (
          <ToolCallCard key={`${segment.title}-${index}`} segment={segment} compact={compact} />
        ) : (
          <MarkdownMessage
            key={`markdown-${index}`}
            markdown={segment.content}
            streaming={streaming && index === segments.length - 1}
          />
        ),
      )}
    </div>
  )
}

export default AssistantTranscript
