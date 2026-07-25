import type { AuthStatus } from '../schemas/auth'
import { type Bootstrap, BootstrapSchema } from '../schemas/bootstrap'
import type { Capabilities } from '../schemas/capabilities'
import { CONTRACT_VERSION, type JsonObject } from '../schemas/common'
import type { ConversationSummary } from '../schemas/conversations'
import type { Session } from '../schemas/sessions'
import type { CanonicalSettings } from '../schemas/settings'
import type { WindowState } from '../schemas/windows'
import { makeAuthStatus } from './auth'
import { makeCapabilities } from './capabilities'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'
import { makeConversationSummary } from './conversations'
import { makeSession } from './sessions'
import { makeSettings } from './settings'
import { makeWindowStates } from './windows'

/**
 * The whole renderer-init payload. Every branch is composed from the individual
 * factories, so a test overrides only the slice it cares about.
 */
export type BootstrapOverrides = Partial<{
  version: typeof CONTRACT_VERSION
  generatedAt: string
  settings: CanonicalSettings
  auth: AuthStatus
  capabilities: Capabilities
  windows: WindowState[]
  conversations: ConversationSummary[]
  sessions: Session[]
  extensions: JsonObject
}>

export function makeBootstrap(
  overrides: BootstrapOverrides = {},
  context: FixtureContext = createFixtureContext(),
): Bootstrap {
  const conversation = makeConversationSummary({}, context)
  const base = {
    version: CONTRACT_VERSION,
    generatedAt: context.nextTimestamp(),
    settings: makeSettings(),
    auth: makeAuthStatus({}, context),
    capabilities: makeCapabilities({}, context),
    windows: makeWindowStates(undefined, context),
    conversations: [conversation],
    sessions: [makeSession({ conversationId: conversation.id }, context)],
  }
  return BootstrapSchema.parse(mergeDefined(base, overrides))
}
