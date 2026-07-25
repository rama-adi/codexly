import { streamText, type JSONValue, type LanguageModel } from 'ai'
import type {
  CodexAppServerProviderOptions,
  CodexAppServerSession,
  ReasoningEffort,
} from 'ai-sdk-provider-codex-cli'
import { randomUUID } from 'node:crypto'

import type {
  ConnectionTestResult,
  ModelOption,
  ReasoningEffortOption,
} from '../../src/shared/schemas/models'
import type {
  CodexProviderLease,
  ProviderRevisionInput,
} from './codex-provider-manager'
import { createScope } from '../effects/scope'
import { logger } from '../shared/logger'
import {
  ProviderTimeoutError,
  toTaggedProviderError,
} from './provider-errors'
import {
  buildPrompt,
  buildPromptAttachments,
  type PromptAttachment,
  type PromptContextBlock,
  type PromptSettings,
} from './prompt-builder'
import {
  TurnController,
  type TurnEventEnvelope,
  type TurnTerminalState,
} from './turn-controller'

const log = logger.child('conversation')

/** Initial attempt plus one stale-thread, one minimal-effort and one timeout retry. */
const MAX_TURN_ATTEMPTS = 4

/** How long a turn may produce no stream part at all before it is retried. */
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 60_000

export interface ConversationThreadStore {
  getThreadId(conversationId: string): Promise<string | null>
  setThreadId(conversationId: string, threadId: string | null): Promise<void>
}

export interface ConversationEventStore {
  append(event: TurnEventEnvelope): Promise<void>
}

export interface StartConversationTurnInput extends ProviderRevisionInput {
  conversationId: string
  /** Caller-supplied identity when routing must be registered before startup emits events. */
  turnId?: string
  modelId: string
  message: string
  context?: PromptContextBlock[]
  attachments?: PromptAttachment[]
  /** Resolved per-turn Codex reasoning effort; falls back to the provider default when omitted. */
  reasoningEffort?: string
  /** Assistant preferences that shape the developer instructions for this turn. */
  settings?: PromptSettings
}

export interface ConversationTurnHandle {
  turnId: string
  completion: Promise<TurnTerminalState>
  abort(reason?: string): Promise<boolean>
}

export interface ConversationProviderManager {
  getProvider(input: ProviderRevisionInput): Promise<CodexProviderLease>
  dispose(): Promise<void>
}

export interface ConversationRuntimeOptions {
  providers: ConversationProviderManager
  threads: ConversationThreadStore
  events: ConversationEventStore
  stream?: typeof streamText
  generateTurnId?: () => string
  now?: () => Date
  interruptTimeoutMs?: number
  /** First-token watchdog window; defaults to {@link DEFAULT_FIRST_TOKEN_TIMEOUT_MS}. */
  firstTokenTimeoutMs?: number
}

type EventListener = (event: TurnEventEnvelope) => void

interface ActiveTurn {
  controller: TurnController
}

export class ConversationRuntime {
  readonly #providers: ConversationProviderManager
  readonly #threads: ConversationThreadStore
  readonly #events: ConversationEventStore
  readonly #stream: typeof streamText
  readonly #generateTurnId: () => string
  readonly #now?: () => Date
  readonly #interruptTimeoutMs?: number
  readonly #firstTokenTimeoutMs: number
  readonly #listeners = new Set<EventListener>()
  readonly #activeByConversation = new Map<string, ActiveTurn>()
  readonly #activeByTurn = new Map<string, ActiveTurn>()
  readonly #startLocks = new Map<string, Promise<void>>()
  #nextGeneration = 0
  readonly #sessions = new Map<string, CodexAppServerSession>()
  readonly #persistedThreadIds = new Map<string, string | null>()
  /** Models that rejected 'minimal' effort once; later turns skip straight to 'low'. */
  readonly #minimalEffortUnsupported = new Set<string>()
  readonly #sessionCallbacks = new Map<
    string,
    (session: CodexAppServerSession) => Promise<void>
  >()

