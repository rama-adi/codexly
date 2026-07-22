import { describe, expect, it, vi } from 'vitest'

import {
  ShortcutManager,
  type GlobalShortcutAdapter,
} from './shortcut-manager'

class FakeGlobalShortcutAdapter implements GlobalShortcutAdapter {
  readonly registerCalls: string[] = []
  readonly unregisterCalls: string[] = []
  private readonly handlers = new Map<string, () => void>()
  private readonly staleHandlers = new Map<string, Array<() => void>>()
  private readonly registerErrors = new Map<string, Error>()
  private readonly unregisterErrors = new Map<string, Error>()
  private focused = true

  occupy(accelerator: string): void {
    this.handlers.set(accelerator, () => undefined)
  }

  failRegistration(accelerator: string, error = new Error('registration failed')): void {
    this.registerErrors.set(accelerator, error)
  }

  failUnregistration(accelerator: string, error = new Error('unregistration failed')): void {
    this.unregisterErrors.set(accelerator, error)
  }

  setFocused(focused: boolean): void {
    this.focused = focused
  }

  register(accelerator: string, callback: () => void): boolean {
    this.registerCalls.push(accelerator)
    const error = this.registerErrors.get(accelerator)
    if (error) throw error
    if (this.handlers.has(accelerator)) {
      return false
    }

    this.handlers.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.unregisterCalls.push(accelerator)
    const handler = this.handlers.get(accelerator)
    if (handler) {
      const stale = this.staleHandlers.get(accelerator) ?? []
      stale.push(handler)
      this.staleHandlers.set(accelerator, stale)
    }
    this.handlers.delete(accelerator)
    const error = this.unregisterErrors.get(accelerator)
    if (error) throw error
  }

  trigger(accelerator: string): void {
    // Electron globalShortcut handlers are delivered independently of which
    // application currently owns focus.
    void this.focused
    this.handlers.get(accelerator)?.()
  }

  triggerStale(accelerator: string, index = 0): void {
    this.staleHandlers.get(accelerator)?.[index]?.()
  }

  isRegistered(accelerator: string): boolean {
    return this.handlers.has(accelerator)
  }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return {
    promise,
    resolve: () => resolve?.(),
  }
}

