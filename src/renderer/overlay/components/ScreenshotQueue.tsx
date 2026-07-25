import { X } from 'lucide-react'

import type { Attachment } from '../types'

export function ScreenshotQueue({
  attachments,
  onDiscard,
}: {
  attachments: Attachment[]
  onDiscard(id: string): void
}) {
  if (!attachments.length) return null

  return (
    <div className="mt-1.5 flex w-max max-w-[650px] animate-hud-rise gap-1.5 overflow-x-auto rounded-hud border border-hud-line bg-hud-bg p-1.5 shadow-hud backdrop-blur-[24px]">
      {attachments.map((attachment, index) => (
        <figure
          key={attachment.id}
          className="group relative m-0 h-[70px] flex-[0_0_108px] animate-hud-fade overflow-hidden rounded-lg border border-hud-line bg-white/3 transition-[border-color,transform] duration-150 [animation-fill-mode:backwards] hover:-translate-y-px hover:border-hud-line-strong"
          style={{ animationDelay: `${index * 30}ms` }}
        >
          <img
            className="block size-full object-cover"
            src={attachment.preview}
            alt={`Screenshot ${index + 1}`}
          />
          <button
            className="absolute right-[3px] top-[3px] grid size-[18px] place-items-center rounded-[5px] border-0 bg-black/55 text-white opacity-0 transition-[opacity,background-color] duration-100 hover:bg-hud-danger focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={`Remove screenshot ${index + 1}`}
            onClick={() => onDiscard(attachment.id)}
          >
            <X size={11} />
          </button>
        </figure>
      ))}
    </div>
  )
}
