export type TurnScope = {
  sessionId?: string
  turnId?: string
}

/**
 * Match a transcript event to the turn currently owned by the overlay. Missing
 * identifiers are latched from the first event because the bridge can start
 * streaming before the command promise resolves.
 */
export function matchTurnScope(
  scope: TurnScope | undefined,
  event: { sessionId: string; turnId: string },
): TurnScope | undefined {
  if (!scope) return undefined
  if (scope.sessionId && scope.sessionId !== event.sessionId) return undefined
  if (scope.turnId && scope.turnId !== event.turnId) return undefined

  return {
    sessionId: scope.sessionId ?? event.sessionId,
    turnId: scope.turnId ?? event.turnId,
  }
}

