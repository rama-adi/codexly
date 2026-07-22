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

export interface ConversationThreadStore {
  getThreadId(conversationId: string): Promise<string | null>
  setThreadId(conversationId: string, threadId: string | null): Promise<void>
}

export interface ConversationEventStore {
  append(event: TurnEventEnvelope): Promise<void>
}

export interface StartConversationTurnInput extends ProviderRevisionInput {
  conversationId: string
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
  readonly #listeners = new Set<EventListener>()
  readonly #activeByConversation = new Map<string, ActiveTurn>()
  readonly #activeByTurn = new Map<string, ActiveTurn>()
  readonly #startLocks = new Map<string, Promise<void>>()
  #nextGeneration = 0
  readonly #sessions = new Map<string, CodexAppServerSession>()
  readonly #persistedThreadIds = new Map<string, string | null>()
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
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  startTurn(input: StartConversationTurnInput): Promise<ConversationTurnHandle> {
    return this.#withConversationLock(input.conversationId, async () => {
      const previous = this.#activeByConversation.get(input.conversationId)
      if (previous) {
        await previous.controller.abort('Superseded by a new turn')
      }

      const generation = ++this.#nextGeneration
      const turnId = this.#generateTurnId()
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
      let staleRetried = false
      let minimalEffortRetried = false
      // At most three attempts: initial, one stale-thread retry, one minimal→low
      // effort retry. Every iteration returns, continues on a retry, or throws.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
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
            abortSignal: abortController.signal,
            providerOptions: {
              'codex-app-server': providerOptions as unknown as Record<string, JSONValue>,
            },
          })

          for await (const part of result.stream) {
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
        } catch (error) {
          if (!staleRetried && existingThreadId && isStaleThreadError(error)) {
            staleRetried = true
            existingThreadId = null
            this.#sessions.delete(input.conversationId)
            await this.#threads.setThreadId(input.conversationId, null)
            this.#persistedThreadIds.set(input.conversationId, null)
            continue
          }
          // Some models reject 'minimal' reasoning effort when tools are active.
          // Retry once at 'low' effort, matching the legacy behavior.
          if (
            !minimalEffortRetried &&
            effort === 'minimal' &&
            isMinimalToolIncompatibilityError(error)
          ) {
            minimalEffortRetried = true
            effort = 'low'
            continue
          }
          throw error
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

function isStaleThreadError(value: unknown): boolean {
  // Codex has phrased this differently across releases:
  //   "thread '<id>' not found"  (≤0.13x)
  //   "no rollout found for thread id <id>"  (0.14x)
  return /thread ['"]?.+['"]? not found|no rollout found for thread/i.test(errorMessage(value))
}

function isMinimalToolIncompatibilityError(value: unknown): boolean {
  return /reasoning\.effort ['"]minimal['"]|cannot be used with reasoning\.effort/i.test(
    errorMessage(value),
  )
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
