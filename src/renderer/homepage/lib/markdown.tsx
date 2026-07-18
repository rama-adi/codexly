import * as React from 'react'

/**
 * Minimal, dependency-free markdown renderer. Handles the subset that appears
 * in assistant transcripts: headings, unordered/ordered lists, fenced code
 * blocks, inline code, bold and italic. Anything unrecognised renders as
 * pre-wrapped text so nothing is ever lost.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const blocks = React.useMemo(() => parseBlocks(text), [text])
  return (
    <div className="hp-markdown space-y-2 text-sm leading-relaxed">
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  )
}

type Block =
  | { kind: 'code'; content: string }
  | { kind: 'heading'; level: number; content: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'p'; content: string }

function parseBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim().startsWith('```')) {
      const buffer: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buffer.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push({ kind: 'code', content: buffer.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        content: heading[2],
      })
      i += 1
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i += 1
      }
      blocks.push({ kind: 'ul', items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i += 1
      }
      blocks.push({ kind: 'ol', items })
      continue
    }

    if (line.trim() === '') {
      i += 1
      continue
    }

    const paragraph: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push({ kind: 'p', content: paragraph.join('\n') })
  }

  return blocks
}

function renderBlock(block: Block, key: number): React.ReactElement {
  switch (block.kind) {
    case 'code':
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-lg border border-border bg-muted/60 p-3 font-mono text-xs leading-relaxed text-foreground"
        >
          <code>{block.content}</code>
        </pre>
      )
    case 'heading': {
      const size =
        block.level <= 1
          ? 'text-base'
          : block.level === 2
            ? 'text-sm'
            : 'text-sm'
      return (
        <p key={key} className={`font-semibold text-foreground ${size}`}>
          {renderInline(block.content)}
        </p>
      )
    }
    case 'ul':
      return (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={key} className="list-decimal space-y-1 pl-5">
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ol>
      )
    default:
      return (
        <p key={key} className="whitespace-pre-wrap">
          {renderInline(block.content)}
        </p>
      )
  }
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g

function renderInline(text: string): React.ReactNode {
  const parts = text.split(INLINE)
  return parts.map((part, index) => {
    if (!part) return null
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={index}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (
      (part.startsWith('*') && part.endsWith('*')) ||
      (part.startsWith('_') && part.endsWith('_'))
    ) {
      return <em key={index}>{part.slice(1, -1)}</em>
    }
    return <React.Fragment key={index}>{part}</React.Fragment>
  })
}
