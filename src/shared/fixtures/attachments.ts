import type { SerializedError } from '../errors/serialized-error'
import {
  type Attachment,
  AttachmentSchema,
  type AttachmentState,
} from '../schemas/attachments'
import { CONTRACT_VERSION, type JsonObject } from '../schemas/common'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'
import { makeSerializedError } from './errors'

export type AttachmentOverrides = Partial<{
  version: typeof CONTRACT_VERSION
  id: string
  kind: Attachment['kind']
  name: string
  mimeType: string
  byteSize: number
  createdAt: string
  extensions: JsonObject
  state: AttachmentState
  reference: string
  error: SerializedError
}>

const MIME_BY_KIND: Readonly<Record<Attachment['kind'], string>> = {
  audio: 'audio/wav',
  file: 'text/plain',
  image: 'image/png',
  screenshot: 'image/png',
}

export function makeAttachment(
  overrides: AttachmentOverrides = {},
  context: FixtureContext = createFixtureContext(),
): Attachment {
  const state = overrides.state ?? 'ready'
  const kind = overrides.kind ?? 'screenshot'
  const id = overrides.id ?? context.nextId('attachment')
  const base = {
    version: CONTRACT_VERSION,
    id,
    kind,
    name: `${kind}-${id}`,
    mimeType: MIME_BY_KIND[kind],
    byteSize: 1_024,
    createdAt: context.nextTimestamp(),
  }
  const variant = ((): object => {
    switch (state) {
      case 'pending':
        return { state }
      case 'ready':
        return { state, reference: `fixtures/${id}` }
      case 'error':
        return { state, error: makeSerializedError({}, context) }
    }
  })()
  return AttachmentSchema.parse(mergeDefined({ ...base, ...variant }, overrides))
}
