export const isDevBuild = import.meta.env.DEV

export function devLog(scope: string, message: string, details?: Record<string, unknown>): void {
  if (!isDevBuild) return
  const timestamp = new Date().toISOString()
  if (details) {
    console.log(`[dev:${scope}] ${timestamp} ${message}`, details)
    return
  }
  console.log(`[dev:${scope}] ${timestamp} ${message}`)
}

export function devMeasure(scope: string, label: string): (details?: Record<string, unknown>) => void {
  if (!isDevBuild) return () => undefined
  const start = performance.now()
  devLog(scope, `${label}: start`)
  return (details?: Record<string, unknown>) => {
    devLog(scope, `${label}: done`, {
      durationMs: Math.round(performance.now() - start),
      ...details,
    })
  }
}
