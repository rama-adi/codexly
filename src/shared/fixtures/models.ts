import {
  type ConnectionTestResult,
  ConnectionTestResultSchema,
  type ModelOption,
  ModelOptionSchema,
  ModelOptionsSchema,
  type ReasoningEffortOption,
} from '../schemas/models'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'

const REASONING_EFFORTS: readonly ReasoningEffortOption[] = [
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
]

export type ModelOptionOverrides = Partial<ModelOption>

export function makeModelOption(
  overrides: ModelOptionOverrides = {},
  context: FixtureContext = createFixtureContext(),
): ModelOption {
  const id = overrides.id ?? context.nextId('model')
  const base: ModelOption = {
    id,
    displayName: `Model ${id}`,
    supportedReasoningEfforts: [...REASONING_EFFORTS],
    inputModalities: ['text', 'image'],
    isDefault: false,
    hidden: false,
  }
  return ModelOptionSchema.parse(mergeDefined(base, overrides))
}

/** A default-first list, mirroring the order the runtime surfaces models in. */
export function makeModelOptions(
  overrides: readonly ModelOptionOverrides[] = [{ isDefault: true }, {}],
  context: FixtureContext = createFixtureContext(),
): ModelOption[] {
  return ModelOptionsSchema.parse(overrides.map((entry) => makeModelOption(entry, context)))
}

export function makeConnectionTestResult(
  overrides: Partial<ConnectionTestResult> = {},
): ConnectionTestResult {
  return ConnectionTestResultSchema.parse(mergeDefined({ success: true }, overrides))
}
