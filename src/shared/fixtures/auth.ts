import type { SerializedError } from '../errors/serialized-error'
import {
  type AuthStatus,
  AuthStatusSchema,
  type AuthUser,
  AuthUserSchema,
} from '../schemas/auth'
import { CONTRACT_VERSION, type JsonObject } from '../schemas/common'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'
import { makeSerializedError } from './errors'

export type AuthUserOverrides = Partial<AuthUser>

export function makeAuthUser(
  overrides: AuthUserOverrides = {},
  context: FixtureContext = createFixtureContext(),
): AuthUser {
  const base: AuthUser = {
    id: context.nextId('user'),
    displayName: 'Fixture User',
  }
  return AuthUserSchema.parse(mergeDefined(base, overrides))
}

export type AuthStatusOverrides = Partial<{
  version: typeof CONTRACT_VERSION
  extensions: JsonObject
  state: AuthStatus['state']
  reason: 'signed_out' | 'expired' | 'revoked'
  startedAt: string
  user: AuthUser
  authenticatedAt: string
  expiresAt: string
  error: SerializedError
}>

export function makeAuthStatus(
  overrides: AuthStatusOverrides = {},
  context: FixtureContext = createFixtureContext(),
): AuthStatus {
  const state = overrides.state ?? 'authenticated'
  const variant = ((): object => {
    switch (state) {
      case 'unauthenticated':
        return { state }
      case 'authenticating':
        return { state, startedAt: context.nextTimestamp() }
      case 'authenticated':
        return {
          state,
          user: makeAuthUser({}, context),
          authenticatedAt: context.nextTimestamp(),
        }
      case 'error':
        return { state, error: makeSerializedError({}, context) }
    }
  })()
  return AuthStatusSchema.parse(
    mergeDefined({ version: CONTRACT_VERSION, ...variant }, overrides),
  )
}
