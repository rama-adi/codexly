import { contextBridge, ipcRenderer } from 'electron'
import { z } from 'zod'

import {
  BootstrapRequestSchema,
  BootstrapResponseSchema,
  SubscribeRequestSchema,
  SubscribeResponseSchema,
  UnsubscribeRequestSchema,
} from '../src/shared/ipc/contracts'
import {
  SubscriptionEventEnvelopeSchema,
  SubscriptionTopicSchema,
} from '../src/shared/ipc/events'
import { createResponseEnvelopeSchema } from '../src/shared/ipc/envelopes'
import { IPC_CHANNELS } from '../src/shared/ipc/operations'
import {
  ProductEventSchema,
  ProductResponseSchema,
  type ProductCommand,
  type ProductEvent,
} from '../src/shared/ipc/product'
import type {
  CodexlyDesktopBridgeV1,
  DesktopSubscriptionListener,
} from '../src/types/desktop-bridge'
import type { SubscriptionTopic } from '../src/shared/ipc/events'
import type { CanonicalSettings } from '../src/shared/schemas/settings'

const EmptyResultSchema = z.object({}).strict()
const UnsubscribeResponseSchema = createResponseEnvelopeSchema(
  EmptyResultSchema,
  z.literal('subscriptions.unsubscribe'),
)
type SubscriptionEvent = z.infer<
  typeof SubscriptionEventEnvelopeSchema
>['event']

const subscriptionListeners = new Map<
  string,
  (event: SubscriptionEvent) => void
>()
const pendingSubscriptionEvents = new Map<string, SubscriptionEvent[]>()
const MAX_PENDING_SUBSCRIPTIONS = 32
const MAX_PENDING_EVENTS_PER_SUBSCRIPTION = 32
const productListeners = new Set<(event: ProductEvent) => void>()

ipcRenderer.on(IPC_CHANNELS.event, (_electronEvent, rawEnvelope: unknown) => {
  const parsed = SubscriptionEventEnvelopeSchema.safeParse(rawEnvelope)
  if (!parsed.success) {
    return
  }

  const { subscriptionId, event } = parsed.data
  const listener = subscriptionListeners.get(subscriptionId)
  if (listener) {
    listener(event)
    return
  }

  const pending = pendingSubscriptionEvents.get(subscriptionId)
  if (pending) {
    if (pending.length < MAX_PENDING_EVENTS_PER_SUBSCRIPTION) {
      pending.push(event)
    }
    return
  }
  if (pendingSubscriptionEvents.size < MAX_PENDING_SUBSCRIPTIONS) {
    pendingSubscriptionEvents.set(subscriptionId, [event])
  }
})

ipcRenderer.on(IPC_CHANNELS.productEvent, (_electronEvent, rawEvent: unknown) => {
  const parsed = ProductEventSchema.safeParse(rawEvent)
  if (!parsed.success) return
  for (const listener of productListeners) listener(parsed.data)
})

const requestBootstrap = async () => {
  const request = BootstrapRequestSchema.parse({
    version: 1,
    requestId: createRequestId(),
    operation: 'bootstrap.get',
    sentAt: new Date().toISOString(),
    payload: {},
  })
  const response = BootstrapResponseSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.request, request),
  )
  if (!response.ok) {
    throw createBridgeError(response.error)
  }
  return response.data
}

const invokeProduct = async (command: ProductCommand): Promise<unknown> => {
  const response = ProductResponseSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.product, command),
  )
  if (!response.ok) throw new Error(response.error.message)
  return response.data
}