  constructor(options: ConversationRuntimeOptions) {
    this.#providers = options.providers
    this.#threads = options.threads
    this.#events = options.events
    this.#stream = options.stream ?? streamText
    this.#generateTurnId = options.generateTurnId ?? randomUUID
    this.#now = options.now
    this.#interruptTimeoutMs = options.interruptTimeoutMs
    this.#firstTokenTimeoutMs =
      options.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  startTurn(input: StartConversationTurnInput): Promise<ConversationTurnHandle> {
    return this.#withConversationLock(input.conversationId, async () => {
      const turnId = input.turnId ?? this.#generateTurnId()
      if (this.#activeByTurn.has(turnId)) {
        throw new Error(`Conversation turn ID is already active: ${turnId}`)
      }
      const previous = this.#activeByConversation.get(input.conversationId)
      if (previous) {
        await previous.controller.abort('Superseded by a new turn')
      }

      const generation = ++this.#nextGeneration
      const abortController = new AbortController()
      let resolveCompletion: (state: TurnTerminalState) => void = () => undefined
      const completion = new Promise<TurnTerminalState>((resolve) => {
        resolveCompletion = resolve
      })
      const controller = new TurnController({
        conversationId: input.conversationId,
        turnId,
        generation,
        abortController,
        onEvent: async (event) => {
          await this.#events.append(event)
          for (const listener of this.#listeners) {
            try {
              listener(event)
            } catch {
              // Subscribers are observational and cannot control turn execution.
            }
          }
        },
        onTerminal: resolveCompletion,
        onThreadId: async (threadId) => {
          if (!this.#isCurrent(input.conversationId, active)) {
            return
          }
          if (this.#persistedThreadIds.get(input.conversationId) !== threadId) {
            await this.#threads.setThreadId(input.conversationId, threadId)
            this.#persistedThreadIds.set(input.conversationId, threadId)
          }
          const session = this.#sessions.get(input.conversationId)
          if (session?.threadId === threadId) {
            controller.attachSession(session, generation)
          }
        },
        now: this.#now,
        interruptTimeoutMs: this.#interruptTimeoutMs,
      })
      const active: ActiveTurn = { controller }
      this.#activeByConversation.set(input.conversationId, active)
      this.#activeByTurn.set(turnId, active)

      try {
        await controller.start()
      } catch (error) {
        await controller.failed(error).catch(() => false)
        this.#activeByConversation.delete(input.conversationId)
        this.#activeByTurn.delete(turnId)
        throw error
      }

      void this.#runTurn(input, active, abortController)
        .catch(() => undefined)
        .finally(() => {
          if (this.#activeByConversation.get(input.conversationId) === active) {
            this.#activeByConversation.delete(input.conversationId)
          }
          this.#activeByTurn.delete(turnId)
        })

      return {
        turnId,
        completion,
        abort: (reason) => controller.abort(reason),
      }
    })
  }

  async abortTurn(turnId: string, reason?: string): Promise<boolean> {
    return (await this.#activeByTurn.get(turnId)?.controller.abort(reason)) ?? false
  }

  /** Lists the models the current Codex provider exposes, normalized for the renderer. */
  async listModels(input: ProviderRevisionInput): Promise<ModelOption[]> {
    const lease = await this.#providers.getProvider(input)
    try {
      const result = await lease.provider.listModels()
      const models = Array.isArray(result?.models) ? result.models : []
      return models
        .map((model) => normalizeModelOption(model))
        .filter((model): model is ModelOption => model !== null)
    } finally {
      await lease.release()
    }
  }

  /**
   * Starts and initializes the shared app-server process before the first turn.
   * The provider keeps its current client alive after this short lease is
   * released, so later threads avoid the process/handshake cold start.
   */
  async warm(input: ProviderRevisionInput): Promise<void> {
    const lease = await this.#providers.getProvider(input)
    try {
      await lease.provider.listModels()
    } finally {
      await lease.release()
    }
  }

  /** Confirms the Codex provider can be created and answer a lightweight request. */
  async testConnection(input: ProviderRevisionInput): Promise<ConnectionTestResult> {
    try {
      const lease = await this.#providers.getProvider(input)
      try {
        await lease.provider.listModels().catch((): undefined => undefined)
        return { success: true }
      } finally {
        await lease.release()
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#activeByTurn.values()].map((turn) =>
        turn.controller.abort('Conversation runtime disposed'),
      ),
    )
    this.#activeByConversation.clear()
    this.#activeByTurn.clear()
    this.#startLocks.clear()
    await this.#providers.dispose()
    this.#listeners.clear()
    this.#sessions.clear()
    this.#persistedThreadIds.clear()
    this.#sessionCallbacks.clear()
  }

  async #runTurn(
    input: StartConversationTurnInput,
    active: ActiveTurn,
    abortController: AbortController,
  ): Promise<void> {
    let lease: CodexProviderLease | null = null
    try {
      const resolved = await Promise.all([
        this.#providers.getProvider(input),
        this.#threads.getThreadId(input.conversationId),
      ])
      lease = resolved[0]
      let existingThreadId = resolved[1]
      this.#persistedThreadIds.set(input.conversationId, existingThreadId)
      const attachmentParts = buildPromptAttachments(input.attachments)
      const existingSession = this.#sessions.get(input.conversationId)
      if (existingThreadId && existingSession?.threadId === existingThreadId) {
        active.controller.attachSession(
          existingSession,
          active.controller.generation,
        )
      }
      if (!this.#isCurrent(input.conversationId, active)) {
        return
      }

      const built = buildPrompt(input)
      let effort = input.reasoningEffort as ReasoningEffort | undefined
      if (effort === 'minimal' && this.#minimalEffortUnsupported.has(input.modelId)) {
        effort = 'low'
      }
      let staleRetried = false
      let minimalEffortRetried = false
      let firstTokenRetried = false
      // At most four attempts: initial, one stale-thread retry, one minimal→low
      // effort retry, one first-token-timeout retry. Every iteration returns,
      // continues on a retry, or throws.
      for (let attempt = 0; attempt < MAX_TURN_ATTEMPTS; attempt += 1) {
        // Per-attempt abort so the watchdog can end a silent attempt without
        // cancelling the turn; a real turn abort is forwarded into it.
        const attemptScope = createScope({ label: `turn-attempt:${active.controller.generation}` })
        const attemptAbort = new AbortController()
        let timedOut: ProviderTimeoutError | null = null
        try {
          if (abortController.signal.aborted) {
            attemptAbort.abort(abortController.signal.reason)
          }
          const forwardAbort = () => attemptAbort.abort(abortController.signal.reason)
          abortController.signal.addEventListener('abort', forwardAbort, { once: true })
          attemptScope.defer(() =>
            abortController.signal.removeEventListener('abort', forwardAbort),
          )
          const watchdog = setTimeout(() => {
            timedOut = new ProviderTimeoutError(
              `Codex produced no output within ${this.#firstTokenTimeoutMs}ms.`,
            )
            attemptAbort.abort(timedOut)
          }, this.#firstTokenTimeoutMs)
          attemptScope.defer(() => clearTimeout(watchdog))

          // Keep model-construction settings stable per conversation. In
          // persistent mode the provider then reuses one language-model/session
          // wrapper while all wrappers share the provider's single RPC client.
          const model = lease.provider(input.modelId, {
            onSessionCreated: this.#getSessionCallback(input.conversationId),
          }) as LanguageModel
          const providerOptions = {
            ...(existingThreadId ? { resume: existingThreadId } : {}),
            ...(effort ? { effort } : {}),
            developerInstructions: built.developerInstructions,
            configOverrides: {
              'tools.web_search': input.webSearch ?? false,
              'tools.image_generation': false,
            },
          } satisfies CodexAppServerProviderOptions
          const result = this.#stream({
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: built.prompt },
                  ...attachmentParts,
                ],
              },
            ],
            maxRetries: 0,
            abortSignal: attemptAbort.signal,
            providerOptions: {
              'codex-app-server': providerOptions as unknown as Record<string, JSONValue>,
            },
          })

          for await (const part of result.stream) {
            clearTimeout(watchdog)
            if (!this.#isCurrent(input.conversationId, active)) {
              break
            }
            await active.controller.accept(part, active.controller.generation)
          }

          if (this.#isCurrent(input.conversationId, active)) {
            const finishReason = await result.finishReason
            await active.controller.completed(finishReason)
          }
          return
        } catch (rawError) {
          // The watchdog aborts the attempt, so the stream reports a generic
          // abort; the recorded timeout is the accurate cause.
          const error = toTaggedProviderError(timedOut ?? rawError)
          switch (error._tag) {
            case 'StaleThreadError':
              if (!staleRetried && existingThreadId) {
                staleRetried = true
                existingThreadId = null
                this.#sessions.delete(input.conversationId)
                await this.#threads.setThreadId(input.conversationId, null)
                this.#persistedThreadIds.set(input.conversationId, null)
                continue
              }
              break
            case 'MinimalEffortUnsupportedError':
              // Some models reject 'minimal' reasoning effort when tools are
              // active. Retry once at 'low' effort, matching legacy behavior.
              if (!minimalEffortRetried && effort === 'minimal') {
                minimalEffortRetried = true
                effort = 'low'
                // Remember it so later turns on this model don't pay the
                // rejected round trip again.
                this.#minimalEffortUnsupported.add(input.modelId)
                continue
              }
              break
            case 'ProviderTimeoutError':
              if (!firstTokenRetried && !abortController.signal.aborted) {
                firstTokenRetried = true
                log.warn('no first token before the watchdog fired; retrying the turn', {
                  conversationId: input.conversationId,
                  modelId: input.modelId,
                  firstTokenTimeoutMs: this.#firstTokenTimeoutMs,
                })
                continue
              }
              break
            case 'ProviderRequestError':
              break
          }
          throw error
        } finally {
          await attemptScope.close('attempt finished')
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        await active.controller
          .interrupted(errorMessage(abortController.signal.reason))
          .catch(() => false)
      } else if (this.#isCurrent(input.conversationId, active)) {
        await active.controller.failed(error).catch(() => false)
      }
    } finally {
      await lease?.release()
    }
  }

  #getSessionCallback(
    conversationId: string,
  ): (session: CodexAppServerSession) => Promise<void> {
    const existing = this.#sessionCallbacks.get(conversationId)
    if (existing) {
      return existing
    }
    const callback = async (session: CodexAppServerSession) => {
      this.#sessions.set(conversationId, session)
      const active = this.#activeByConversation.get(conversationId)
      if (!active) {
        return
      }
      active.controller.attachSession(session, active.controller.generation)
      if (this.#persistedThreadIds.get(conversationId) === session.threadId) {
        return
      }
      await this.#threads.setThreadId(conversationId, session.threadId)
      this.#persistedThreadIds.set(conversationId, session.threadId)
    }
    this.#sessionCallbacks.set(conversationId, callback)
    return callback
  }

  #isCurrent(conversationId: string, active: ActiveTurn): boolean {
    return this.#activeByConversation.get(conversationId) === active
  }

  async #withConversationLock<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#startLocks.get(conversationId) ?? Promise.resolve()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = previous.then(() => gate)
    this.#startLocks.set(conversationId, current)
    await previous
    try {
      return await operation()
    } finally {
      release?.()
      if (this.#startLocks.get(conversationId) === current) {
        this.#startLocks.delete(conversationId)
      }
    }
  }
}

