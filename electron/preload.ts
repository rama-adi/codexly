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
  TranscriptSnapshotSchema,
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
// One window mounts several independent product-event consumers (settings, the
// overlay/History store, the settings page). They do not subscribe in the same
// tick, so the hand-off buffer has to survive the first subscriber and be
// replayed to each of them. It is retained for this grace period after the first
// subscriber attaches, which bounds the window in which a much later mount could
// see stale events; renderers de-duplicate replays by sequence number.
const PRODUCT_REPLAY_GRACE_MS = 3_000
// Attachment previews may legitimately contain a 25 MiB image encoded as a
// base64 data URL (~67 MiB in a UTF-16 string). Keep one full-size capture plus
// control events, but do not allow a sequence of previews to grow unchecked.
const MAX_PENDING_PROTECTED_BYTES = 96 * 1024 * 1024
let pendingProductBytes = 0
// Infinity until the first subscriber attaches: before that the buffer is the
// only copy of the stream and must never expire.
let productReplayDeadline = Number.POSITIVE_INFINITY

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
  // The main process can emit overlay.opened, conversation.started, and even an
  // instant terminal event before React mounts its first listener, and the
  // remaining consumers of the same window mount after it. Keep buffering across
  // the whole hand-off window so every one of them is replayed; only after the
  // window closes does the buffer stop growing and get dropped. The buffered
  // entry is coalesced and re-stamped in place, so it is a copy: never the object
  // a live listener has already been handed.
  if (isWithinProductReplayWindow()) bufferProductEvent({ ...parsed.data })
  else clearPendingProductEvents()
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
  if (!response.ok) {
    console.error('[preload] product command failed', {
      command: command.type,
      code: response.error.code,
      message: response.error.message,
    })
    const error = new Error(response.error.message)
    ;(error as { code?: string }).code = response.error.code
    throw error
  }
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
  getAttachmentPreviews: (attachmentIds: string[]) =>
    invokeProduct({ type: 'attachments.getPreviews', attachmentIds }),
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
  setOverlayFocusable: async (focusable: boolean) => {
    await invokeProduct({ type: 'window.setOverlayFocusable', focusable })
  },
  onProductEvent(listener: (event: ProductEvent) => void) {
    productListeners.add(listener)
    // Every subscriber that attaches within the hand-off window is replayed the
    // same buffer, so a consumer that filters the stream (settings only, one
    // origin only, …) can no longer starve its siblings.
    if (isWithinProductReplayWindow()) {
      if (productReplayDeadline === Number.POSITIVE_INFINITY) {
        productReplayDeadline = Date.now() + PRODUCT_REPLAY_GRACE_MS
      }
      for (const event of [...pendingProductEvents]) listener(event)
    } else {
      clearPendingProductEvents()
    }
    return () => productListeners.delete(listener)
  },
  transcriptSnapshot: async (turnId: string) =>
    TranscriptSnapshotSchema.nullable().parse(
      await invokeProduct({ type: 'conversation.transcriptSnapshot', turnId }),
    ),
})

contextBridge.exposeInMainWorld(
  'codexly',
  Object.freeze({ v1: bridge }),
)

function createRequestId(): string {
  return globalThis.crypto.randomUUID()
}

function isWithinProductReplayWindow(): boolean {
  return Date.now() <= productReplayDeadline
}

function clearPendingProductEvents(): void {
  if (pendingProductEvents.length === 0) return
  pendingProductEvents.length = 0
  pendingProductBytes = 0
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
    // The merged event now carries the text of the whole run, so it must claim
    // the NEWEST sequence: a consumer that applies it has consumed everything up
    // to that number, and adjacency in the buffer guarantees the run is
    // contiguous (an event of another turn or type would have broken the merge).
    if (event.sequence !== undefined) last.sequence = event.sequence
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
    evictPendingProductEvent(streamIndex)
  }

  while (pendingProductEvents.length > MAX_PENDING_PRODUCT_EVENTS) {
    const streamIndex = pendingProductEvents.findIndex(isEvictableProductEvent)
    if (streamIndex >= 0) {
      evictPendingProductEvent(streamIndex)
      continue
    }
    // Nothing expendable is left, so the cap has to break a protected event.
    // Sacrifice the oldest event that carries no turn identity first: a gap
    // marker cannot describe it, and its consumers re-read their own state on
    // mount, whereas dropping conversation.started or a terminal event would
    // wedge a state machine with no watermark to recover from. Note the drop
    // without inserting a marker, so the buffer always shrinks and this loop
    // cannot spin on a buffer of one-event-per-turn lifecycle records.
    const unscopedIndex = pendingProductEvents.findIndex(
      (candidate) => !isTurnScopedProductEvent(candidate),
    )
    dropProtectedProductEvent(unscopedIndex >= 0 ? unscopedIndex : 0)
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
      dropProtectedProductEvent(removableIndex)
      continue
    }
    dropProtectedProductEvent(0)
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

