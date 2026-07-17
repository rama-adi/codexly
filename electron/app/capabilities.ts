import {
  CapabilityNameSchema,
  type Capabilities,
  type Capability,
  type CapabilityName,
} from '../../src/shared/schemas/capabilities'
import { CONTRACT_VERSION } from '../../src/shared/schemas/common'

export interface RuntimeCapabilityInput {
  available: boolean
  reason?: 'denied' | 'restricted' | 'unsupported' | 'unavailable'
  detail?: string
}

export type RuntimeCapabilityInputs = Partial<
  Record<CapabilityName, RuntimeCapabilityInput>
>

const CAPABILITY_NAMES: readonly CapabilityName[] = CapabilityNameSchema.options

export function createCapabilities(
  inputs: RuntimeCapabilityInputs = {},
  options: { platform?: NodeJS.Platform; evaluatedAt?: string } = {},
): Capabilities {
  return {
    version: CONTRACT_VERSION,
    platform: toSupportedPlatform(options.platform ?? process.platform),
    evaluatedAt: options.evaluatedAt ?? new Date().toISOString(),
    items: CAPABILITY_NAMES.map((name) => toCapability(name, inputs[name])),
  }
}

function toCapability(
  name: CapabilityName,
  input: RuntimeCapabilityInput | undefined,
): Capability {
  if (input?.available) {
    return { name, available: true }
  }
  return {
    name,
    available: false,
    reason: input?.reason ?? 'unavailable',
    ...(input?.detail ? { detail: input.detail } : {}),
  }
}

function toSupportedPlatform(
  platform: NodeJS.Platform,
): 'darwin' | 'linux' | 'win32' {
  if (platform === 'darwin' || platform === 'win32') {
    return platform
  }
  return 'linux'
}
