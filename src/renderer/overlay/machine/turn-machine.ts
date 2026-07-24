import { matchTurnScope, type TurnScope } from '../stream-state'

/**
 * The overlay's turn lifecycle, modeled as a pure state machine.
 *
 * The overlay reconciles THREE independent async sources that race to define a
 * single Codex turn's identity, while the user can preempt at any moment:
 *
 *   1. the optimistic local request (created before the IPC command resolves),
 *   2. the IPC command result (`commandSettled` / `commandFailed`),
 *   3. the event stream (`started`, `streamEvent`, `terminal`).
 *
 * `reduceTurn` is the single authority for every transition. It is pure: side
 * effects (stopping a conflicting turn, surfacing an error) are RETURNED as
 * {@link TurnEffect} descriptors for the caller to interpret. This is what makes
 * the machine exhaustively chaos-testable — feed it any adversarial ordering of
 * inputs and assert on the resulting state + effects without touching IPC.
 */

export type TurnKind = 'solve' | 'chat'

/**
 * `idle`   – no active request (may still remember retired turn ids).
 * `active` – a request is in flight; the UI shows it as streaming/busy.
 *
 * Orthogonal facts (`commandSettled`, `terminal`, `dismissed`, `stopInFlight`)
 * are tracked as flags because they genuinely vary independently of the phase.
 */
export type TurnPhase = 'idle' | 'active'

export interface TurnState {
  readonly phase: TurnPhase
  readonly kind: TurnKind | null
  readonly scope: TurnScope
  /** The IPC command (solve/send) has resolved and matched this request. */
  readonly commandSettled: boolean
  /** A terminal transcript event (complete/failed) has arrived for this turn. */
  readonly terminal: boolean
  /** The user has preempted this request (dismiss / stop / re-summon). */
  readonly dismissed: boolean
  /** A stopTurn effect has been emitted and not yet resolved. */
  readonly stopInFlight: boolean
  /**
   * Turn ids that completed, failed, or were force-stopped. Late events for
   * these ids are dropped, and they can never spawn a fresh request. Bounded so
   * a long-lived overlay never grows this set without bound.
   */
  readonly ignoredTurnIds: readonly string[]
}

export const MAX_IGNORED_TURN_IDS = 64

export const IDLE_TURN: TurnState = {
  phase: 'idle',
  kind: null,
  scope: {},
  commandSettled: false,
  terminal: false,
  dismissed: false,
  stopInFlight: false,
  ignoredTurnIds: [],
}

export type TurnInput =
  /** The user (or an auto-answer) initiated a turn locally. */
  | { type: 'initiate'; kind: TurnKind; sessionId?: string }
  /** The IPC solve/send command resolved with the authoritative identity. */
  | { type: 'commandSettled'; sessionId: string; turnId: string }
  /** The IPC solve/send command rejected. */
  | { type: 'commandFailed' }
  /** A `conversation.started` event arrived (kind used only if starting fresh). */
  | { type: 'started'; kind: TurnKind; sessionId: string; turnId: string }
  /** A delta/reasoning/tool event arrived; used only to gate by scope. */
  | { type: 'streamEvent'; sessionId: string; turnId: string }
  /** A terminal transcript event arrived. */
  | { type: 'terminal'; sessionId: string; turnId: string; outcome: 'complete' | 'failed' }
  /** The user dismissed the solution / stopped the chat. */
  | { type: 'dismiss' }
  /** A previously-emitted stopTurn effect resolved. */
  | { type: 'stopSettled'; ok: boolean }
  /** The overlay was re-summoned or switched sessions. */
  | { type: 'overlayReset' }

export type TurnEffect =
  | { type: 'stopTurn'; turnId: string }
  | { type: 'reportError'; message: string }

export interface TurnResult {
  readonly state: TurnState
  readonly effects: readonly TurnEffect[]
  /**
   * For `streamEvent`/`terminal`: whether the event belongs to the active turn
   * and the caller should apply it (append transcript, flush, etc.).
   */
  readonly accepted: boolean
  /**
   * True when this input began a brand-new request (local `initiate`, or a fresh
   * externally-`started` turn) so the caller can clear transcript/activities.
   */
  readonly freshStart: boolean
}

function retire(ignored: readonly string[], turnId: string): readonly string[] {
  if (ignored.includes(turnId)) return ignored
  const next = [...ignored, turnId]
  return next.length > MAX_IGNORED_TURN_IDS
    ? next.slice(next.length - MAX_IGNORED_TURN_IDS)
    : next
}

function idleWith(ignored: readonly string[]): TurnState {
  return { ...IDLE_TURN, ignoredTurnIds: ignored }
}

function result(
  state: TurnState,
  extra?: Partial<Pick<TurnResult, 'effects' | 'accepted' | 'freshStart'>>,
): TurnResult {
  return {
    state,
    effects: extra?.effects ?? [],
    accepted: extra?.accepted ?? false,
    freshStart: extra?.freshStart ?? false,
  }
}

