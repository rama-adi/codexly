import { randomUUID } from 'node:crypto'

import { ipcMain, webContents } from 'electron'
import { z } from 'zod'

import type { SerializedError } from '../../src/shared/errors/serialized-error'
import {
  BootstrapResponseSchema,
  SubscribeResponseSchema,
} from '../../src/shared/ipc/contracts'
import {
  SubscriptionEventEnvelopeSchema,
  SubscriptionEventSchema,
  type SubscriptionEvent,
  type SubscriptionTopic,
} from '../../src/shared/ipc/events'
import { createResponseEnvelopeSchema } from '../../src/shared/ipc/envelopes'
import { IPC_CHANNELS, type IpcOperation } from '../../src/shared/ipc/operations'
import {
  ProductCommandSchema,
  ProductEventSchema,
  ProductResponseSchema,
  type ProductCommand,
  type ProductEvent,
} from '../../src/shared/ipc/product'
import { BootstrapSchema, type Bootstrap } from '../../src/shared/schemas/bootstrap'
import { logger } from '../shared/logger'
import type { WindowRole } from '../windows/window-options'
import {
  authorizeRequestForRole,
  BridgeAccessError,
  getRequestId,
  getRequestOperation,
  parseSupportedRequest,
  validateSenderUrl,
  type SenderUrlPolicy,
  type SupportedRequest,
} from './validate-sender'

const EmptyResultSchema = z.object({}).strict()
const UnsubscribeResponseSchema = createResponseEnvelopeSchema(
  EmptyResultSchema,
  z.literal('subscriptions.unsubscribe'),
)

/** The invoke-event surface the routing reads, stated structurally. */
export interface IpcInvokeEvent {
  readonly sender: {
    readonly id: number
    readonly mainFrame: { readonly routingId: number }
    once(event: 'destroyed', listener: () => void): void
  }
  readonly senderFrame: { readonly routingId: number; readonly url: string } | null
}

export type IpcInvokeHandler = (
  event: IpcInvokeEvent,
  payload: unknown,
) => Promise<unknown> | unknown

/**
 * The `ipcMain` surface this module needs. Injecting it lets the routing and the
 * per-role authorization be exercised without an Electron runtime.
 */
export interface IpcTransport {
  handle(channel: string, handler: IpcInvokeHandler): void
  removeHandler(channel: string): void
}

export function createElectronIpcTransport(): IpcTransport {
  return {
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  }
}

interface SubscriptionRecord {
  readonly id: string
  readonly ownerWebContentsId: number
  readonly ownerFrameRoutingId: number
  readonly topics: ReadonlySet<SubscriptionTopic>
  sequence: number
}

export interface RegisterIpcOptions extends SenderUrlPolicy {
  resolveWindowRole(webContentsId: number): WindowRole | null
  getBootstrap(role: WindowRole): Promise<Bootstrap> | Bootstrap
  handleProduct(command: ProductCommand, role: WindowRole): Promise<unknown>
  /** Transport seam; defaults to the real `ipcMain`. */
  transport?: IpcTransport
}

export interface IpcRegistration {
  publish(event: SubscriptionEvent): void
  publishProduct(event: ProductEvent, roles?: readonly WindowRole[]): void
  dispose(): void
}

const log = logger.child('ipc')