async function flushQueue(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('ShortcutManager', () => {
  it('records conflicts per action from boolean registration results', () => {
    const adapter = new FakeGlobalShortcutAdapter()
    adapter.occupy('CommandOrControl+Shift+P')
    const manager = new ShortcutManager({
      adapter,
      shortcuts: {
        conflicted: {
          accelerator: 'CommandOrControl+Shift+P',
          callback: () => undefined,
        },
        available: {
          accelerator: 'CommandOrControl+Shift+O',
          callback: () => undefined,
        },
      },
    })

    expect(manager.getStatus('conflicted')).toEqual({
      accelerator: 'CommandOrControl+Shift+P',
      registered: false,
      conflicted: true,
    })
    expect(manager.getStatus('available')).toEqual({
      accelerator: 'CommandOrControl+Shift+O',
      registered: true,
      conflicted: false,
    })
    expect(manager.getStatuses()).toEqual({
      conflicted: manager.getStatus('conflicted'),
      available: manager.getStatus('available'),
    })
  })

  it('serializes repeated asynchronous dispatch of the same action', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const firstAction = deferred()
    const events: string[] = []
    new ShortcutManager({
      adapter,
      shortcuts: {
        first: {
          accelerator: 'CommandOrControl+1',
          callback: async () => {
            events.push('first:start')
            await firstAction.promise
            events.push('first:end')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    adapter.trigger('CommandOrControl+1')
    await flushQueue()
    expect(events).toEqual(['first:start'])

    firstAction.resolve()
    await flushQueue()
    await flushQueue()
    expect(events).toEqual(['first:start', 'first:end', 'first:start', 'first:end'])
  })

  it('allows unrelated long-running callbacks to overlap', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const firstAction = deferred()
    const secondAction = deferred()
    const events: string[] = []
    new ShortcutManager({
      adapter,
      shortcuts: {
        first: {
          accelerator: 'CommandOrControl+1',
          callback: async () => {
            events.push('first:start')
            await firstAction.promise
            events.push('first:end')
          },
        },
        second: {
          accelerator: 'CommandOrControl+2',
          callback: async () => {
            events.push('second:start')
            await secondAction.promise
            events.push('second:end')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    adapter.trigger('CommandOrControl+2')
    await flushQueue()
    expect(events).toEqual(['first:start', 'second:start'])

    secondAction.resolve()
    firstAction.resolve()
    await flushQueue()
    expect(events).toEqual([
      'first:start',
      'second:start',
      'second:end',
      'first:end',
    ])
  })

  it('dispatches cancellation actions immediately around a blocked serialized action', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const blocker = deferred()
    const events: string[] = []
    new ShortcutManager({
      adapter,
      shortcuts: {
        capture: {
          accelerator: 'CommandOrControl+1',
          callback: async () => {
            events.push('capture:start')
            await blocker.promise
            events.push('capture:end')
          },
        },
        cancel: {
          accelerator: 'Escape',
          dispatch: 'immediate',
          callback: () => {
            events.push('cancel')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    await flushQueue()
    adapter.trigger('Escape')
    await flushQueue()
    expect(events).toEqual(['capture:start', 'cancel'])

    blocker.resolve()
    await flushQueue()
    expect(events).toEqual(['capture:start', 'cancel', 'capture:end'])
  })

  it('drops queued actions after reconfiguration removes their registration', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const blocker = deferred()
    const events: string[] = []
    const manager = new ShortcutManager({
      adapter,
      shortcuts: {
        work: {
          accelerator: 'CommandOrControl+1',
          callback: async () => {
            events.push('start')
            await blocker.promise
            events.push('end')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    adapter.trigger('CommandOrControl+1')
    await flushQueue()
    manager.configure({})
    blocker.resolve()
    await flushQueue()
    await flushQueue()

    expect(events).toEqual(['start', 'end'])
  })

  it('continues dispatching after an action callback rejects', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const events: string[] = []
    new ShortcutManager({
      adapter,
      shortcuts: {
        rejected: {
          accelerator: 'CommandOrControl+1',
          callback: async () => {
            events.push('rejected')
            throw new Error('expected test rejection')
          },
        },
        recovered: {
          accelerator: 'CommandOrControl+2',
          callback: () => {
            events.push('recovered')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    adapter.trigger('CommandOrControl+2')
    await flushQueue()

    expect(events).toEqual(['rejected', 'recovered'])
  })

  it('reconfigures only shortcuts it owns and reports duplicate accelerators', () => {
    const adapter = new FakeGlobalShortcutAdapter()
    adapter.occupy('CommandOrControl+External')
    const manager = new ShortcutManager({
      adapter,
      shortcuts: {
        original: {
          accelerator: 'CommandOrControl+1',
          callback: () => undefined,
        },
      },
    })

    manager.configure({
      replacement: {
        accelerator: 'CommandOrControl+2',
        callback: () => undefined,
      },
      duplicate: {
        accelerator: 'CommandOrControl+2',
        callback: () => undefined,
      },
    })

    expect(adapter.unregisterCalls).toEqual(['CommandOrControl+1'])
    expect(adapter.registerCalls).toEqual([
      'CommandOrControl+1',
      'CommandOrControl+2',
    ])
    expect(adapter.isRegistered('CommandOrControl+External')).toBe(true)
    expect(manager.getStatus('original')).toBeUndefined()
    expect(manager.getStatus('replacement')).toEqual({
      accelerator: 'CommandOrControl+2',
      registered: true,
      conflicted: false,
    })
    expect(manager.getStatus('duplicate')).toEqual({
      accelerator: 'CommandOrControl+2',
      registered: false,
      conflicted: true,
    })
  })

  it('cleans up owned shortcuts exactly once without affecting others', () => {
    const adapter = new FakeGlobalShortcutAdapter()
    adapter.occupy('CommandOrControl+External')
    const manager = new ShortcutManager({
      adapter,
      shortcuts: {
        owned: {
          accelerator: 'CommandOrControl+1',
          callback: () => undefined,
        },
        conflict: {
          accelerator: 'CommandOrControl+External',
          callback: () => undefined,
        },
      },
    })

    manager.cleanup()
    manager.dispose()
    manager.configure({
      ignored: {
        accelerator: 'CommandOrControl+2',
        callback: () => undefined,
      },
    })

    expect(adapter.unregisterCalls).toEqual(['CommandOrControl+1'])
    expect(adapter.isRegistered('CommandOrControl+External')).toBe(true)
    expect(adapter.isRegistered('CommandOrControl+1')).toBe(false)
    expect(adapter.registerCalls).toEqual([
      'CommandOrControl+1',
      'CommandOrControl+External',
    ])
  })

  it('continues configuring after native registration throws and reports the failure', () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const failure = new Error('invalid accelerator')
    adapter.failRegistration('Broken', failure)
    const onError = vi.fn()
    const manager = new ShortcutManager({
      adapter,
      onError,
      shortcuts: {
        broken: { accelerator: 'Broken', callback: () => undefined },
        healthy: {
          accelerator: 'CommandOrControl+1',
          callback: () => undefined,
        },
      },
    })

    expect(manager.getStatus('broken')).toEqual({
      accelerator: 'Broken',
      registered: false,
      conflicted: true,
      error: 'invalid accelerator',
    })
    expect(manager.getStatus('healthy')?.registered).toBe(true)
    expect(onError).toHaveBeenCalledWith({
      phase: 'register',
      action: 'broken',
      accelerator: 'Broken',
      error: failure,
    })
  })

  it('keeps unregistering owned shortcuts when the native adapter throws', () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const failure = new Error('native teardown failed')
    const onError = vi.fn()
    const manager = new ShortcutManager({
      adapter,
      onError,
      shortcuts: {
        first: {
          accelerator: 'CommandOrControl+1',
          callback: () => undefined,
        },
        second: {
          accelerator: 'CommandOrControl+2',
          callback: () => undefined,
        },
      },
    })
    adapter.failUnregistration('CommandOrControl+1', failure)

    manager.dispose()

    expect(adapter.unregisterCalls).toEqual([
      'CommandOrControl+1',
      'CommandOrControl+2',
    ])
    expect(adapter.isRegistered('CommandOrControl+2')).toBe(false)
    expect(onError).toHaveBeenCalledWith({
      phase: 'unregister',
      action: 'first',
      accelerator: 'CommandOrControl+1',
      error: failure,
    })
  })

  it('dispatches while Codexly is unfocused', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const callback = vi.fn()
    new ShortcutManager({
      adapter,
      shortcuts: {
        summon: {
          accelerator: 'CommandOrControl+Shift+Space',
          callback,
        },
      },
    })

    adapter.setFocused(false)
    adapter.trigger('CommandOrControl+Shift+Space')
    await flushQueue()

    expect(callback).toHaveBeenCalledOnce()
  })

  it('ignores stale native callbacks after re-registering an action', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const oldCallback = vi.fn()
    const newCallback = vi.fn()
    const manager = new ShortcutManager({
      adapter,
      shortcuts: {
        summon: {
          accelerator: 'CommandOrControl+1',
          callback: oldCallback,
        },
      },
    })

    manager.configure({
      summon: {
        accelerator: 'CommandOrControl+2',
        callback: newCallback,
      },
    })
    adapter.triggerStale('CommandOrControl+1')
    adapter.trigger('CommandOrControl+2')
    await flushQueue()

    expect(oldCallback).not.toHaveBeenCalled()
    expect(newCallback).toHaveBeenCalledOnce()
  })

  it('reports synchronous and asynchronous callback errors without poisoning later dispatch', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const failures: string[] = []
    const events: string[] = []
    new ShortcutManager({
      adapter,
      onError: ({ phase, action, error }) => {
        failures.push(`${phase}:${action}:${String(error)}`)
      },
      shortcuts: {
        syncFailure: {
          accelerator: 'CommandOrControl+1',
          callback: () => {
            throw new Error('sync')
          },
        },
        asyncFailure: {
          accelerator: 'CommandOrControl+2',
          callback: async () => {
            throw new Error('async')
          },
        },
        healthy: {
          accelerator: 'CommandOrControl+3',
          callback: () => {
            events.push('healthy')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    adapter.trigger('CommandOrControl+2')
    adapter.trigger('CommandOrControl+3')
    await flushQueue()

    expect(failures).toEqual([
      'callback:syncFailure:Error: sync',
      'callback:asyncFailure:Error: async',
    ])
    expect(events).toEqual(['healthy'])
  })

  it('handles deterministic burst traffic without cross-action head-of-line blocking', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const gates = [deferred(), deferred(), deferred()]
    const started = [0, 0, 0]
    const completed = [0, 0, 0]
    const shortcuts = Object.fromEntries(
      gates.map((gate, index) => [
        `action${index}`,
        {
          accelerator: `CommandOrControl+${index + 1}`,
          callback: async () => {
            started[index] += 1
            await gate.promise
            completed[index] += 1
          },
        },
      ]),
    )
    new ShortcutManager({ adapter, shortcuts })

    let seed = 0x5eed
    const counts = [0, 0, 0]
    for (let index = 0; index < 60; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const action = seed % 3
      counts[action] += 1
      adapter.trigger(`CommandOrControl+${action + 1}`)
    }
    await flushQueue()

    expect(started).toEqual(counts.map((count) => (count > 0 ? 1 : 0)))
    expect(completed).toEqual([0, 0, 0])

    gates.forEach((gate) => gate.resolve())
    for (let index = 0; index < 70; index += 1) await flushQueue()
    expect(started).toEqual(counts)
    expect(completed).toEqual(counts)
  })

  it('drops queued and stale callbacks across disposal during a burst', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const blocker = deferred()
    const events: string[] = []
    const manager = new ShortcutManager({
      adapter,
      shortcuts: {
        work: {
          accelerator: 'CommandOrControl+1',
          callback: async () => {
            events.push('start')
            await blocker.promise
            events.push('end')
          },
        },
      },
    })

    for (let index = 0; index < 20; index += 1) {
      adapter.trigger('CommandOrControl+1')
    }
    await flushQueue()
    manager.dispose()
    adapter.triggerStale('CommandOrControl+1')
    blocker.resolve()
    for (let index = 0; index < 25; index += 1) await flushQueue()

    expect(events).toEqual(['start', 'end'])
  })

  it('dispatches immediate cancellation storms during blocked work', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const blocker = deferred()
    let cancellations = 0
    new ShortcutManager({
      adapter,
      shortcuts: {
        work: {
          accelerator: 'CommandOrControl+1',
          callback: () => blocker.promise,
        },
        cancel: {
          accelerator: 'Escape',
          dispatch: 'immediate',
          callback: () => {
            cancellations += 1
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    for (let index = 0; index < 50; index += 1) adapter.trigger('Escape')
    await flushQueue()

    expect(cancellations).toBe(50)
    blocker.resolve()
  })

  it('bounds key-repeat backpressure for single-flight actions', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const first = deferred()
    const second = deferred()
    const gates = [first, second]
    let invocations = 0
    new ShortcutManager({
      adapter,
      shortcuts: {
        capture: {
          accelerator: 'CommandOrControl+H',
          dispatch: 'single-flight',
          callback: async () => {
            const invocation = invocations
            invocations += 1
            await gates[invocation]?.promise
          },
        },
      },
    })

    for (let index = 0; index < 1_000; index += 1) {
      adapter.trigger('CommandOrControl+H')
    }
    await flushQueue()
    expect(invocations).toBe(1)

    first.resolve()
    await flushQueue()
    adapter.trigger('CommandOrControl+H')
    await flushQueue()
    expect(invocations).toBe(2)
    second.resolve()
  })

  it('releases single-flight actions after rejection', async () => {
    const adapter = new FakeGlobalShortcutAdapter()
    const onError = vi.fn()
    let invocations = 0
    new ShortcutManager({
      adapter,
      onError,
      shortcuts: {
        solve: {
          accelerator: 'CommandOrControl+Enter',
          dispatch: 'single-flight',
          callback: async () => {
            invocations += 1
            if (invocations === 1) throw new Error('failed solve')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+Enter')
    await flushQueue()
    adapter.trigger('CommandOrControl+Enter')
    await flushQueue()

    expect(invocations).toBe(2)
    expect(onError).toHaveBeenCalledOnce()
  })
})
