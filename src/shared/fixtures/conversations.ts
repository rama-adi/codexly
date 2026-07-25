import type { SerializedError } from '../errors/serialized-error'
import type { Attachment } from '../schemas/attachments'
import { CONTRACT_VERSION, type JsonObject } from '../schemas/common'
import {
  type Conversation,
  type ConversationMessage,
  ConversationMessageSchema,
  ConversationSchema,
  type ConversationSummary,
  ConversationSummarySchema,
  type MessageContentBlock,
  MessageContentBlockSchema,
} from '../schemas/conversations'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'
import { makeSerializedError } from './errors'

export type ContentBlockOverrides = Partial<{
  type: MessageContentBlock['type']
  text: string
  attachmentId: string
}>

export function makeContentBlock(
  overrides: ContentBlockOverrides = {},
  context: FixtureContext = createFixtureContext(),
): MessageContentBlock {
  const type = overrides.type ?? 'text'
  const base =
    type === 'text'
      ? { type, text: `fixture text ${context.nextId('block')}` }
      : { type, attachmentId: context.nextId('attachment') }
  return MessageContentBlockSchema.parse(mergeDefined(base, overrides))
}

export type MessageOverrides = Partial<{
  version: typeof CONTRACT_VERSION
  id: string
  conversationId: string
  role: ConversationMessage['role']
  content: MessageContentBlock[]
  createdAt: string
  extensions: JsonObject
  state: ConversationMessage['state']
  error: SerializedError
}>

export function makeMessage(
  overrides: MessageOverrides = {},
  context: FixtureContext = createFixtureContext(),
): ConversationMessage {
  const state = overrides.state ?? 'complete'
  const base = {
    version: CONTRACT_VERSION,
    id: context.nextId('message'),
    conversationId: 'conversation-1',
    role: 'user' as const,
    content: [makeContentBlock({}, context)],
    createdAt: context.nextTimestamp(),
    state,
    ...(state === 'error' ? { error: makeSerializedError({}, context) } : {}),
  }
  return ConversationMessageSchema.parse(mergeDefined(base, overrides))
}

export type ConversationSummaryOverrides = Partial<ConversationSummary>

export function makeConversationSummary(
  overrides: ConversationSummaryOverrides = {},
  context: FixtureContext = createFixtureContext(),
): ConversationSummary {
  const createdAt = context.nextTimestamp()
  const base: ConversationSummary = {
    version: CONTRACT_VERSION,
    id: context.nextId('conversation'),
    title: 'Fixture conversation',
    createdAt,
    updatedAt: context.nextTimestamp(),
    messageCount: 2,
    archived: false,
  }
  return ConversationSummarySchema.parse(mergeDefined(base, overrides))
}

export type ConversationOverrides = Partial<{
  version: typeof CONTRACT_VERSION
  id: string
  title: string
  createdAt: string
  updatedAt: string
  archived: boolean
  messages: ConversationMessage[]
  attachments: Attachment[]
  extensions: JsonObject
}>

export function makeConversation(
  overrides: ConversationOverrides = {},
  context: FixtureContext = createFixtureContext(),
): Conversation {
  const id = overrides.id ?? context.nextId('conversation')
  const base = {
    version: CONTRACT_VERSION,
    id,
    title: 'Fixture conversation',
    createdAt: context.nextTimestamp(),
    updatedAt: context.nextTimestamp(),
    archived: false,
    messages: [
      makeMessage({ conversationId: id, role: 'user' }, context),
      makeMessage({ conversationId: id, role: 'assistant' }, context),
    ],
    attachments: [],
  }
  return ConversationSchema.parse(mergeDefined(base, overrides))
}