function normalizeModelOption(model: Record<string, unknown>): ModelOption | null {
  const id = String(model.id ?? model.model ?? '').trim()
  if (!id) {
    return null
  }
  const inputModalities = Array.isArray(model.inputModalities)
    ? model.inputModalities.map((modality) => String(modality)).filter(Boolean)
    : ['text', 'image']
  const supportedReasoningEfforts: ReasoningEffortOption[] = Array.isArray(
    model.supportedReasoningEfforts,
  )
    ? model.supportedReasoningEfforts
        .map((effort): ReasoningEffortOption => {
          const record =
            effort !== null && typeof effort === 'object'
              ? (effort as Record<string, unknown>)
              : {}
          return {
            reasoningEffort: String(
              record.reasoningEffort ?? record.id ?? effort ?? '',
            ).trim(),
            ...(typeof record.description === 'string'
              ? { description: record.description }
              : {}),
          }
        })
        .filter((effort) => effort.reasoningEffort)
    : []
  const displayName = String(
    model.displayName ?? model.name ?? model.model ?? id,
  ).trim()

  return {
    id,
    displayName: displayName || id,
    supportedReasoningEfforts,
    inputModalities,
    isDefault: Boolean(model.isDefault),
    hidden: Boolean(model.hidden),
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? 'Turn cancelled')
}
