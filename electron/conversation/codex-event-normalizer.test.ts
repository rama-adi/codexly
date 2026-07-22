import { describe, expect, it } from 'vitest'

import { normalizeCodexEvent } from './codex-event-normalizer'

describe('normalizeCodexEvent', () => {
  it('normalizes AI SDK text and reasoning deltas into stable events', () => {
    expect(
      normalizeCodexEvent({ type: 'text-delta', id: 'a1', text: 'hello' }),
    ).toEqual([{ type: 'assistant.delta', itemId: 'a1', text: 'hello' }])
    expect(
      normalizeCodexEvent({ type: 'reasoning-delta', id: 'r1', text: 'think' }),
    ).toEqual([{ type: 'reasoning.delta', itemId: 'r1', text: 'think' }])
  })

  it('normalizes the installed app-server provider delta shape', () => {
    expect(
      normalizeCodexEvent({ type: 'text-delta', id: 'a1', delta: 'provider answer' }),
    ).toEqual([
      { type: 'assistant.delta', itemId: 'a1', text: 'provider answer' },
    ])
    expect(
      normalizeCodexEvent({ type: 'reasoning-delta', id: 'r1', delta: 'provider thought' }),
    ).toEqual([
      { type: 'reasoning.delta', itemId: 'r1', text: 'provider thought' },
    ])
  })

  it.each([
    { type: 'text-delta', id: 'empty', delta: '', text: 'legacy' },
    { type: 'text-delta', id: 'missing' },
    { type: 'reasoning-delta', id: 'wrong', delta: 12, text: null },
  ])('handles malformed and empty delta parts deterministically: %o', (part) => {
    const result = normalizeCodexEvent(part)
    if (part.id === 'empty') {
      expect(result).toEqual([{ type: 'assistant.delta', itemId: 'empty', text: '' }])
    } else {
      expect(result).toEqual([])
    }
  })

  it('discovers persistent thread and provider turn ids from raw chunks', () => {
    expect(
      normalizeCodexEvent({
        type: 'raw',
        rawValue: { method: 'thread/started', params: { thread: { id: 'thr-1' } } },
      }),
    ).toEqual([{ type: 'thread.discovered', threadId: 'thr-1' }])
    expect(
      normalizeCodexEvent({
        type: 'raw',
        rawValue: { method: 'turn/started', params: { turn: { id: 'codex-turn' } } },
      }),
    ).toEqual([{ type: 'provider.turn-started', providerTurnId: 'codex-turn' }])
  })

  it('normalizes activity lifecycle and output without leaking prototypes', () => {
    expect(
      normalizeCodexEvent({
        type: 'raw',
        rawValue: {
          method: 'item/started',
          params: {
            item: {
              id: 'cmd-1',
              type: 'commandExecution',
              status: 'inProgress',
              command: 'git status',
            },
          },
        },
      }),
    ).toEqual([
      {
        type: 'activity.started',
        activity: {
          id: 'cmd-1',
          kind: 'commandExecution',
          status: 'inProgress',
          title: 'git status',
          details: {
            id: 'cmd-1',
            type: 'commandExecution',
            status: 'inProgress',
            command: 'git status',
          },
        },
      },
    ])
    expect(
      normalizeCodexEvent({
        type: 'tool-result',
        toolCallId: 'cmd-1',
        toolName: 'shell',
        output: { type: 'output-delta', delta: 'line\n' },
      }),
    ).toEqual([
      {
        type: 'activity.output',
        activityId: 'cmd-1',
        text: 'line\n',
        preliminary: true,
      },
    ])
  })

  it('normalizes mapped tool-call JSON and derives its command title', () => {
    expect(
      normalizeCodexEvent({
        type: 'tool-call',
        toolCallId: 'cmd-1',
        toolName: 'exec',
        input: JSON.stringify({
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['git', 'status'],
        }),
      }),
    ).toEqual([
      {
        type: 'activity.started',
        activity: {
          id: 'cmd-1',
          kind: 'exec',
          status: 'running',
          title: 'git status',
          details: {
            id: 'cmd-1',
            type: 'commandExecution',
            command: ['git', 'status'],
          },
        },
      },
    ])
  })

  it('surfaces approval requests for UI handling but never answers them', () => {
    expect(
      normalizeCodexEvent({
        type: 'raw',
        rawValue: {
          id: 4,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thr-1', command: 'rm -rf /tmp/x' },
        },
      }),
    ).toEqual([
      {
        type: 'approval.requested',
        requestType: 'item/commandExecution/requestApproval',
        requestId: '4',
        details: { threadId: 'thr-1', command: 'rm -rf /tmp/x' },
      },
    ])
  })

  it('maps provider terminal and retryable error notifications', () => {
    expect(
      normalizeCodexEvent({
        type: 'raw',
        rawValue: {
          method: 'turn/completed',
          params: {
            turn: { status: 'failed', error: { message: 'unauthorized' } },
          },
        },
      }),
    ).toEqual([
      {
        type: 'provider.turn-completed',
        status: 'failed',
        error: 'unauthorized',
      },
    ])
    expect(
      normalizeCodexEvent({
        type: 'raw',
        rawValue: {
          method: 'error',
          params: { error: { message: 'retrying' }, willRetry: true },
        },
      }),
    ).toEqual([{ type: 'provider.error', message: 'retrying', retrying: true }])
  })
})
