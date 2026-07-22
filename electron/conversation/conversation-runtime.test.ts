import type { LanguageModel } from 'ai'
import type {
  CodexAppServerProvider,
  CodexAppServerProviderOptions,
  CodexAppServerSession,
  CodexAppServerSettings,
} from 'ai-sdk-provider-codex-cli'
import { describe, expect, it, vi } from 'vitest'

import {
  ConversationRuntime,
  type ConversationEventStore,
  type ConversationProviderManager,
  type ConversationThreadStore,
} from './conversation-runtime'
import type { TurnEventEnvelope } from './turn-controller'

function asyncParts(parts: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        yield part
      }
    },
  }
}

function appServerOptions(
  stream: ReturnType<typeof vi.fn>,
  index = 0,
): CodexAppServerProviderOptions {
  const call = (stream.mock.calls as unknown as Array<[Record<string, unknown>]>)[index]?.[0]
  const providerOptions = call?.providerOptions as
    | Record<string, CodexAppServerProviderOptions>
    | undefined
  return providerOptions?.['codex-app-server'] ?? {}
}

function createProvider() {
  const settings: CodexAppServerSettings[] = []
  const model = { specificationVersion: 'v4' } as unknown as LanguageModel
  const provider = ((_modelId: string, value?: CodexAppServerSettings) => {
    settings.push(value ?? {})
    return model
  }) as unknown as CodexAppServerProvider
  provider.close = vi.fn(async () => undefined)
  provider.dispose = provider.close
  provider.listModels = vi.fn()
  provider.languageModel = provider
  provider.chat = provider
  provider.embeddingModel = () => {
    throw new Error('unsupported')
  }
  provider.imageModel = () => {
    throw new Error('unsupported')
  }
  return { provider, settings }
}

function createStores(initialThreadId: string | null = null) {
  let threadId = initialThreadId
  const savedThreads: Array<string | null> = []
  const events: TurnEventEnvelope[] = []
  const threads: ConversationThreadStore = {
    getThreadId: async () => threadId,
    setThreadId: async (_conversationId, next) => {
      threadId = next
      savedThreads.push(next)
    },
  }
  const eventStore: ConversationEventStore = {
    append: async (event) => {
      events.push(event)
    },
  }
  return { threads, eventStore, events, savedThreads }
}

function createManager(
  provider: CodexAppServerProvider,
): ConversationProviderManager {
  return {
    getProvider: vi.fn(async () => ({
      provider,
      release: vi.fn(async () => undefined),
    })),
    dispose: vi.fn(async () => undefined),
  }
}

const baseInput = {
  conversationId: 'conversation-1',
  modelId: 'gpt-test',
  message: 'Explain the code.',
  workspacePath: '/workspace',
  workspaceRevision: 1,
  configRevision: 1,
}

