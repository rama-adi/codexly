import { describe, expect, it } from 'vitest'

import { matchTurnScope } from './stream-state'

describe('matchTurnScope', () => {
  it('latches identifiers when events beat the command response', () => {
    expect(matchTurnScope({}, { sessionId: 'session-1', turnId: 'turn-1' })).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
    })
  })

  it('rejects events from another session or turn', () => {
    const scope = { sessionId: 'session-1', turnId: 'turn-1' }

    expect(matchTurnScope(scope, { sessionId: 'session-2', turnId: 'turn-1' })).toBeUndefined()
    expect(matchTurnScope(scope, { sessionId: 'session-1', turnId: 'turn-2' })).toBeUndefined()
  })

  it('rejects events when the overlay has no pending turn', () => {
    expect(matchTurnScope(undefined, { sessionId: 'session-1', turnId: 'turn-1' })).toBeUndefined()
  })
})

