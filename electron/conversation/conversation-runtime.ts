import { streamText, type LanguageModel } from 'ai'
import type { CodexAppServerSession } from 'ai-sdk-provider-codex-cli'
import { randomUUID } from 'node:crypto'

import type {
  CodexProviderLease,
  ProviderRevisionInput,
} from './codex-provider-manager'
import {
  buildPrompt,
  buildPromptAttachments,
  type PromptAttachment,
  type PromptContextBlock,
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
          await this.#threads.setThreadId(input.conversationId, threadId)
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

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#activeByTurn.values()].map((turn) =>
        turn.controller.abort('Conversation runtime disposed'),
      ),
    )
    await this.#providers.dispose()
    this.#listeners.clear()
    this.#sessions.clear()
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
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const model = lease.provider(input.modelId, {
            ...(existingThreadId ? { resume: existingThreadId } : {}),
            developerInstructions: built.developerInstructions,
            onSessionCreated: this.#getSessionCallback(input.conversationId),
          }) as LanguageModel
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
            include: { rawChunks: true },
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
          if (attempt === 0 && existingThreadId && isStaleThreadError(error)) {
            existingThreadId = null
            this.#sessions.delete(input.conversationId)
            await this.#threads.setThreadId(input.conversationId, null)
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
      await this.#threads.setThreadId(conversationId, session.threadId)
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
  return /thread ['"]?.+['"]? not found/i.test(errorMessage(value))
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? 'Turn cancelled')
}
