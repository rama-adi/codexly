import type { CodexAppServerSession } from 'ai-sdk-provider-codex-cli'

import { withTimeout } from '../effects/with-timeout'
import {
  normalizeCodexEvent,
  type NormalizedCodexEvent,
} from './codex-event-normalizer'

export type TurnTerminalState = 'completed' | 'interrupted' | 'failed'
export type TurnLifecycleState = 'created' | 'running' | 'interrupting' | TurnTerminalState

export interface TurnEventEnvelope {
  conversationId: string
  turnId: string
  sequence: number
  occurredAt: string
  event:
    | { type: 'turn.started' }
    | NormalizedCodexEvent
    | { type: 'turn.completed'; finishReason?: string }
    | { type: 'turn.interrupted'; reason?: string }
    | { type: 'turn.failed'; message: string }
}

export interface TurnControllerOptions {
  conversationId: string
  turnId: string
  generation: number
  abortController: AbortController
  onEvent: (event: TurnEventEnvelope) => void | Promise<void>
  onThreadId?: (threadId: string) => void | Promise<void>
  onTerminal?: (state: TurnTerminalState) => void
  now?: () => Date
  interruptTimeoutMs?: number
}

export class TurnController {
  readonly #conversationId: string
  readonly #turnId: string
  readonly #generation: number
  readonly #abortController: AbortController
  readonly #onEvent: TurnControllerOptions['onEvent']
  readonly #onThreadId?: TurnControllerOptions['onThreadId']
  readonly #onTerminal?: TurnControllerOptions['onTerminal']
  readonly #now: () => Date
  readonly #interruptTimeoutMs: number
  readonly #activityEvents = new Set<string>()
  readonly #approvalEvents = new Set<string>()
  #sequence = 0
  #state: TurnLifecycleState = 'created'
  #session: CodexAppServerSession | null = null

  constructor(options: TurnControllerOptions) {
    this.#conversationId = options.conversationId
    this.#turnId = options.turnId
    this.#generation = options.generation
    this.#abortController = options.abortController
    this.#onEvent = options.onEvent
    this.#onThreadId = options.onThreadId
    this.#onTerminal = options.onTerminal
    this.#now = options.now ?? (() => new Date())
    this.#interruptTimeoutMs = options.interruptTimeoutMs ?? 5_000
  }

  get state(): TurnLifecycleState {
    return this.#state
  }

  get generation(): number {
    return this.#generation
  }

  async start(): Promise<void> {
    if (this.#state !== 'created') {
      return
    }
    this.#state = 'running'
    await this.#emit({ type: 'turn.started' })
  }

  attachSession(session: CodexAppServerSession, generation: number): void {
    if (!this.#isCurrent(generation) || this.#isTerminal()) {
      return
    }
    this.#session = session
  }

  async accept(part: { type: string; [key: string]: unknown }, generation: number) {
    if (!this.#isCurrent(generation) || this.#isTerminal()) {
      return
    }

    for (const event of normalizeCodexEvent(part)) {
      if (this.#isTerminal()) {
        return
      }
      if (this.#isDuplicate(event)) {
        continue
      }
      if (event.type === 'thread.discovered') {
        await this.#onThreadId?.(event.threadId)
      }
      if (event.type === 'provider.turn-completed') {
        if (event.status === 'interrupted') {
          await this.interrupted('Codex interrupted the turn')
        } else if (event.status === 'failed') {
          await this.failed(event.error ?? 'Codex failed the turn')
        }
        continue
      }
      await this.#emit(event)
    }
  }

  async completed(finishReason?: string): Promise<boolean> {
    return this.#terminal('completed', {
      type: 'turn.completed',
      ...(finishReason ? { finishReason } : {}),
    })
  }

  async failed(error: unknown): Promise<boolean> {
    return this.#terminal('failed', {
      type: 'turn.failed',
      message: errorMessage(error),
    })
  }

  async interrupted(reason?: string): Promise<boolean> {
    return this.#terminal('interrupted', {
      type: 'turn.interrupted',
      ...(reason ? { reason } : {}),
    })
  }

  async abort(reason = 'Turn cancelled'): Promise<boolean> {
    if (this.#isTerminal()) {
      return false
    }

    // Claim the terminal state before awaiting the provider interrupt so a late
    // stream completion cannot win the compare-and-set race.
    this.#state = 'interrupted'
    this.#onTerminal?.('interrupted')
    this.#abortController.abort(new Error(reason))
    const session = this.#session
    if (session?.isActive()) {
      // A provider interrupt that hangs or fails must not hold up the abort:
      // the terminal state is already claimed above.
      await withTimeout(
        session.interrupt().catch(() => undefined),
        this.#interruptTimeoutMs,
        () => undefined,
      )
    }
    await this.#emit({ type: 'turn.interrupted', reason })
    return true
  }

  async #terminal(
    next: TurnTerminalState,
    event: TurnEventEnvelope['event'],
  ): Promise<boolean> {
    if (this.#isTerminal()) {
      return false
    }
    this.#state = next
    this.#onTerminal?.(next)
    await this.#emit(event)
    return true
  }

  #isDuplicate(event: NormalizedCodexEvent): boolean {
    if (event.type === 'activity.started' || event.type === 'activity.completed') {
      const key = `${event.type}:${event.activity.id}`
      if (this.#activityEvents.has(key)) {
        return true
      }
      this.#activityEvents.add(key)
    }
    if (event.type === 'approval.requested') {
      const key = event.requestId ?? `${event.requestType}:${JSON.stringify(event.details)}`
      if (this.#approvalEvents.has(key)) {
        return true
      }
      this.#approvalEvents.add(key)
    }
    return false
  }

  #isCurrent(generation: number): boolean {
    return generation === this.#generation
  }

  #isTerminal(): boolean {
    return (
      this.#state === 'completed' ||
      this.#state === 'interrupted' ||
      this.#state === 'failed'
    )
  }

  async #emit(event: TurnEventEnvelope['event']): Promise<void> {
    this.#sequence += 1
    await this.#onEvent({
      conversationId: this.#conversationId,
      turnId: this.#turnId,
      sequence: this.#sequence,
      occurredAt: this.#now().toISOString(),
      event,
    })
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
