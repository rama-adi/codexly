import { LoaderCircle } from 'lucide-react'

export function LoadingIndicator({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-hud-dim"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle className="size-[13px] animate-hud-spin" aria-hidden />
      <span>{label}</span>
    </span>
  )
}

