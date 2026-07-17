// src/components/ScreenshotItem.tsx
import React from "react"
import { X } from "lucide-react"

interface Screenshot {
  path: string
  preview: string
}

interface ScreenshotItemProps {
  screenshot: Screenshot
  onDelete: (index: number) => void
  index: number
  isLoading: boolean
}

const ScreenshotItem: React.FC<ScreenshotItemProps> = ({
  screenshot,
  onDelete,
  index,
  isLoading
}) => {
  const handleDelete = async () => {
    await onDelete(index)
  }

  return (
    <>
      <div
        className={`relative h-14 w-20 shrink-0 overflow-hidden rounded border border-white/10 bg-white/5 ${isLoading ? "" : "group"}`}
      >
        <div className="w-full h-full relative">
          {isLoading && (
            <div className="absolute inset-0 bg-black bg-opacity-50 z-10 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          <img
            src={screenshot.preview}
            alt="Screenshot"
            className={`w-full h-full object-cover transition-transform duration-300 ${
              isLoading
                ? "opacity-50"
                : "cursor-pointer group-hover:scale-105 group-hover:brightness-75"
            }`}
          />
        </div>
        {!isLoading && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleDelete()
            }}
            className="absolute left-1 top-1 rounded bg-black/70 p-1 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100"
            aria-label="Delete screenshot"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </>
  )
}

export default ScreenshotItem
