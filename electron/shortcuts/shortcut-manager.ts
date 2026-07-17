export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export type ShortcutCallback = () => void | Promise<void>

export interface ShortcutDefinition {
  accelerator: string
  callback: ShortcutCallback
  /** Immediate dispatch is intended for cancellation actions that must interrupt a serialized action. */
  dispatch?: 'serialized' | 'immediate'
}

export type ShortcutDefinitions = Readonly<Record<string, ShortcutDefinition>>

export interface ShortcutRegistrationStatus {
  accelerator: string
  registered: boolean
  conflicted: boolean
}

export interface ShortcutManagerOptions {
  adapter: GlobalShortcutAdapter
  shortcuts?: ShortcutDefinitions
}

interface ShortcutRegistration {
  accelerator: string
  id: number
}

/**
 * Owns the global shortcuts it successfully registers. It deliberately never
 * calls unregisterAll(), because other parts of the process may own shortcuts.
 */
export class ShortcutManager {
  private readonly adapter: GlobalShortcutAdapter
  private readonly registrations = new Map<string, ShortcutRegistration>()
  private readonly statuses = new Map<string, ShortcutRegistrationStatus>()
  private dispatchQueue: Promise<void> = Promise.resolve()
  private nextRegistrationId = 0
  private disposed = false

  constructor({ adapter, shortcuts = {} }: ShortcutManagerOptions) {
    this.adapter = adapter
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
      }
      this.nextRegistrationId += 1
      const registered = this.adapter.register(shortcut.accelerator, () => {
        this.dispatch(
          action,
          registration,
          shortcut.callback,
          shortcut.dispatch ?? 'serialized',
        )
      })

      this.statuses.set(action, {
        accelerator: shortcut.accelerator,
        registered,
        conflicted: !registered,
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
    mode: 'serialized' | 'immediate',
  ): void {
    if (this.disposed || this.registrations.get(action)?.id !== registration.id) {
      return
    }

    const invoke = (): Promise<void> => {
      if (this.disposed || this.registrations.get(action)?.id !== registration.id) {
        return Promise.resolve()
      }
      return Promise.resolve(callback())
    }
    if (mode === 'immediate') {
      void invoke().catch(() => undefined)
      return
    }
    this.dispatchQueue = this.dispatchQueue.then(invoke, invoke).catch(() => undefined)
  }

  private unregisterOwned(): void {
    for (const registration of this.registrations.values()) {
      this.adapter.unregister(registration.accelerator)
    }
    this.registrations.clear()
  }
}