/** The single, pure transition function for the overlay turn lifecycle. */
export function reduceTurn(state: TurnState, input: TurnInput): TurnResult {
  switch (input.type) {
    case 'initiate': {
      // A request is already in flight — ignore (the UI guards double-submit).
      if (state.phase === 'active') return result(state)
      return result(
        {
          ...idleWith(state.ignoredTurnIds),
          phase: 'active',
          kind: input.kind,
          scope: input.sessionId ? { sessionId: input.sessionId } : {},
        },
        { freshStart: true },
      )
    }

    case 'started': {
      if (state.phase === 'idle') {
        // An externally-started turn (e.g. the solve global shortcut). Ignore a
        // late event for an already-retired turn so it cannot resurrect a
        // request.
        if (state.ignoredTurnIds.includes(input.turnId)) return result(state)
        return result(
          {
            ...idleWith(state.ignoredTurnIds),
            phase: 'active',
            kind: input.kind,
            scope: { sessionId: input.sessionId, turnId: input.turnId },
            commandSettled: true,
          },
          { accepted: true, freshStart: true },
        )
      }
      const scope = matchTurnScope(state.scope, input)
      if (!scope) return result(state)
      const next = { ...state, scope }
      if (state.dismissed && !state.stopInFlight) {
        return result(
          { ...next, stopInFlight: true },
          { effects: [{ type: 'stopTurn', turnId: input.turnId }], accepted: true },
        )
      }
      return result(next, { accepted: true })
    }

    case 'commandSettled': {
      if (state.phase === 'idle') return result(state)
      const scope = matchTurnScope(state.scope, input)
      if (!scope) {
        // The command returned an identity we cannot reconcile with what the
        // event stream already latched — stop the conflicting turn and reset.
        return result(idleWith(retire(state.ignoredTurnIds, input.turnId)), {
          effects: [
            { type: 'stopTurn', turnId: input.turnId },
            {
              type: 'reportError',
              message: 'The response identity changed while streaming. The conflicting turn was stopped.',
            },
          ],
        })
      }
      const settled = { ...state, scope, commandSettled: true }
      if (state.dismissed) {
        if (state.stopInFlight) return result(settled)
        return result(
          { ...settled, stopInFlight: true },
          { effects: [{ type: 'stopTurn', turnId: input.turnId }] },
        )
      }
      if (state.terminal) {
        return result(idleWith(retire(state.ignoredTurnIds, scope.turnId ?? input.turnId)))
      }
      return result(settled)
    }

    case 'commandFailed': {
      if (state.phase === 'idle') return result(state)
      // The action layer restores its own UI (chat input, error text). The
      // machine simply ends the lifecycle.
      return result(idleWith(state.ignoredTurnIds))
    }

    case 'streamEvent': {
      if (state.phase === 'idle') return result(state)
      if (state.ignoredTurnIds.includes(input.turnId)) return result(state)
      const scope = matchTurnScope(state.scope, input)
      if (!scope) return result(state)
      return result({ ...state, scope }, { accepted: true })
    }

    case 'terminal': {
      if (state.phase === 'idle') return result(state)
      if (state.ignoredTurnIds.includes(input.turnId)) return result(state)
      const scope = matchTurnScope(state.scope, input)
      if (!scope) return result(state)
      const ignored = retire(state.ignoredTurnIds, input.turnId)
      // A terminal event fully reconciles once the command has also settled;
      // otherwise we keep the request alive so `commandSettled` can finish it.
      if (state.commandSettled) {
        return result(idleWith(ignored), { accepted: true })
      }
      return result(
        { ...state, scope, terminal: true, ignoredTurnIds: ignored },
        { accepted: true },
      )
    }

    case 'dismiss': {
      if (state.phase === 'idle') return result(state)
      const dismissed = { ...state, dismissed: true }
      if (state.terminal) {
        return state.commandSettled
          ? result(idleWith(state.ignoredTurnIds))
          : result(dismissed)
      }
      if (state.scope.turnId && !state.stopInFlight) {
        return result(
          { ...dismissed, stopInFlight: true },
          { effects: [{ type: 'stopTurn', turnId: state.scope.turnId }] },
        )
      }
      // No turnId yet: `started`/`commandSettled` will issue the stop later.
      return result(dismissed)
    }

    case 'stopSettled': {
      if (state.phase === 'idle') return result(state)
      const cleared = { ...state, stopInFlight: false }
      if (input.ok) {
        const ignored = state.scope.turnId
          ? retire(state.ignoredTurnIds, state.scope.turnId)
          : state.ignoredTurnIds
        return result(idleWith(ignored))
      }
      // The turn could not be stopped and is still running. If it never reached
      // a terminal state, revive it so the user still sees the stream. Surfacing
      // the failure message is the store's job — it holds the real transport
      // error — so the machine only revives the state here.
      if (state.terminal) {
        return state.commandSettled
          ? result(idleWith(state.ignoredTurnIds))
          : result(cleared)
      }
      return result({ ...cleared, dismissed: false })
    }

    case 'overlayReset': {
      if (state.phase === 'idle') return result(idleWith(state.ignoredTurnIds))
      const turnId = state.scope.turnId
      const ignored = turnId ? retire(state.ignoredTurnIds, turnId) : state.ignoredTurnIds
      return result(idleWith(ignored), {
        effects: turnId ? [{ type: 'stopTurn', turnId }] : [],
      })
    }
  }
}

// --- selectors: derive the flat UI flags the components consume -------------

export const isActive = (s: TurnState): boolean => s.phase === 'active'
/** The stream indicator: a request is running and has not terminated. */
export const isStreaming = (s: TurnState): boolean => s.phase === 'active' && !s.terminal
/** The command is in flight / the overlay is working. */
export const isBusy = (s: TurnState): boolean => s.phase === 'active'
/**
 * The active turn id while it can still be stopped — known, not terminal, and
 * not already being dismissed/stopped. Drives the Stop control.
 */
export const activeTurnId = (s: TurnState): string | undefined =>
  s.phase === 'active' && !s.terminal && !s.dismissed ? s.scope.turnId : undefined
export const canStop = (s: TurnState): boolean => activeTurnId(s) !== undefined
