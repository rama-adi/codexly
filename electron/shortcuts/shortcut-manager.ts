import { logger } from '../shared/logger'

const log = logger.child('shortcuts')

export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export type ShortcutCallback = () => void | Promise<void>

export interface ShortcutDefinition {
  accelerator: string
  callback: ShortcutCallback
  /**
   * Serialized preserves repeated presses in order, single-flight drops key
   * repeat while work is active, and immediate is intended for cancellation.
   */
  dispatch?: 'serialized' | 'single-flight' | 'immediate'
}

export type ShortcutDefinitions = Readonly<Record<string, ShortcutDefinition>>

export interface ShortcutRegistrationStatus {
  accelerator: string
  registered: boolean
  conflicted: boolean
  /** Present when Electron threw instead of returning a registration result. */
  error?: string
}

export interface ShortcutManagerError {
  phase: 'register' | 'unregister' | 'callback'
  action: string
  accelerator: string
  error: unknown
}

export interface ShortcutManagerOptions {
  adapter: GlobalShortcutAdapter
  shortcuts?: ShortcutDefinitions
  /** Observes native and callback failures without allowing them to break dispatch. */
  onError?: (failure: ShortcutManagerError) => void
}

interface ShortcutRegistration {
  accelerator: string
  id: number
  dispatchQueue: Promise<void>
  running: boolean
}

/**
 * Owns the global shortcuts it successfully registers. It deliberately never
 * calls unregisterAll(), because other parts of the process may own shortcuts.
 */
export class ShortcutManager {
  private readonly adapter: GlobalShortcutAdapter
  private readonly onError?: ShortcutManagerOptions['onError']
  private readonly registrations = new Map<string, ShortcutRegistration>()
  private readonly statuses = new Map<string, ShortcutRegistrationStatus>()
  private nextRegistrationId = 0
  private disposed = false

  constructor({ adapter, shortcuts = {}, onError }: ShortcutManagerOptions) {
    this.adapter = adapter
    this.onError = onError
    this.configure(shortcuts)
  }

  configure(shortcuts: ShortcutDefinitions): void {
    if (this.disposed) {
      return
    }

    this.unregisterOwned()
    this.statuses.clear()

    const accelerators = new Set<string>()
    for (const [action, shortcut] of Object.entries(shortcuts)) {
      if (accelerators.has(shortcut.accelerator)) {
        this.statuses.set(action, {
          accelerator: shortcut.accelerator,
          registered: false,
          conflicted: true,
        })
        continue
      }

      accelerators.add(shortcut.accelerator)
      const registration: ShortcutRegistration = {
        accelerator: shortcut.accelerator,
        id: this.nextRegistrationId,
        dispatchQueue: Promise.resolve(),
        running: false,
      }
      this.nextRegistrationId += 1
      let registered = false
      let registrationError: unknown
      try {
        registered = this.adapter.register(shortcut.accelerator, () => {
          this.dispatch(
            action,
            registration,
            shortcut.callback,
            shortcut.dispatch ?? 'serialized',
          )
        })
      } catch (error) {
        registrationError = error
        this.reportError({
          phase: 'register',
          action,
          accelerator: shortcut.accelerator,
          error,
        })
      }

      this.statuses.set(action, {
        accelerator: shortcut.accelerator,
        registered,
        conflicted: !registered,
        ...(registrationError === undefined
          ? {}
          : { error: errorMessage(registrationError) }),
      })
      if (registered) {
        this.registrations.set(action, registration)
      }
    }
  }

  getStatus(action: string): ShortcutRegistrationStatus | undefined {
    const status = this.statuses.get(action)
    return status ? { ...status } : undefined
  }

  getStatuses(): Readonly<Record<string, ShortcutRegistrationStatus>> {
    const statuses: Record<string, ShortcutRegistrationStatus> = {}
    for (const [action, status] of this.statuses) {
      statuses[action] = { ...status }
    }
    return statuses
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.unregisterOwned()
    this.statuses.clear()
  }

  cleanup(): void {
    this.dispose()
  }

  private dispatch(
    action: string,
    registration: ShortcutRegistration,
    callback: ShortcutCallback,
    mode: 'serialized' | 'single-flight' | 'immediate',
  ): void {
    if (this.disposed || this.registrations.get(action)?.id !== registration.id) {
      return
    }
    log.debug('shortcut fired', {
      action,
      accelerator: registration.accelerator,
      mode,
      running: registration.running,
    })

    const invoke = async (): Promise<void> => {
      if (this.disposed || this.registrations.get(action)?.id !== registration.id) {
        return
      }
      await callback()
    }
    if (mode === 'immediate') {
      void invoke().catch((error) => {
        this.reportError({
          phase: 'callback',
          action,
          accelerator: registration.accelerator,
          error,
        })
      })
      return
    }
    if (mode === 'single-flight') {
      if (registration.running) {
        // Not an error — key repeat and impatient re-presses land here — but it
        // is the reason a shortcut can look like it did nothing at all.
        log.info('shortcut press dropped; the previous run is still active', {
          action,
          accelerator: registration.accelerator,
        })
        return
      }
      registration.running = true
      void invoke()
        .catch((error) => {
          this.reportError({
            phase: 'callback',
            action,
            accelerator: registration.accelerator,
            error,
          })
        })
        .finally(() => {
          registration.running = false
        })
      return
    }
    // Serialize repeated invocations of one action, without letting a slow
    // action block unrelated global shortcuts.
    registration.dispatchQueue = registration.dispatchQueue
      .then(invoke, invoke)
      .catch((error) => {
        this.reportError({
          phase: 'callback',
          action,
          accelerator: registration.accelerator,
          error,
        })
      })
  }

  private unregisterOwned(): void {
    const owned = [...this.registrations.entries()]
    // Invalidate native callbacks before unregistering. Some adapters can
    // still deliver a callback that was already queued by the operating system.
    this.registrations.clear()
    for (const [action, registration] of owned) {
      try {
        this.adapter.unregister(registration.accelerator)
      } catch (error) {
        this.reportError({
          phase: 'unregister',
          action,
          accelerator: registration.accelerator,
          error,
        })
      }
    }
  }

  private reportError(failure: ShortcutManagerError): void {
    try {
      this.onError?.(failure)
    } catch (observerError) {
      // Invariant: the observer is purely diagnostic (it publishes a
      // shortcut.error event) and cannot control shortcut dispatch, so a broken
      // observer must not mask the failure being reported. Logged rather than
      // silent so a throwing observer is still debuggable.
      log.warn('shortcut error observer threw', {
        action: failure.action,
        phase: failure.phase,
        reportedError: errorMessage(failure.error),
        observerError: errorMessage(observerError),
      })
    }
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
