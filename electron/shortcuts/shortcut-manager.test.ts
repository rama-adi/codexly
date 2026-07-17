import { describe, expect, it } from 'vitest'

import {
  ShortcutManager,
  type GlobalShortcutAdapter,
} from './shortcut-manager'

class FakeGlobalShortcutAdapter implements GlobalShortcutAdapter {
  readonly registerCalls: string[] = []
  readonly unregisterCalls: string[] = []
  private readonly handlers = new Map<string, () => void>()

  occupy(accelerator: string): void {
    this.handlers.set(accelerator, () => undefined)
  }

  register(accelerator: string, callback: () => void): boolean {
    this.registerCalls.push(accelerator)
    if (this.handlers.has(accelerator)) {
      return false
    }

    this.handlers.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.unregisterCalls.push(accelerator)
    this.handlers.delete(accelerator)
  }

  trigger(accelerator: string): void {
    this.handlers.get(accelerator)?.()
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

  it('serializes asynchronous action dispatch', async () => {
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
        second: {
          accelerator: 'CommandOrControl+2',
          callback: () => {
            events.push('second')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    adapter.trigger('CommandOrControl+2')
    await flushQueue()
    expect(events).toEqual(['first:start'])

    firstAction.resolve()
    await flushQueue()
    expect(events).toEqual(['first:start', 'first:end', 'second'])
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
        blocker: {
          accelerator: 'CommandOrControl+1',
          callback: () => blocker.promise,
        },
        stale: {
          accelerator: 'CommandOrControl+2',
          callback: () => {
            events.push('stale')
          },
        },
      },
    })

    adapter.trigger('CommandOrControl+1')
    adapter.trigger('CommandOrControl+2')
    await flushQueue()
    manager.configure({})
    blocker.resolve()
    await flushQueue()

    expect(events).toEqual([])
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
})
