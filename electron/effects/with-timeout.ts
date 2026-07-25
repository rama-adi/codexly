/**
 * Races `operation` against a timer. When the timer wins, `onTimeout` decides
 * the outcome: it can return a fallback value or throw a tagged error.
 *
 * The timer is always cleared, so a resolved race never keeps the event loop
 * alive. The operation itself is not cancelled — callers that need cancellation
 * pass an abort signal to the operation and abort it from `onTimeout`.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T | Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            resolve(onTimeout())
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