describe('ConversationRuntime', () => {
  it('preserves provider-native delta fields through the runtime event store', async () => {
    const { provider } = createProvider()
    const stores = createStores()
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: (() => ({
        stream: asyncParts([
          { type: 'reasoning-delta', id: 'reasoning', delta: 'inspect image' },
          { type: 'text-delta', id: 'answer', delta: 'visible answer' },
        ]),
        finishReason: Promise.resolve('stop'),
      })) as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-provider-shape',
    })

    expect(await (await runtime.startTurn(baseInput)).completion).toBe('completed')
    expect(stores.events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        { type: 'reasoning.delta', itemId: 'reasoning', text: 'inspect image' },
        { type: 'assistant.delta', itemId: 'answer', text: 'visible answer' },
      ]),
    )
  })

  it('resumes a persisted thread with locked-down model settings and records events', async () => {
    const { provider, settings } = createProvider()
    const stores = createStores('thr-existing')
    const stream = vi.fn(() => ({
      stream: asyncParts([{ type: 'text-delta', id: 'answer', text: 'Done.' }]),
      finishReason: Promise.resolve('stop'),
    }))
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: stream as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-1',
      now: () => new Date('2026-02-03T04:05:06.000Z'),
    })

    const handle = await runtime.startTurn(baseInput)
    expect(await handle.completion).toBe('completed')

    expect(settings[0].onSessionCreated).toEqual(expect.any(Function))
    expect(settings[0]).not.toHaveProperty('resume')
    expect(settings[0]).not.toHaveProperty('developerInstructions')
    expect(appServerOptions(stream)).toMatchObject({
      resume: 'thr-existing',
      configOverrides: {
        'tools.web_search': false,
        'tools.image_generation': false,
      },
    })
    expect(appServerOptions(stream).developerInstructions).toContain('read-only')
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
      }),
    )
    const streamOptions = (stream.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
    expect(streamOptions).not.toHaveProperty('include')
    expect(stores.savedThreads).toEqual([])
    expect(stores.events.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(stores.events[stores.events.length - 1]?.event).toEqual({
      type: 'turn.completed',
      finishReason: 'stop',
    })
  })

  it('persists a session thread as soon as the provider creates it', async () => {
    const { provider, settings } = createProvider()
    const stores = createStores()
    const manager = createManager(provider)
    const runtime = new ConversationRuntime({
      providers: manager,
      threads: stores.threads,
      events: stores.eventStore,
      stream: (() => ({
        stream: asyncParts([]),
        finishReason: Promise.resolve('stop'),
      })) as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-1',
    })

    const handle = await runtime.startTurn(baseInput)
    while (!settings[0]) {
      await Promise.resolve()
    }
    const session = {
      threadId: 'thr-new',
      turnId: null,
      injectMessage: async () => undefined,
      interrupt: async () => undefined,
      isActive: () => false,
    } satisfies CodexAppServerSession
    await settings[0].onSessionCreated?.(session)
    await handle.completion

    expect(stores.savedThreads).toEqual(['thr-new'])
  })

  it('does not rewrite a persisted thread id when a resumed session is created', async () => {
    const { provider, settings } = createProvider()
    const stores = createStores('thr-existing')
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: (() => ({
        stream: asyncParts([]),
        finishReason: Promise.resolve('stop'),
      })) as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-1',
    })

    const handle = await runtime.startTurn(baseInput)
    while (!settings[0]) {
      await Promise.resolve()
    }
    await settings[0].onSessionCreated?.({
      threadId: 'thr-existing',
      turnId: null,
      injectMessage: async () => undefined,
      interrupt: async () => undefined,
      isActive: () => false,
    })
    await handle.completion

    expect(stores.savedThreads).toEqual([])
  })

  it('aborts through both AbortSignal and session interrupt and emits one terminal event', async () => {
    const { provider, settings } = createProvider()
    const stores = createStores()
    let releaseStream: (() => void) | undefined
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: ((options: { abortSignal?: AbortSignal }) => ({
        stream: {
          async *[Symbol.asyncIterator]() {
            await streamGate
            if (options.abortSignal?.aborted) {
              throw options.abortSignal.reason
            }
            yield { type: 'start' }
          },
        },
        finishReason: Promise.resolve('other'),
      })) as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-1',
      interruptTimeoutMs: 20,
    })

    const handle = await runtime.startTurn(baseInput)
    while (!settings[0]) {
      await Promise.resolve()
    }
    const interrupt = vi.fn(async () => undefined)
    await settings[0].onSessionCreated?.({
      threadId: 'thr-1',
      turnId: 'provider-turn',
      injectMessage: async () => undefined,
      interrupt,
      isActive: () => true,
    })
    await handle.abort('user cancelled')
    releaseStream?.()

    expect(await handle.completion).toBe('interrupted')
    expect(interrupt).toHaveBeenCalledOnce()
    expect(
      stores.events.filter((event) =>
        ['turn.completed', 'turn.interrupted', 'turn.failed'].includes(
          event.event.type,
        ),
      ),
    ).toHaveLength(1)
  })

  it('suppresses stale events when a new turn supersedes an older turn', async () => {
    const { provider } = createProvider()
    const stores = createStores()
    let releaseOld: (() => void) | undefined
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    let call = 0
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: (() => {
        call += 1
        const current = call
        return {
          stream: {
            async *[Symbol.asyncIterator]() {
              if (current === 1) {
                await oldGate
                yield { type: 'text-delta', text: 'stale' }
              } else {
                yield { type: 'text-delta', text: 'fresh' }
              }
            },
          },
          finishReason: Promise.resolve('stop'),
        }
      }) as unknown as typeof import('ai').streamText,
      generateTurnId: () => `turn-${call + 1}`,
      interruptTimeoutMs: 1,
    })

    const first = await runtime.startTurn(baseInput)
    await Promise.resolve()
    const second = await runtime.startTurn({ ...baseInput, message: 'New question' })
    releaseOld?.()
    await Promise.all([first.completion, second.completion])

    const deltas = stores.events.filter(
      (event) => event.event.type === 'assistant.delta',
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].event).toMatchObject({ text: 'fresh' })
    expect(await first.completion).toBe('interrupted')
    expect(await second.completion).toBe('completed')
  })

  it('clears a stale persisted thread and retries the same turn once', async () => {
    const { provider } = createProvider()
    const stores = createStores('thr-stale')
    let calls = 0
    const stream = vi.fn(() => {
      calls += 1
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            if (calls === 1) {
              throw new Error("Thread 'thr-stale' not found after server restart")
            }
            yield { type: 'text-delta', text: 'recovered' }
          },
        },
        finishReason: Promise.resolve('stop'),
      }
    })
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: stream as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-retry',
    })

    const handle = await runtime.startTurn(baseInput)
    expect(await handle.completion).toBe('completed')
    expect(calls).toBe(2)
    expect(appServerOptions(stream, 0).resume).toBe('thr-stale')
    expect(appServerOptions(stream, 1).resume).toBeUndefined()
    expect(stores.savedThreads).toContain(null)
  })

  it('recovers from the codex 0.14x "no rollout found" stale-thread wording', async () => {
    const { provider } = createProvider()
    const stores = createStores('thr-rollout')
    let calls = 0
    const stream = vi.fn(() => {
      calls += 1
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            if (calls === 1) {
              throw new Error(
                'JSON-RPC error -32600: no rollout found for thread id thr-rollout',
              )
            }
            yield { type: 'text-delta', text: 'recovered' }
          },
        },
        finishReason: Promise.resolve('stop'),
      }
    })
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: stream as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-rollout-retry',
    })

    const handle = await runtime.startTurn(baseInput)
    expect(await handle.completion).toBe('completed')
    expect(calls).toBe(2)
    expect(appServerOptions(stream, 1).resume).toBeUndefined()
    expect(stores.savedThreads).toContain(null)
  })

  it('settles completion even when terminal event persistence fails', async () => {
    const { provider } = createProvider()
    const stores = createStores()
    stores.eventStore.append = async (event) => {
      stores.events.push(event)
      if (event.event.type === 'turn.failed') {
        throw new Error('event store unavailable')
      }
    }
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: (() => ({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'start' }
            throw new Error('provider failed')
          },
        },
        finishReason: Promise.resolve('other'),
      })) as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-failure',
    })

    const handle = await runtime.startTurn(baseInput)
    expect(await handle.completion).toBe('failed')
  })

  it('uses one stable session callback per conversation', async () => {
    const { provider, settings } = createProvider()
    const stores = createStores()
    const stream = vi.fn(() => ({
      stream: asyncParts([]),
      finishReason: Promise.resolve('stop'),
    }))
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: stream as unknown as typeof import('ai').streamText,
      generateTurnId: () => `turn-${settings.length}`,
    })

    await (await runtime.startTurn(baseInput)).completion
    await (
      await runtime.startTurn({ ...baseInput, message: 'again', webSearch: true })
    ).completion
    await (
      await runtime.startTurn({
        ...baseInput,
        conversationId: 'conversation-2',
        message: 'separate',
      })
    ).completion

    expect(settings[0].onSessionCreated).toBe(settings[1].onSessionCreated)
    expect(settings[2].onSessionCreated).not.toBe(settings[0].onSessionCreated)
    expect(settings.every((value) => value.configOverrides === undefined)).toBe(true)
    expect(appServerOptions(stream, 0).configOverrides?.['tools.web_search']).toBe(false)
    expect(appServerOptions(stream, 1).configOverrides?.['tools.web_search']).toBe(true)
  })

  it('threads per-turn reasoning effort through request-scoped provider options', async () => {
    const { provider } = createProvider()
    const stores = createStores()
    const stream = vi.fn(() => ({
      stream: asyncParts([]),
      finishReason: Promise.resolve('stop'),
    }))
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: stream as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-1',
    })

    await (await runtime.startTurn({ ...baseInput, reasoningEffort: 'medium' })).completion

    expect(appServerOptions(stream).effort).toBe('medium')
  })

  it('retries a minimal-effort turn at low effort on a tool-incompatibility error', async () => {
    const { provider } = createProvider()
    const stores = createStores()
    let calls = 0
    const stream = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        return {
          stream: {
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  Promise.reject(
                    new Error(
                      "reasoning.effort 'minimal' cannot be used with the web_search tool",
                    ),
                  ),
              }
            },
          },
          finishReason: Promise.resolve('error'),
        }
      }
      return { stream: asyncParts([]), finishReason: Promise.resolve('stop') }
    })
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: stream as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'turn-1',
    })

    const handle = await runtime.startTurn({ ...baseInput, reasoningEffort: 'minimal' })
    expect(await handle.completion).toBe('completed')
    expect(stream).toHaveBeenCalledTimes(2)
    expect(appServerOptions(stream, 0).effort).toBe('minimal')
    expect(appServerOptions(stream, 1).effort).toBe('low')
  })

  it('lists and normalizes Codex models', async () => {
    const { provider } = createProvider()
    ;(provider.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      models: [
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          isDefault: true,
          hidden: false,
          inputModalities: ['text', 'image'],
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { id: 'high' }],
        },
        { model: 'legacy', name: 'Legacy' },
        { notAModel: true },
      ],
    })
    const stores = createStores()
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
    })

    const models = await runtime.listModels(baseInput)

    expect(models).toEqual([
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        isDefault: true,
        hidden: false,
        inputModalities: ['text', 'image'],
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'high' },
        ],
      },
      {
        id: 'legacy',
        displayName: 'Legacy',
        isDefault: false,
        hidden: false,
        inputModalities: ['text', 'image'],
        supportedReasoningEfforts: [],
      },
    ])
  })

  it('warms the shared provider process and releases its lease', async () => {
    const { provider } = createProvider()
    const release = vi.fn(async () => undefined)
    const manager: ConversationProviderManager = {
      getProvider: vi.fn(async () => ({ provider, release })),
      dispose: vi.fn(async () => undefined),
    }
    ;(provider.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({ models: [] })
    const stores = createStores()
    const runtime = new ConversationRuntime({
      providers: manager,
      threads: stores.threads,
      events: stores.eventStore,
    })

    await runtime.warm(baseInput)

    expect(provider.listModels).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(manager.dispose).not.toHaveBeenCalled()
  })

  it('reports connection success and failure', async () => {
    const { provider } = createProvider()
    const stores = createStores()
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
    })

    ;(provider.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({ models: [] })
    expect(await runtime.testConnection(baseInput)).toEqual({ success: true })

    const failing: ConversationProviderManager = {
      getProvider: vi.fn(async () => {
        throw new Error('codex offline')
      }),
      dispose: vi.fn(async () => undefined),
    }
    const offline = new ConversationRuntime({
      providers: failing,
      threads: stores.threads,
      events: stores.eventStore,
    })
    expect(await offline.testConnection(baseInput)).toEqual({
      success: false,
      error: 'codex offline',
    })
  })

  it('uses a caller-supplied turn ID so routing can be installed before startup events', async () => {
    const { provider } = createProvider()
    const stores = createStores()
    const runtime = new ConversationRuntime({
      providers: createManager(provider),
      threads: stores.threads,
      events: stores.eventStore,
      stream: (() => ({
        stream: asyncParts([]),
        finishReason: Promise.resolve('stop'),
      })) as unknown as typeof import('ai').streamText,
      generateTurnId: () => 'generated-id-must-not-win',
    })

    const handle = await runtime.startTurn({ ...baseInput, turnId: 'routed-turn' })
    expect(handle.turnId).toBe('routed-turn')
    expect(stores.events[0]?.turnId).toBe('routed-turn')
    await handle.completion
  })
})
