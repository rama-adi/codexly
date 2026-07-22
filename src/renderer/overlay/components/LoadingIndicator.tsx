import { LoaderCircle } from 'lucide-react'

export function LoadingIndicator({ label }: { label: string }) {
  return (
    <span className="ov-loading" role="status" aria-live="polite">
      <LoaderCircle className="ov-spin" aria-hidden />
      <span>{label}</span>
    </span>
  )
}

