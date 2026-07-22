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
  ConversationTurnResultSchema,
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
const pendingProductEvents: ProductEvent[] = []
const MAX_PENDING_PRODUCT_EVENTS = 128
const MAX_PENDING_STREAM_BYTES = 256 * 1024
// Attachment previews may legitimately contain a 25 MiB image encoded as a
// base64 data URL (~67 MiB in a UTF-16 string). Keep one full-size capture plus
// control events, but do not allow a sequence of previews to grow unchecked.
const MAX_PENDING_PROTECTED_BYTES = 96 * 1024 * 1024
let pendingProductBytes = 0
let hasAttachedProductListener = false

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
  if (productListeners.size > 0) {
    for (const listener of productListeners) listener(parsed.data)
    return
  }
  // The main process can emit overlay.opened, conversation.started, and even
  // an instant terminal event before React mounts its first listener. Buffer
  // only during that initial hand-off; unmounting later must not replay stale
  // events when the overlay subscribes again.
  if (!hasAttachedProductListener) bufferProductEvent(parsed.data)
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
  testConnection: () =>
    invokeProduct({ type: 'runtime.testConnection' }) as ReturnType<
      CodexlyDesktopBridgeV1['testConnection']
    >,
  listModels: () =>
    invokeProduct({ type: 'models.list' }) as ReturnType<
      CodexlyDesktopBridgeV1['listModels']
    >,
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
  sendMessage: async (input: Parameters<CodexlyDesktopBridgeV1['sendMessage']>[0]) =>
    ConversationTurnResultSchema.parse(
      await invokeProduct({ type: 'conversation.send', ...input }),
    ),
  stopTurn: (turnId: string) =>
    invokeProduct({ type: 'conversation.stop', turnId }) as Promise<boolean>,
  solvePending: async (modelId: string) =>
    ConversationTurnResultSchema.parse(
      await invokeProduct({ type: 'conversation.solvePending', modelId }),
    ),
  capture: () => invokeProduct({ type: 'attachments.capture' }),
  captureSelection: () => invokeProduct({ type: 'attachments.captureSelection' }),
  listAttachments: () => invokeProduct({ type: 'attachments.list' }),
  discardAttachment: (attachmentId: string) =>
    invokeProduct({ type: 'attachments.discard', attachmentId }) as Promise<boolean>,
  clearAttachments: async () => {
    await invokeProduct({ type: 'attachments.clear' })
  },
  openHome: async () => {
    await invokeProduct({ type: 'window.openHome' })
  },
  toggleOverlay: async (preserveSession?: boolean) => {
    await invokeProduct({
      type: 'window.toggleOverlay',
      ...(preserveSession === undefined ? {} : { preserveSession }),
    })
  },
  resizeOverlay: async (width: number, height: number) => {
    await invokeProduct({ type: 'window.resizeOverlay', width, height })
  },
  onProductEvent(listener: (event: ProductEvent) => void) {
    productListeners.add(listener)
    if (!hasAttachedProductListener) {
      hasAttachedProductListener = true
      const replay = pendingProductEvents.splice(0)
      pendingProductBytes = 0
      for (const event of replay) listener(event)
    }
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

function bufferProductEvent(event: ProductEvent): void {
  removeSupersededProductEvents(event)
  const last = pendingProductEvents[pendingProductEvents.length - 1]
  if (
    last &&
    (last.type === 'transcript.delta' || last.type === 'transcript.reasoning') &&
    (event.type === 'transcript.delta' || event.type === 'transcript.reasoning') &&
    last.type === event.type &&
    last.sessionId === event.sessionId &&
    last.turnId === event.turnId &&
    last.origin === event.origin
  ) {
    pendingProductBytes -= productEventSize(last)
    last.text += event.text
    pendingProductBytes += productEventSize(last)
  } else {
    pendingProductEvents.push(event)
    pendingProductBytes += productEventSize(event)
  }

  while (pendingProductBytes > MAX_PENDING_STREAM_BYTES) {
    // Streaming payloads are expendable when the renderer is absent. Evict
    // them before lifecycle/control events so a delta storm cannot hide the
    // start or terminal signal needed to settle the overlay state machine.
    const streamIndex = pendingProductEvents.findIndex(isEvictableProductEvent)
    if (streamIndex < 0) break
    removePendingProductEvent(streamIndex)
  }

  while (pendingProductEvents.length > MAX_PENDING_PRODUCT_EVENTS) {
    const streamIndex = pendingProductEvents.findIndex(isEvictableProductEvent)
    removePendingProductEvent(streamIndex >= 0 ? streamIndex : 0)
  }

  while (pendingProductBytes > MAX_PENDING_PROTECTED_BYTES) {
    const sizes = pendingProductEvents.map(productEventSize)
    let newestOversizedIndex = -1
    for (let index = sizes.length - 1; index >= 0; index -= 1) {
      if ((sizes[index] ?? 0) > MAX_PENDING_PROTECTED_BYTES) {
        newestOversizedIndex = index
        break
      }
    }
    // An individual authoritative event can exceed the aggregate ceiling. We
    // retain at most one such event and keep only a soft-cap-sized envelope of
    // lifecycle events around it. This is the only exception to the byte cap.
    if (newestOversizedIndex >= 0) {
      const oversizedSize = sizes[newestOversizedIndex] ?? 0
      if (pendingProductBytes - oversizedSize <= MAX_PENDING_STREAM_BYTES) break
      const olderOversizedIndex = sizes.findIndex(
        (size, index) =>
          index !== newestOversizedIndex && size > MAX_PENDING_PROTECTED_BYTES,
      )
      const removableIndex = olderOversizedIndex >= 0
        ? olderOversizedIndex
        : pendingProductEvents.findIndex(
            (_candidate, index) => index !== newestOversizedIndex,
          )
      if (removableIndex < 0) break
      removePendingProductEvent(removableIndex)
      continue
    }
    removePendingProductEvent(0)
  }
}

function removeSupersededProductEvents(event: ProductEvent): void {
  if (event.type === 'attachments.cleared') {
    removeAllPendingProductEvents(
      (candidate) =>
        candidate.type === 'attachment.captured' ||
        candidate.type === 'attachments.cleared',
    )
    return
  }
  if (event.type === 'attachment.captured') {
    const id = attachmentId(event)
    if (id) {
      removeAllPendingProductEvents(
        (candidate) =>
          candidate.type === 'attachment.captured' && attachmentId(candidate) === id,
      )
    }
    return
  }
  if (
    event.type === 'overlay.opened' ||
    event.type === 'sessions.changed' ||
    event.type === 'settings.changed' ||
    event.type === 'runtime.status'
  ) {
    removeAllPendingProductEvents((candidate) => candidate.type === event.type)
  }
}

function removeAllPendingProductEvents(
  predicate: (event: ProductEvent) => boolean,
): void {
  for (let index = pendingProductEvents.length - 1; index >= 0; index -= 1) {
    const event = pendingProductEvents[index]
    if (event && predicate(event)) removePendingProductEvent(index)
  }
}

function removePendingProductEvent(index: number): void {
  const [removed] = pendingProductEvents.splice(index, 1)
  if (removed) pendingProductBytes -= productEventSize(removed)
}

function attachmentId(
  event: Extract<ProductEvent, { type: 'attachment.captured' }>,
): string | null {
  if (!event.attachment || typeof event.attachment !== 'object') return null
  const id = (event.attachment as Record<string, unknown>)['id']
  return typeof id === 'string' && id.length > 0 ? id : null
}

function isEvictableProductEvent(event: ProductEvent): boolean {
  return (
    event.type === 'transcript.delta' ||
    event.type === 'transcript.reasoning' ||
    event.type === 'tool.output' ||
    event.type === 'tool.status'
  )
}

function productEventSize(event: ProductEvent): number {
  // Avoid JSON.stringify here: a full screenshot would allocate another huge
  // temporary string, and attachment is intentionally opaque (so it may even
  // contain structured-clone cycles). Count UTF-16 payloads without copying
  // them and stop once the only meaningful threshold has been crossed.
  return estimateValueBytes(
    event,
    MAX_PENDING_PROTECTED_BYTES + 1,
    new WeakSet<object>(),
  )
}

function estimateValueBytes(
  value: unknown,
  remaining: number,
  seen: WeakSet<object>,
): number {
  if (remaining <= 0 || value === null || value === undefined) return 0
  if (typeof value === 'string') return Math.min(remaining, value.length * 2)
  if (typeof value !== 'object') return Math.min(remaining, 8)
  if (seen.has(value)) return 0
  seen.add(value)
  let bytes = Math.min(remaining, 16)
  for (const [key, child] of Object.entries(value)) {
    if (bytes >= remaining) break
    bytes += Math.min(remaining - bytes, key.length * 2)
    bytes += estimateValueBytes(child, remaining - bytes, seen)
  }
  return bytes
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
