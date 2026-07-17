import { pathToFileURL } from 'node:url'

import {
  BootstrapRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type BootstrapRequest,
  type SubscribeRequest,
  type UnsubscribeRequest,
} from '../../src/shared/ipc/contracts'
import type { IpcOperation } from '../../src/shared/ipc/operations'
import type { SubscriptionTopic } from '../../src/shared/ipc/events'
import {
  WINDOW_ROLE_QUERY_PARAMETER,
  type WindowRole,
} from '../windows/window-options'

export type SupportedRequest =
  | BootstrapRequest
  | SubscribeRequest
  | UnsubscribeRequest

export type BridgeAccessErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'

export class BridgeAccessError extends Error {
  constructor(
    readonly code: BridgeAccessErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeAccessError'
  }
}

export interface SenderUrlPolicy {
  rendererFilePath: string
  devServerUrl?: string
}

const OVERLAY_TOPICS = new Set<SubscriptionTopic>([
  'capabilities',
  'sessions',
  'windows',
])

export function parseSupportedRequest(value: unknown): SupportedRequest {
  const candidates = [
    BootstrapRequestSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
  ] as const

  for (const schema of candidates) {
    const parsed = schema.safeParse(value)
    if (parsed.success) {
      return parsed.data
    }
  }

  throw new BridgeAccessError(
    'invalid_request',
    'The desktop bridge request does not match a supported contract.',
  )
}

export function validateSenderUrl(
  senderUrl: string,
  role: WindowRole,
  policy: SenderUrlPolicy,
): void {
  let sender: URL
  try {
    sender = new URL(senderUrl)
  } catch {
    throw new BridgeAccessError('unauthorized', 'The sender URL is invalid.')
  }

  const expectedRole = sender.searchParams.get(WINDOW_ROLE_QUERY_PARAMETER)
  const queryKeys = [...sender.searchParams.keys()]
  if (
    sender.username ||
    sender.password ||
    expectedRole !== role ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== WINDOW_ROLE_QUERY_PARAMETER
  ) {
    throw new BridgeAccessError(
      'unauthorized',
      'The sender URL does not identify its managed window role.',
    )
  }

  const fileTarget = pathToFileURL(policy.rendererFilePath)
  const matchesFile =
    sender.protocol === 'file:' &&
    sender.origin === fileTarget.origin &&
    sender.host === fileTarget.host &&
    sender.pathname === fileTarget.pathname

  let matchesDevelopmentServer = false
  if (policy.devServerUrl) {
    const developmentTarget = new URL(policy.devServerUrl)
    matchesDevelopmentServer =
      sender.protocol === developmentTarget.protocol &&
      sender.origin === developmentTarget.origin &&
      normalizePathname(sender.pathname) ===
        normalizePathname(developmentTarget.pathname)
  }

  if (!matchesFile && !matchesDevelopmentServer) {
    throw new BridgeAccessError(
      'unauthorized',
      'The sender is not an approved Codexly renderer.',
    )
  }
}

export function authorizeRequestForRole(
  role: WindowRole,
  request: SupportedRequest,
): void {
  if (role === 'homepage') {
    return
  }

  if (request.operation === 'subscriptions.subscribe') {
    const deniedTopic = request.payload.topics.find(
      (topic) => !OVERLAY_TOPICS.has(topic),
    )
    if (deniedTopic) {
      throw new BridgeAccessError(
        'forbidden',
        `The overlay cannot subscribe to the ${deniedTopic} topic.`,
      )
    }
  }
}

export function getRequestOperation(value: unknown): IpcOperation {
  if (isRecord(value) && typeof value.operation === 'string') {
    if (
      value.operation === 'bootstrap.get' ||
      value.operation === 'subscriptions.subscribe' ||
      value.operation === 'subscriptions.unsubscribe'
    ) {
      return value.operation
    }
  }
  return 'bootstrap.get'
}

export function getRequestId(value: unknown): string {
  if (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    value.requestId.trim().length > 0 &&
    value.requestId.length <= 128
  ) {
    return value.requestId
  }
  return 'invalid-request'
}

function normalizePathname(pathname: string): string {
  return pathname.endsWith('/') ? pathname : `${pathname}/`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
