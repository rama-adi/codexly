import { randomUUID } from 'node:crypto'

import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron'
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
}

export interface IpcRegistration {
  publish(event: SubscriptionEvent): void
  publishProduct(event: ProductEvent, roles?: readonly WindowRole[]): void
  dispose(): void
}

export function registerIpc(options: RegisterIpcOptions): IpcRegistration {
  const subscriptions = new Map<string, SubscriptionRecord>()
  const ownersWithCleanup = new Set<number>()
  let disposed = false

  ipcMain.handle(IPC_CHANNELS.request, async (event, rawRequest: unknown) => {
    const receivedAt = new Date().toISOString()
    const requestId = getRequestId(rawRequest)
    const operation = getRequestOperation(rawRequest)

    try {
      const role = validateManagedSender(event, options)
      const request = parseSupportedRequest(rawRequest)
      authorizeRequestForRole(role, request)

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

  ipcMain.handle(IPC_CHANNELS.product, async (event, rawCommand: unknown) => {
    try {
      const role = validateManagedSender(event, options)
      const command = ProductCommandSchema.parse(rawCommand)
      authorizeProductCommand(role, command)
      return ProductResponseSchema.parse({
        ok: true,
        data: await options.handleProduct(command, role),
      })
    } catch (error) {
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
      ipcMain.removeHandler(IPC_CHANNELS.request)
      ipcMain.removeHandler(IPC_CHANNELS.product)
    },
  }
}

async function handleRequest(
  event: IpcMainInvokeEvent,
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
  event: IpcMainInvokeEvent,
  options: RegisterIpcOptions,
): WindowRole {
  const role = options.resolveWindowRole(event.sender.id)
  if (!role) {
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

function authorizeProductCommand(role: WindowRole, command: ProductCommand): void {
  if (role === 'homepage') return
  const allowed = new Set<ProductCommand['type']>([
    'runtime.status',
    'sessions.get',
    'sessions.create',
    'conversation.send',
    'conversation.stop',
    'conversation.solvePending',
    'attachments.capture',
    'attachments.list',
    'attachments.discard',
    'attachments.clear',
    'window.openHome',
    'window.toggleOverlay',
    'window.resizeOverlay',
  ])
  if (!allowed.has(command.type)) {
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
