import {
  type Capabilities,
  CapabilitiesSchema,
  type Capability,
  type CapabilityName,
  CapabilityNameSchema,
  CapabilitySchema,
} from '../schemas/capabilities'
import { CONTRACT_VERSION, type JsonObject } from '../schemas/common'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'

export type CapabilityOverrides = Partial<{
  name: CapabilityName
  available: boolean
  reason: 'denied' | 'restricted' | 'unsupported' | 'unavailable'
  detail: string
}>

export function makeCapability(overrides: CapabilityOverrides = {}): Capability {
  const name = overrides.name ?? 'screenshots'
  const available = overrides.available ?? true
  const base = available ? { name, available } : { name, available, reason: 'denied' }
  return CapabilitySchema.parse(mergeDefined(base, overrides))
}

export type CapabilitiesOverrides = Partial<{
  version: typeof CONTRACT_VERSION
  platform: Capabilities['platform']
  evaluatedAt: string
  items: Capability[]
  extensions: JsonObject
}>

/** Every capability, all available — the "nothing is denied" baseline. */
export function makeCapabilities(
  overrides: CapabilitiesOverrides = {},
  context: FixtureContext = createFixtureContext(),
): Capabilities {
  const base = {
    version: CONTRACT_VERSION,
    platform: 'darwin' as const,
    evaluatedAt: context.nextTimestamp(),
    items: CapabilityNameSchema.options.map((name) => makeCapability({ name })),
  }
  return CapabilitiesSchema.parse(mergeDefined(base, overrides))
}
