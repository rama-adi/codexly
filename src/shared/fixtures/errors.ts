import { type SerializedError, SerializedErrorSchema } from '../errors/serialized-error'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'

export type SerializedErrorOverrides = Partial<SerializedError>

export function makeSerializedError(
  overrides: SerializedErrorOverrides = {},
  context: FixtureContext = createFixtureContext(),
): SerializedError {
  const base: SerializedError = {
    version: 1,
    code: 'unavailable',
    message: `fixture failure ${context.nextId('error')}`,
    retryable: true,
  }
  return SerializedErrorSchema.parse(mergeDefined(base, overrides))
}
