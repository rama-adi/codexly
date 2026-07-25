import { describe, expect, it } from 'vitest'

import { SerializedErrorSchema } from '../errors/serialized-error'
import { AttachmentSchema } from '../schemas/attachments'
import { AuthStatusSchema, AuthUserSchema } from '../schemas/auth'
import { BootstrapSchema } from '../schemas/bootstrap'
import { CapabilitiesSchema, CapabilitySchema } from '../schemas/capabilities'
import {
  ConversationMessageSchema,
  ConversationSchema,
  ConversationSummarySchema,
  MessageContentBlockSchema,
} from '../schemas/conversations'
import {
  ConnectionTestResultSchema,
  ModelOptionSchema,
  ModelOptionsSchema,
} from '../schemas/models'
import { SessionSchema } from '../schemas/sessions'
import { CanonicalSettingsSchema, ShortcutsSchema } from '../schemas/settings'
import { WindowStateSchema, WindowStatesSchema } from '../schemas/windows'
import { ProductEventSchema, TranscriptSnapshotSchema } from '../ipc/product'
import {
  createFixtureContext,
  makeAttachment,
  makeAuthStatus,
  makeAuthUser,
  makeBootstrap,
  makeCapabilities,
  makeCapability,
  makeConnectionTestResult,
  makeContentBlock,
  makeConversation,
  makeConversationSummary,
  makeMessage,
  makeModelOption,
  makeModelOptions,
  makeProductEvent,
  makeSerializedError,
  makeSession,
  makeSettings,
  makeShortcuts,
  makeTranscriptSnapshot,
  makeWindowState,
  makeWindowStates,
  PRODUCT_EVENT_TYPES,
} from './index'

describe('fixture factories parse their own schema', () => {
  it('produces schema-valid output for every factory', () => {
    expect(SerializedErrorSchema.parse(makeSerializedError())).toBeTruthy()
    expect(CanonicalSettingsSchema.parse(makeSettings())).toBeTruthy()
    expect(ShortcutsSchema.parse(makeShortcuts())).toBeTruthy()
    expect(SessionSchema.parse(makeSession())).toBeTruthy()
    expect(AttachmentSchema.parse(makeAttachment())).toBeTruthy()
    expect(MessageContentBlockSchema.parse(makeContentBlock())).toBeTruthy()
    expect(ConversationMessageSchema.parse(makeMessage())).toBeTruthy()
    expect(ConversationSummarySchema.parse(makeConversationSummary())).toBeTruthy()
    expect(ConversationSchema.parse(makeConversation())).toBeTruthy()
    expect(AuthUserSchema.parse(makeAuthUser())).toBeTruthy()
    expect(AuthStatusSchema.parse(makeAuthStatus())).toBeTruthy()
    expect(CapabilitySchema.parse(makeCapability())).toBeTruthy()
    expect(CapabilitiesSchema.parse(makeCapabilities())).toBeTruthy()
    expect(WindowStateSchema.parse(makeWindowState())).toBeTruthy()
    expect(WindowStatesSchema.parse(makeWindowStates())).toBeTruthy()
    expect(ModelOptionSchema.parse(makeModelOption())).toBeTruthy()
    expect(ModelOptionsSchema.parse(makeModelOptions())).toBeTruthy()
    expect(ConnectionTestResultSchema.parse(makeConnectionTestResult())).toBeTruthy()
    expect(TranscriptSnapshotSchema.parse(makeTranscriptSnapshot())).toBeTruthy()
    expect(BootstrapSchema.parse(makeBootstrap())).toBeTruthy()
  })

  it.each(['pending', 'ready', 'error'] as const)('builds a %s attachment', (state) => {
    expect(AttachmentSchema.parse(makeAttachment({ state }))).toMatchObject({ state })
  })

  it.each(['starting', 'active', 'stopping', 'ended', 'error'] as const)(
    'builds a %s session',
    (state) => {
      expect(SessionSchema.parse(makeSession({ state }))).toMatchObject({ state })
    },
  )

  it.each(['unauthenticated', 'authenticating', 'authenticated', 'error'] as const)(
    'builds a %s auth status',
    (state) => {
      expect(AuthStatusSchema.parse(makeAuthStatus({ state }))).toMatchObject({ state })
    },
  )

  it.each(['complete', 'streaming', 'error'] as const)('builds a %s message', (state) => {
    expect(ConversationMessageSchema.parse(makeMessage({ state }))).toMatchObject({ state })
  })

  it.each(PRODUCT_EVENT_TYPES)('builds a valid %s event', (type) => {
    expect(ProductEventSchema.parse(makeProductEvent(type))).toMatchObject({ type })
  })

  it('covers every product event variant in the contract', () => {
    expect(PRODUCT_EVENT_TYPES.length).toBe(ProductEventSchema.options.length)
  })
})

describe('fixture determinism', () => {
  it('returns identical values across calls with no shared context', () => {
    expect(makeBootstrap()).toEqual(makeBootstrap())
    expect(makeSession()).toEqual(makeSession())
    expect(makeAttachment()).toEqual(makeAttachment())
  })

  it('yields unique, ordered ids and timestamps from a shared context', () => {
    const context = createFixtureContext()
    const first = makeAttachment({}, context)
    const second = makeAttachment({}, context)
    expect(first.id).not.toEqual(second.id)
    expect(Date.parse(second.createdAt)).toBeGreaterThan(Date.parse(first.createdAt))
  })

  it('applies overrides and drops explicit undefined instead of failing strict parse', () => {
    expect(makeSettings({ appearance: { answerHeight: 420 } }).appearance).toEqual({
      theme: 'system',
      reducedMotion: false,
      answerHeight: 420,
    })
    expect(makeAttachment({ id: undefined }).id).toBe('attachment-1')
  })

  it('rejects overrides that break the contract', () => {
    expect(() => makeSettings({ appearance: { answerHeight: 10 } })).toThrow()
    expect(() => makeAttachment({ state: 'ready', reference: '' })).toThrow()
  })

  it('composes bootstrap from the individual factories', () => {
    const settings = makeSettings({ privacy: { stealthMode: false } })
    const bootstrap = makeBootstrap({ settings, conversations: [], sessions: [] })
    expect(bootstrap.settings).toEqual(settings)
    expect(bootstrap.conversations).toEqual([])
    expect(bootstrap.windows.map((window) => window.role)).toEqual(['main', 'toolbar'])
  })
})