export function registerIpc(options: RegisterIpcOptions): IpcRegistration {
  const subscriptions = new Map<string, SubscriptionRecord>()
  const ownersWithCleanup = new Set<number>()
  const transport = options.transport ?? createElectronIpcTransport()
  let disposed = false
  log.info('Registering IPC handlers')

  transport.handle(IPC_CHANNELS.request, async (event, rawRequest: unknown) => {
    const receivedAt = new Date().toISOString()
    const requestId = getRequestId(rawRequest)
    const operation = getRequestOperation(rawRequest)

    try {
      const role = validateManagedSender(event, options)
      const request = parseSupportedRequest(rawRequest)
      authorizeRequestForRole(role, request)

      log.debug('Bridge request received', {
        role,
        operation: request.operation,
        requestId,
        senderId: event.sender.id,
      })
      return await handleRequest(
        event,
        role,
        request,
        receivedAt,
        subscriptions,
        ownersWithCleanup,
        options,
      )
    } catch (error) {
      log.error('Bridge request failed', error, {
        operation,
        requestId,
        senderId: event.sender.id,
      })
      return parseResponse(operation, {
        version: 1,
        requestId,
        operation,
        receivedAt,
        ok: false,
        error: serializeError(error, requestId),
      })
    }
  })

  transport.handle(IPC_CHANNELS.product, async (event, rawCommand: unknown) => {
    const startedAt = Date.now()
    const commandType =
      rawCommand && typeof rawCommand === 'object' && 'type' in rawCommand
        ? String((rawCommand as { type: unknown }).type)
        : 'unknown'
    let role: WindowRole | undefined
    try {
      role = validateManagedSender(event, options)
      const command = ProductCommandSchema.parse(rawCommand)
      authorizeProductCommand(role, command)
      log.debug('Product command received', {
        role,
        command: command.type,
        senderId: event.sender.id,
      })
      const data = await options.handleProduct(command, role)
      log.debug('Product command handled', {
        role,
        command: command.type,
        durationMs: Date.now() - startedAt,
      })
      return ProductResponseSchema.parse({ ok: true, data })
    } catch (error) {
      log.error('Product command failed', error, {
        role: role ?? 'unresolved',
        command: commandType,
        senderId: event.sender.id,
        durationMs: Date.now() - startedAt,
      })
      return ProductResponseSchema.parse({
        ok: false,
        error: {
          code: error instanceof BridgeAccessError ? error.code : 'internal',
          message: error instanceof Error ? error.message : 'The command failed.',
        },
      })
    }
  })

  return {
    publish(event) {
      if (disposed) {
        return
      }

      const parsedEvent = SubscriptionEventSchema.parse(event)
      const topic = getEventTopic(parsedEvent)

      for (const subscription of subscriptions.values()) {
        if (!subscription.topics.has(topic)) {
          continue
        }

        const target = webContents.fromId(subscription.ownerWebContentsId)
        if (
          !target ||
          target.isDestroyed() ||
          target.mainFrame.routingId !== subscription.ownerFrameRoutingId
        ) {
          subscriptions.delete(subscription.id)
          continue
        }

        const envelope = SubscriptionEventEnvelopeSchema.parse({
          version: 1,
          eventId: randomUUID(),
          subscriptionId: subscription.id,
          sequence: subscription.sequence,
          emittedAt: new Date().toISOString(),
          event: parsedEvent,
        })
        subscription.sequence += 1
        target.send(IPC_CHANNELS.event, envelope)
      }
    },
    publishProduct(event, roles = ['homepage', 'overlay']) {
      if (disposed) return
      const parsed = ProductEventSchema.parse(event)
      for (const target of webContents.getAllWebContents()) {
        const role = options.resolveWindowRole(target.id)
        if (role && roles.includes(role) && !target.isDestroyed()) {
          target.send(IPC_CHANNELS.productEvent, parsed)
        }
      }
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      subscriptions.clear()
      ownersWithCleanup.clear()
      transport.removeHandler(IPC_CHANNELS.request)
      transport.removeHandler(IPC_CHANNELS.product)
    },
  }
}

async function handleRequest(
  event: IpcInvokeEvent,
  role: WindowRole,
  request: SupportedRequest,
  receivedAt: string,
  subscriptions: Map<string, SubscriptionRecord>,
  ownersWithCleanup: Set<number>,
  options: RegisterIpcOptions,
): Promise<unknown> {
  switch (request.operation) {
    case 'bootstrap.get': {
      const bootstrap = BootstrapSchema.parse(await options.getBootstrap(role))
      return BootstrapResponseSchema.parse({
        version: 1,
        requestId: request.requestId,
        operation: request.operation,
        receivedAt,
        ok: true,
        data: bootstrap,
      })
    }
    case 'subscriptions.subscribe': {
      const subscriptionId = randomUUID()
      const ownerWebContentsId = event.sender.id
      subscriptions.set(subscriptionId, {
        id: subscriptionId,
        ownerWebContentsId,
        ownerFrameRoutingId: event.sender.mainFrame.routingId,
        topics: new Set(request.payload.topics),
        sequence: 0,
      })
      if (!ownersWithCleanup.has(ownerWebContentsId)) {
        ownersWithCleanup.add(ownerWebContentsId)
        event.sender.once('destroyed', () => {
          ownersWithCleanup.delete(ownerWebContentsId)
          for (const [id, subscription] of subscriptions) {
            if (subscription.ownerWebContentsId === ownerWebContentsId) {
              subscriptions.delete(id)
            }
          }
        })
      }
      return SubscribeResponseSchema.parse({
        version: 1,
        requestId: request.requestId,
        operation: request.operation,
        receivedAt,
        ok: true,
        data: { subscriptionId },
      })
    }
    case 'subscriptions.unsubscribe': {
      const subscription = subscriptions.get(request.payload.subscriptionId)
      if (!subscription) {
        throw new BridgeAccessError('invalid_request', 'The subscription does not exist.')
      }
      if (subscription.ownerWebContentsId !== event.sender.id) {
        throw new BridgeAccessError(
          'forbidden',
          'The subscription belongs to another managed window.',
        )
      }
      subscriptions.delete(subscription.id)
      return UnsubscribeResponseSchema.parse({
        version: 1,
        requestId: request.requestId,
        operation: request.operation,
        receivedAt,
        ok: true,
        data: {},
      })
    }
  }
}