/**
 * Drops a buffered event under memory pressure and, when the event was part of a
 * turn's stream, leaves a `transcript.gap` marker in its place. Without the
 * marker a late subscriber would receive a transcript with a missing middle that
 * looks perfectly well-formed.
 */
function evictPendingProductEvent(index: number): void {
  const evicted = pendingProductEvents[index]
  removePendingProductEvent(index)
  if (evicted) noteEvictedProductEvent(evicted, index)
}

/**
 * Drops an event the caps must break even though it is not expendable. It only
 * annotates a gap marker the turn already has, never inserts one, so the buffer
 * strictly shrinks on every call.
 */
function dropProtectedProductEvent(index: number): void {
  const dropped = pendingProductEvents[index]
  removePendingProductEvent(index)
  if (dropped) mergeEvictedProductEvent(dropped)
}

function noteEvictedProductEvent(evicted: ProductEvent, index: number): void {
  if (!isEvictableProductEvent(evicted)) return
  if (mergeEvictedProductEvent(evicted)) return
  const marker: ProductEvent = {
    type: 'transcript.gap',
    sessionId: evicted.sessionId,
    turnId: evicted.turnId,
    origin: evicted.origin,
    evictedThrough: evicted.sequence ?? 0,
    droppedCount: 1,
  }
  pendingProductEvents.splice(index, 0, marker)
  pendingProductBytes += productEventSize(marker)
}

/**
 * Records a dropped turn-scoped event on that turn's existing gap marker, and
 * reports whether it found one. It never inserts a marker, so a caller whose
 * loop condition is the buffer length can use it and still shrink the buffer.
 */
function mergeEvictedProductEvent(evicted: ProductEvent): boolean {
  if (!isTurnScopedProductEvent(evicted)) return false
  const existing = pendingProductEvents.find(
    (candidate): candidate is Extract<ProductEvent, { type: 'transcript.gap' }> =>
      candidate.type === 'transcript.gap' &&
      candidate.turnId === evicted.turnId &&
      candidate.origin === evicted.origin,
  )
  if (!existing) return false
  // One marker per turn: it only has to say "something is missing", and the
  // watermark is the newest sequence known to be gone.
  existing.evictedThrough = Math.max(existing.evictedThrough, evictedSequence(evicted))
  existing.droppedCount +=
    evicted.type === 'transcript.gap' ? evicted.droppedCount : 1
  return true
}

function evictedSequence(evicted: TurnScopedProductEvent): number {
  if (evicted.type === 'transcript.gap') return evicted.evictedThrough
  return 'sequence' in evicted ? evicted.sequence ?? 0 : 0
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

type EvictableProductEvent = Extract<
  ProductEvent,
  { type: 'transcript.delta' | 'transcript.reasoning' | 'tool.output' | 'tool.status' }
>

function isEvictableProductEvent(event: ProductEvent): event is EvictableProductEvent {
  return (
    event.type === 'transcript.delta' ||
    event.type === 'transcript.reasoning' ||
    event.type === 'tool.output' ||
    event.type === 'tool.status'
  )
}

type TurnScopedProductEvent = Extract<ProductEvent, { turnId: string }>

/** Whether losing the event leaves a hole a `transcript.gap` marker can describe. */
function isTurnScopedProductEvent(
  event: ProductEvent,
): event is TurnScopedProductEvent {
  return 'turnId' in event
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
