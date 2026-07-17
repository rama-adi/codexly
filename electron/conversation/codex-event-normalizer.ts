import type { JsonValue } from '../../src/shared/schemas/common'

export type NormalizedCodexEvent =
  | { type: 'thread.discovered'; threadId: string }
  | { type: 'provider.turn-started'; providerTurnId: string }
  | {
      type: 'provider.turn-completed'
      status: 'completed' | 'interrupted' | 'failed' | 'unknown'
      error?: string
    }
  | { type: 'assistant.delta'; text: string; itemId?: string }
  | { type: 'reasoning.delta'; text: string; itemId?: string }
  | {
      type: 'activity.started' | 'activity.completed'
      activity: CodexActivity
    }
  | {
      type: 'activity.output'
      activityId: string
      text: string
      preliminary: boolean
    }
  | {
      type: 'approval.requested'
      requestType: string
      requestId?: string
      details: JsonValue
    }
  | { type: 'provider.error'; message: string; retrying: boolean }

export interface CodexActivity {
  id: string
  kind: string
  status?: string
  title?: string
  details: JsonValue
}

interface StreamPart {
  type: string
  [key: string]: unknown
}

export function normalizeCodexEvent(part: StreamPart): NormalizedCodexEvent[] {
  switch (part.type) {
    case 'text-delta':
      return typeof part.text === 'string'
        ? [
            {
              type: 'assistant.delta',
              text: part.text,
              ...(typeof part.id === 'string' ? { itemId: part.id } : {}),
            },
          ]
        : []
    case 'reasoning-delta':
      return typeof part.text === 'string'
        ? [
            {
              type: 'reasoning.delta',
              text: part.text,
              ...(typeof part.id === 'string' ? { itemId: part.id } : {}),
            },
          ]
        : []
    case 'tool-call':
      return [
        {
          type: 'activity.started',
          activity: {
            id: stringValue(part.toolCallId, 'unknown-tool'),
            kind: stringValue(part.toolName, 'tool'),
            status: 'running',
            details: toJsonValue(part.input),
          },
        },
      ]
    case 'tool-result': {
      const result = toRecord(part.output ?? part.result)
      if (result?.type === 'output-delta' && typeof result.delta === 'string') {
        return [
          {
            type: 'activity.output',
            activityId: stringValue(part.toolCallId, 'unknown-tool'),
            text: result.delta,
            preliminary: true,
          },
        ]
      }
      return [
        {
          type: 'activity.completed',
          activity: {
            id: stringValue(part.toolCallId, 'unknown-tool'),
            kind: stringValue(part.toolName, 'tool'),
            status: part.isError === true ? 'failed' : 'completed',
            details: toJsonValue(part.output ?? part.result),
          },
        },
      ]
    }
    case 'tool-approval-request':
      return [
        {
          type: 'approval.requested',
          requestType: 'tool',
          ...(typeof part.approvalId === 'string'
            ? { requestId: part.approvalId }
            : {}),
          details: toJsonValue(part),
        },
      ]
    case 'error':
      return [
        {
          type: 'provider.error',
          message: errorMessage(part.error),
          retrying: false,
        },
      ]
    case 'raw':
      return normalizeRaw(part.rawValue)
    default:
      return []
  }
}

function normalizeRaw(rawValue: unknown): NormalizedCodexEvent[] {
  const raw = toRecord(rawValue)
  const method = raw && typeof raw.method === 'string' ? raw.method : null
  const params = toRecord(raw?.params)
  if (!method || !params) {
    return []
  }

  if (method === 'thread/started') {
    const thread = toRecord(params.thread)
    return thread && typeof thread.id === 'string'
      ? [{ type: 'thread.discovered', threadId: thread.id }]
      : []
  }

  if (method === 'turn/started') {
    const turn = toRecord(params.turn)
    return turn && typeof turn.id === 'string'
      ? [{ type: 'provider.turn-started', providerTurnId: turn.id }]
      : []
  }

  if (method === 'turn/completed') {
    const turn = toRecord(params.turn)
    const error = toRecord(turn?.error)
    const status = normalizeTurnStatus(turn?.status)
    return [
      {
        type: 'provider.turn-completed',
        status,
        ...(typeof error?.message === 'string' ? { error: error.message } : {}),
      },
    ]
  }

  if (method === 'error') {
    const error = toRecord(params.error)
    return [
      {
        type: 'provider.error',
        message: errorMessage(error?.message ?? params),
        retrying: params.willRetry === true,
      },
    ]
  }

  if (method.endsWith('/requestApproval') || method === 'mcpServer/elicitation/request') {
    return [
      {
        type: 'approval.requested',
        requestType: method,
        ...(raw?.id !== undefined ? { requestId: String(raw.id) } : {}),
        details: toJsonValue(params),
      },
    ]
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = toRecord(params.item)
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') {
      return []
    }
    return [
      {
        type: method === 'item/started' ? 'activity.started' : 'activity.completed',
        activity: {
          id: item.id,
          kind: item.type,
          ...(typeof item.status === 'string' ? { status: item.status } : {}),
          ...(typeof item.command === 'string' ? { title: item.command } : {}),
          details: toJsonValue(item),
        },
      },
    ]
  }

  return []
}

function normalizeTurnStatus(
  value: unknown,
): 'completed' | 'interrupted' | 'failed' | 'unknown' {
  return value === 'completed' || value === 'interrupted' || value === 'failed'
    ? value
    : 'unknown'
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 8) {
    return '[truncated]'
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => toJsonValue(item, depth + 1))
  }
  const record = toRecord(value)
  if (record) {
    return Object.fromEntries(
      Object.entries(record)
        .slice(0, 200)
        .map(([key, item]) => [key, toJsonValue(item, depth + 1)]),
    )
  }
  return String(value)
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message
  }
  const record = toRecord(value)
  return typeof record?.message === 'string' ? record.message : String(value)
}
