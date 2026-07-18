/**
 * Detects macOS so the custom titlebar can reserve room for the inset traffic
 * lights (macOS) versus the Windows/Linux titleBarOverlay window controls.
 * SSR-safe: returns false when navigator is unavailable.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaPlatform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? ''
  const source = `${uaPlatform} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return /mac|iphone|ipad|ipod/i.test(source)
}
