import { describe, expect, it, vi } from 'vitest'

import { createScope } from './scope'

describe('createScope', () => {
  it('runs finalizers in reverse registration order', async () => {
    const order: string[] = []
    const scope = createScope()
    scope.defer(() => {
      order.push('first')
    })
    scope.defer(() => {
      order.push('second')
    })
    scope.defer(async () => {
      await Promise.resolve()
      order.push('third')
    })

    await scope.close()

    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('runs every finalizer exactly once across repeated and concurrent closes', async () => {
    const finalizer = vi.fn()
    const scope = createScope()
    scope.defer(finalizer)

    await Promise.all([scope.close('a'), scope.close('b')])
    await scope.close('c')

    expect(finalizer).toHaveBeenCalledOnce()
    expect(scope.closed).toBe(true)
  })

  it('keeps tearing down and never rejects when a finalizer throws', async () => {
    const errors: unknown[] = []
    const survivors: string[] = []
    const scope = createScope({
      label: 'turn-1',
      onFinalizerError: (error) => errors.push(error),
    })
    scope.defer(() => {
      survivors.push('outer')
    })
    scope.defer(() => {
      throw new Error('sync finalizer failed')
    })
    scope.defer(async () => {
      throw new Error('async finalizer failed')
    })
    scope.defer(() => {
      survivors.push('inner')
    })

    await expect(scope.close('teardown')).resolves.toBeUndefined()

    expect(survivors).toEqual(['inner', 'outer'])
    expect(errors.map((error) => (error as Error).message)).toEqual([
      'async finalizer failed',
      'sync finalizer failed',
    ])
  })

  it('runs a finalizer registered after close instead of leaking the resource', async () => {
    const released: string[] = []
    const scope = createScope()
    await scope.close()

    scope.defer(() => {
      released.push('late')
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(released).toEqual(['late'])
  })

  it('reports the close reason with a failing late finalizer', async () => {
    const errors: Array<{ label?: string; reason?: string }> = []
    const scope = createScope({
      label: 'turn-2',
      onFinalizerError: (_error, context) => errors.push(context),
    })
    scope.defer(() => {
      throw new Error('boom')
    })
    await scope.close('turn terminal')

    expect(errors).toEqual([{ label: 'turn-2', reason: 'turn terminal' }])
  })
})
