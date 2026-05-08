import React from "react"

type MarkdownMessageProps = {
  markdown: string
  streaming?: boolean
  className?: string
}

function inlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith("`")) {
      nodes.push(
        <code key={`${match.index}-code`} className="rounded bg-current/10 px-1 py-0.5 font-mono text-[0.92em]">
          {token.slice(1, -1)}
        </code>
      )
    } else {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>)
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

export const MarkdownMessage: React.FC<MarkdownMessageProps> = ({
  markdown,
  streaming = false,
  className = "",
}) => {
  if (!markdown && streaming) {
    return (
      <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
        Generating answer...
      </p>
    )
  }

  const parts = markdown.split(/(```[\s\S]*?```)/g).filter(Boolean)

  return (
    <div className={`space-y-3 break-words ${className}`}>
      {parts.map((part, partIndex) => {
        const codeMatch = part.match(/^```([\w-]+)?\n?([\s\S]*?)```$/)
        if (codeMatch) {
          return (
            <pre
              key={partIndex}
              className="overflow-x-auto rounded-md border border-current/10 bg-black/70 p-3 font-mono text-xs text-gray-100"
            >
              <code>{codeMatch[2]}</code>
            </pre>
          )
        }

        const blocks = part.split(/\n{2,}/).filter(Boolean)
        return blocks.map((block, blockIndex) => {
          const key = `${partIndex}-${blockIndex}`
          const lines = block.split("\n")
          const heading = block.match(/^(#{1,3})\s+(.+)$/)
          if (heading) {
            const Tag = `h${Math.min(heading[1].length + 2, 5)}` as keyof JSX.IntrinsicElements
            return <Tag key={key} className="font-semibold leading-snug">{inlineMarkdown(heading[2])}</Tag>
          }

          if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
            return (
              <ul key={key} className="list-disc space-y-1 pl-5">
                {lines.map((line, index) => (
                  <li key={index}>{inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</li>
                ))}
              </ul>
            )
          }

          if (lines.every(line => /^\s*\d+\.\s+/.test(line))) {
            return (
              <ol key={key} className="list-decimal space-y-1 pl-5">
                {lines.map((line, index) => (
                  <li key={index}>{inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ""))}</li>
                ))}
              </ol>
            )
          }

          return (
            <p key={key} className="whitespace-pre-wrap">
              {inlineMarkdown(block)}
            </p>
          )
        })
      })}
      {streaming && <span className="inline-block h-3 w-1 animate-pulse bg-current/70" />}
    </div>
  )
}

export default MarkdownMessage
