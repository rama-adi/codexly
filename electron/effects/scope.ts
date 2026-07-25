import { logger, serializeErrorForLog } from '../shared/logger'

const log = logger.child('effects:scope')

export interface Scope {
  /** Registers a finalizer. Finalizers run in reverse registration order. */
  defer(finalizer: () => void | Promise<void>): void
  /** Runs every finalizer exactly once. Never rejects. */
  close(reason?: string): Promise<void>
  readonly closed: boolean
}

export interface ScopeOptions {
  /** Identifies the scope in finalizer-failure logs. */
  label?: string
  /** Overrides the default logging of a failed finalizer. */
  onFinalizerError?(error: unknown, context: { label?: string; reason?: string }): void
}

/**
 * A finalizer registry with exactly-once, reverse-order teardown.
 *
 * `close` is idempotent: concurrent and repeated calls all await the same run.
 * An individual finalizer that throws is collected and logged; teardown always
 * continues and `close` never rejects, so callers can put it in a `finally`.
 * A finalizer registered after `close` runs immediately for the same reason.
 */
export function createScope(options: ScopeOptions = {}): Scope {
  const finalizers: Array<() => void | Promise<void>> = []
  let closing: Promise<void> | null = null

  const reportError = (error: unknown, reason?: string): void => {
    if (options.onFinalizerError) {
      options.onFinalizerError(error, { ...(options.label ? { label: options.label } : {}), ...(reason ? { reason } : {}) })
      return
    }
    log.warn('scope finalizer failed', {
      label: options.label,
      reason,
      error: serializeErrorForLog(error),
    })
  }

  const run = async (reason?: string): Promise<void> => {
    while (finalizers.length > 0) {
      const finalizer = finalizers.pop()!
      try {
        await finalizer()
      } catch (error) {
        reportError(error, reason)
      }
    }
  }

  return {
    defer(finalizer) {
      if (closing) {
        // The scope is already torn down; running the finalizer now keeps the
        // "every registered finalizer runs exactly once" guarantee.
        void Promise.resolve()
          .then(finalizer)
          .catch((error: unknown) => reportError(error, 'deferred-after-close'))
        return
      }
      finalizers.push(finalizer)
    },
    close(reason) {
      closing ??= run(reason)
      return closing
    },
    get closed() {
      return closing !== null
    },
  }
}