const bridge: CodexlyDesktopBridgeV1 = Object.freeze({
  bootstrap: requestBootstrap,
  snapshot: requestBootstrap,
  async subscribe(
    topics: readonly SubscriptionTopic[],
    listener: DesktopSubscriptionListener,
  ) {
    const validatedTopics = z
      .array(SubscriptionTopicSchema)
      .min(1)
      .parse([...topics])
    const request = SubscribeRequestSchema.parse({
      version: 1,
      requestId: createRequestId(),
      operation: 'subscriptions.subscribe',
      sentAt: new Date().toISOString(),
      payload: { topics: validatedTopics },
    })
    const response = SubscribeResponseSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.request, request),
    )
    if (!response.ok) {
      throw createBridgeError(response.error)
    }

    const { subscriptionId } = response.data
    subscriptionListeners.set(subscriptionId, listener)
    const pending = pendingSubscriptionEvents.get(subscriptionId) ?? []
    pendingSubscriptionEvents.delete(subscriptionId)
    for (const event of pending) {
      listener(event)
    }
    let active = true

    return async () => {
      if (!active) {
        return
      }
      const unsubscribeRequest = UnsubscribeRequestSchema.parse({
        version: 1,
        requestId: createRequestId(),
        operation: 'subscriptions.unsubscribe',
        sentAt: new Date().toISOString(),
        payload: { subscriptionId },
      })
      const unsubscribeResponse = UnsubscribeResponseSchema.parse(
        await ipcRenderer.invoke(IPC_CHANNELS.request, unsubscribeRequest),
      )
      if (!unsubscribeResponse.ok) {
        throw createBridgeError(unsubscribeResponse.error)
      }
      active = false
      subscriptionListeners.delete(subscriptionId)
      pendingSubscriptionEvents.delete(subscriptionId)
    }
  },
  runtimeStatus: () => invokeProduct({ type: 'runtime.status' }),
  useChatGpt: () => invokeProduct({ type: 'auth.useChatGpt' }),
  setApiKey: (apiKey: string, persist: boolean) =>
    invokeProduct({ type: 'auth.setApiKey', apiKey, persist }),
  getSettings: () =>
    invokeProduct({ type: 'settings.get' }) as Promise<CanonicalSettings>,
  updateSettings: (settings: CanonicalSettings) =>
    invokeProduct({ type: 'settings.update', settings }) as Promise<CanonicalSettings>,
  listSessions: () => invokeProduct({ type: 'sessions.list' }),
  getSession: (sessionId: string) => invokeProduct({ type: 'sessions.get', sessionId }),
  createSession: () => invokeProduct({ type: 'sessions.create' }),
  deleteSession: (sessionId: string) =>
    invokeProduct({ type: 'sessions.delete', sessionId }) as Promise<boolean>,
  reactivateSession: (sessionId: string) =>
    invokeProduct({ type: 'sessions.reactivate', sessionId }),
  listWorkspaces: () => invokeProduct({ type: 'workspaces.list' }),
  pickWorkspace: () => invokeProduct({ type: 'workspaces.pick' }),
  selectWorkspace: (workspaceId: string) =>
    invokeProduct({ type: 'workspaces.select', workspaceId }),
  removeWorkspace: (workspaceId: string) =>
    invokeProduct({ type: 'workspaces.remove', workspaceId }) as Promise<boolean>,
  sendMessage: (input: Parameters<CodexlyDesktopBridgeV1['sendMessage']>[0]) => invokeProduct({ type: 'conversation.send', ...input }),
  stopTurn: (turnId: string) =>
    invokeProduct({ type: 'conversation.stop', turnId }) as Promise<boolean>,
  capture: () => invokeProduct({ type: 'attachments.capture' }),
  openHome: async () => {
    await invokeProduct({ type: 'window.openHome' })
  },
  toggleOverlay: async () => {
    await invokeProduct({ type: 'window.toggleOverlay' })
  },
  onProductEvent(listener: (event: ProductEvent) => void) {
    productListeners.add(listener)
    return () => productListeners.delete(listener)
  },
})

contextBridge.exposeInMainWorld(
  'codexly',
  Object.freeze({ v1: bridge }),
)

function createRequestId(): string {
  return globalThis.crypto.randomUUID()
}

function createBridgeError(error: {
  code: string
  message: string
  retryable: boolean
}): Error {
  const bridgeError = new Error(error.message)
  bridgeError.name = `CodexlyBridgeError:${error.code}`
  Object.defineProperty(bridgeError, 'retryable', {
    value: error.retryable,
    enumerable: true,
  })
  return bridgeError
}
