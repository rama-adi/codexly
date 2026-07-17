import React from "react"
import { Streamdown } from "streamdown"

type MarkdownMessageProps = {
  markdown: string
  streaming?: boolean
  className?: string
}

const components = {
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="whitespace-pre-wrap" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="list-disc space-y-1 pl-5" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className="list-decimal space-y-1 pl-5" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className="pl-0.5" {...props}>
      {children}
    </li>
  ),
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className="text-lg font-semibold leading-snug" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className="text-base font-semibold leading-snug" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="text-sm font-semibold leading-snug" {...props}>
      {children}
    </h3>
  ),
  code: ({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <code
      className={`rounded bg-current/10 px-1 py-0.5 font-mono text-[0.92em] ${className ?? ""}`}
      {...props}
    >
      {children}
    </code>
  ),
  pre: ({ children, className, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className={`overflow-x-auto rounded-md border border-current/10 bg-black/70 p-3 font-mono text-xs text-gray-100 ${className ?? ""}`}
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="border-l-2 border-current/25 pl-3 opacity-90" {...props}>
      {children}
    </blockquote>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-xs" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="border border-current/15 px-2 py-1 font-semibold" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border border-current/15 px-2 py-1 align-top" {...props}>
      {children}
    </td>
  ),
}

export const MarkdownMessage: React.FC<MarkdownMessageProps> = ({
  markdown,
  streaming = false,
  className = "",
}) => {
  if (!markdown && streaming) {
    return (
      <p className="animate-pulse bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-xs text-transparent">
        Generating answer...
      </p>
    )
  }

  return (
    <Streamdown
      className={`space-y-3 break-words ${className}`}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      controls={false}
      components={components}
    >
      {markdown}
    </Streamdown>
  )
}

export default MarkdownMessage
