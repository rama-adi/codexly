import { describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS } from '../../src/shared/ipc/operations'
import {
  ProductCommandSchema,
  type ProductCommand,
} from '../../src/shared/ipc/product'
import type { WindowRole } from '../windows/window-options'
import {
  authorizeProductCommand,
  HOMEPAGE_ONLY_PRODUCT_COMMANDS,
  OVERLAY_PRODUCT_COMMANDS,
  registerIpc,
  type IpcInvokeHandler,
  type IpcTransport,
} from './register-ipc'
import { BridgeAccessError } from './validate-sender'

/** Every command type the shared contract can carry, read from the schema. */
const CONTRACTED_COMMANDS: readonly ProductCommand['type'][] = (
  ProductCommandSchema as unknown as {
    options: readonly { shape: { type: { value: ProductCommand['type'] } } }[]
  }
).options.map((option) => option.shape.type.value)

const DEV_SERVER_URL = 'http://localhost:5173/'

function createTransport() {
  const handlers = new Map<string, IpcInvokeHandler>()
  const removed: string[] = []
  const transport: IpcTransport = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel) => {
      handlers.delete(channel)
      removed.push(channel)
    },
  }
  return { transport, handlers, removed }
}

function createSenderEvent(role: WindowRole) {
  return {
    sender: { id: 7, mainFrame: { routingId: 1 }, once: () => undefined },
    senderFrame: { routingId: 1, url: `${DEV_SERVER_URL}?role=${role}` },
  }
}

function sendProductCommand(
  role: WindowRole,
  command: ProductCommand,
  handleProduct = vi.fn(async () => null as unknown),
) {
  const { transport, handlers, removed } = createTransport()
  const registration = registerIpc({
    transport,
    rendererFilePath: '/app/dist/index.html',
    devServerUrl: DEV_SERVER_URL,
    resolveWindowRole: () => role,
    getBootstrap: () => {
      throw new Error('not used')
    },
    handleProduct,
  })
  const handler = handlers.get(IPC_CHANNELS.product)
  if (!handler) throw new Error('the product channel was never registered')
  return {
    registration,
    removed,
    handleProduct,
    response: handler(createSenderEvent(role), command) as Promise<{
      ok: boolean
      error?: { code: string; message: string }
      data?: unknown
    }>,
  }
}

describe('product command authorization coverage', () => {
  it('classifies every contracted command for exactly one role policy', () => {
    const classified = new Set([
      ...OVERLAY_PRODUCT_COMMANDS,
      ...HOMEPAGE_ONLY_PRODUCT_COMMANDS,
    ])
    // A command that is contracted but classified nowhere is the exact shape of
    // the transcriptSnapshot bug: reachable from the overlay UI, rejected by the
    // bridge. Adding a command to the contract must force a decision here.
    expect([...CONTRACTED_COMMANDS].filter((type) => !classified.has(type))).toEqual([])
    expect(
      [...classified].filter(
        (type) => !CONTRACTED_COMMANDS.includes(type as ProductCommand['type']),
      ),
    ).toEqual([])
    expect(
      [...OVERLAY_PRODUCT_COMMANDS].filter((type) =>
        HOMEPAGE_ONLY_PRODUCT_COMMANDS.has(type),
      ),
    ).toEqual([])
  })

  it.each([...OVERLAY_PRODUCT_COMMANDS])('lets the overlay issue %s', (type) => {
    expect(() =>
      authorizeProductCommand('overlay', { type } as ProductCommand),
    ).not.toThrow()
  })

  it.each([...HOMEPAGE_ONLY_PRODUCT_COMMANDS])(
    'refuses %s from the overlay but allows it from the homepage',
    (type) => {
      expect(() => authorizeProductCommand('overlay', { type } as ProductCommand)).toThrow(
        BridgeAccessError,
      )
      expect(() =>
        authorizeProductCommand('homepage', { type } as ProductCommand),
      ).not.toThrow()
    },
  )

  it('keeps every turn-lifecycle command reachable from the overlay', () => {
    // The overlay owns the whole live-turn surface: sending, stopping, and the
    // re-sync that repairs a dropped event.
    for (const type of [
      'conversation.send',
      'conversation.stop',
      'conversation.transcriptSnapshot',
      'conversation.solvePending',
    ] as const) {
      expect(OVERLAY_PRODUCT_COMMANDS.has(type)).toBe(true)
    }
  })
})

describe('product command routing', () => {
  it('routes an overlay transcript re-sync to the product handler', async () => {
    const handleProduct = vi.fn(async () => ({ turnId: 'turn-1' }))
    const routed = sendProductCommand(
      'overlay',
      { type: 'conversation.transcriptSnapshot', turnId: 'turn-1' },
      handleProduct,
    )
    await expect(routed.response).resolves.toEqual({
      ok: true,
      data: { turnId: 'turn-1' },
    })
    expect(handleProduct).toHaveBeenCalledWith(
      { type: 'conversation.transcriptSnapshot', turnId: 'turn-1' },
      'overlay',
    )
  })

  it('rejects a homepage-only command from the overlay without reaching the handler', async () => {
    const routed = sendProductCommand('overlay', { type: 'workspaces.pick' })
    await expect(routed.response).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    })
    expect(routed.handleProduct).not.toHaveBeenCalled()
  })

  it('rejects a sender that is not a managed window', async () => {
    const { transport, handlers } = createTransport()
    const handleProduct = vi.fn(async () => null as unknown)
    registerIpc({
      transport,
      rendererFilePath: '/app/dist/index.html',
      devServerUrl: DEV_SERVER_URL,
      resolveWindowRole: () => null,
      getBootstrap: () => {
        throw new Error('not used')
      },
      handleProduct,
    })
    const response = await handlers.get(IPC_CHANNELS.product)?.(
      createSenderEvent('overlay'),
      { type: 'runtime.status' },
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(handleProduct).not.toHaveBeenCalled()
  })

  it('releases both channels on dispose', () => {
    const routed = sendProductCommand('homepage', { type: 'runtime.status' })
    routed.registration.dispose()
    expect(routed.removed).toEqual([IPC_CHANNELS.request, IPC_CHANNELS.product])
  })
})