function validateManagedSender(
  event: IpcInvokeEvent,
  options: RegisterIpcOptions,
): WindowRole {
  const role = options.resolveWindowRole(event.sender.id)
  if (!role) {
    log.warn('Sender is not a managed window', { senderId: event.sender.id })
    throw new BridgeAccessError(
      'unauthorized',
      'The sender is not a managed Codexly window.',
    )
  }

  const senderFrame = event.senderFrame
  if (
    !senderFrame ||
    senderFrame.routingId !== event.sender.mainFrame.routingId
  ) {
    log.warn('Bridge request from non-main frame', {
      role,
      senderId: event.sender.id,
      hasFrame: Boolean(senderFrame),
    })
    throw new BridgeAccessError(
      'unauthorized',
      'Desktop bridge requests must originate from the managed main frame.',
    )
  }

  validateSenderUrl(senderFrame.url, role, options)
  return role
}

function parseResponse(operation: IpcOperation, response: unknown): unknown {
  switch (operation) {
    case 'subscriptions.subscribe':
      return SubscribeResponseSchema.parse(response)
    case 'subscriptions.unsubscribe':
      return UnsubscribeResponseSchema.parse(response)
    default:
      return BootstrapResponseSchema.parse(response)
  }
}

function serializeError(error: unknown, requestId: string): SerializedError {
  if (error instanceof BridgeAccessError) {
    return {
      version: 1,
      code: error.code,
      message: error.message,
      retryable: false,
      requestId,
    }
  }

  if (error instanceof z.ZodError) {
    return {
      version: 1,
      code: 'internal',
      message: 'The desktop bridge produced data that failed contract validation.',
      retryable: false,
      requestId,
    }
  }

  return {
    version: 1,
    code: 'internal',
    message: 'The desktop bridge request could not be completed.',
    retryable: false,
    requestId,
  }
}

/**
 * Commands the overlay may issue. The overlay bridge exposes the full product
 * surface, so anything the overlay UI can reach must be listed here — a missing
 * entry is a live bug, not a locked door. Every command is classified either
 * here or in {@link HOMEPAGE_ONLY_PRODUCT_COMMANDS}, and `register-ipc.test.ts`
 * fails when a newly contracted command belongs to neither.
 */
export const OVERLAY_PRODUCT_COMMANDS: ReadonlySet<ProductCommand['type']> = new Set([
  'runtime.status',
  'runtime.testConnection',
  'models.list',
  'settings.get',
  'sessions.get',
  'sessions.create',
  'conversation.send',
  'conversation.stop',
  'conversation.transcriptSnapshot',
  'conversation.solvePending',
  'attachments.capture',
  'attachments.captureSelection',
  'attachments.list',
  'attachments.discard',
  'attachments.clear',
  'window.openHome',
  'window.toggleOverlay',
  'window.resizeOverlay',
  'window.setOverlayFocusable',
])

/**
 * Commands only the homepage may issue: credential entry, destructive session
 * and workspace management, and the native directory picker.
 */
export const HOMEPAGE_ONLY_PRODUCT_COMMANDS: ReadonlySet<ProductCommand['type']> = new Set([
  'auth.useChatGpt',
  'auth.setApiKey',
  'settings.update',
  'sessions.list',
  'sessions.delete',
  'sessions.reactivate',
  'workspaces.list',
  'workspaces.pick',
  'workspaces.select',
  'workspaces.remove',
  'attachments.getPreviews',
])

export function authorizeProductCommand(role: WindowRole, command: ProductCommand): void {
  if (role === 'homepage') return
  if (!OVERLAY_PRODUCT_COMMANDS.has(command.type)) {
    log.warn('Rejected product command: not permitted for role', {
      role,
      command: command.type,
      allowed: [...OVERLAY_PRODUCT_COMMANDS],
    })
    throw new BridgeAccessError('forbidden', 'The overlay cannot perform this action.')
  }
}

function getEventTopic(event: SubscriptionEvent): SubscriptionTopic {
  switch (event.type) {
    case 'attachment.changed':
      return 'attachments'
    case 'auth.changed':
      return 'auth'
    case 'capabilities.changed':
      return 'capabilities'
    case 'conversation.deleted':
    case 'conversation.upserted':
    case 'message.upserted':
      return 'conversations'
    case 'session.changed':
      return 'sessions'
    case 'settings.changed':
      return 'settings'
    case 'window.changed':
      return 'windows'
  }
}
