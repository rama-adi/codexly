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
    <div className="ov-queue">
      {attachments.map((attachment, index) => (
        <figure key={attachment.id} className="ov-queue-item" style={{ animationDelay: `${index * 30}ms` }}>
          <img src={attachment.preview} alt={`Screenshot ${index + 1}`} />
          <button aria-label={`Remove screenshot ${index + 1}`} onClick={() => onDiscard(attachment.id)}>
            <X size={11} />
          </button>
        </figure>
      ))}
    </div>
  )
}
