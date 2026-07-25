import type { SerializedError } from '../errors/serialized-error'
import { CONTRACT_VERSION, type JsonObject } from '../schemas/common'
import { type Session, SessionSchema, type SessionState } from '../schemas/sessions'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'
import { makeSerializedError } from './errors'

/** Flat union of every field any session variant carries. */
export type SessionOverrides = Partial<{
  version: typeof CONTRACT_VERSION
  id: string
  conversationId: string
  createdAt: string
  extensions: JsonObject
  state: SessionState
  startedAt: string
  stoppingAt: string
  endedAt: string
  reason: 'cancelled' | 'completed' | 'signed_out' | 'window_closed'
  failedAt: string
  error: SerializedError
}>

export function makeSession(
  overrides: SessionOverrides = {},
  context: FixtureContext = createFixtureContext(),
): Session {
  const state = overrides.state ?? 'active'
  const createdAt = overrides.createdAt ?? context.nextTimestamp()
  const base = {
    version: CONTRACT_VERSION,
    id: context.nextId('session'),
    conversationId: context.nextId('conversation'),
    createdAt,
  }
  const variant = ((): object => {
    switch (state) {
      case 'starting':
        return { state }
      case 'active':
        return { state, startedAt: context.nextTimestamp() }
      case 'stopping':
        return { state, startedAt: context.nextTimestamp(), stoppingAt: context.nextTimestamp() }
      case 'ended':
        return {
          state,
          startedAt: context.nextTimestamp(),
          endedAt: context.nextTimestamp(),
          reason: 'completed',
        }
      case 'error':
        return {
          state,
          failedAt: context.nextTimestamp(),
          error: makeSerializedError({}, context),
        }
    }
  })()
  return SessionSchema.parse(mergeDefined({ ...base, ...variant }, overrides))
}
