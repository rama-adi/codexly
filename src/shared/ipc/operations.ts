import { z } from 'zod'

export const IPC_CHANNELS = {
  request: 'codexly:request',
  event: 'codexly:event',
  product: 'codexly:product',
  productEvent: 'codexly:product-event',
} as const

export const IpcChannelSchema = z.enum([
  IPC_CHANNELS.request,
  IPC_CHANNELS.event,
  IPC_CHANNELS.product,
  IPC_CHANNELS.productEvent,
])

export const IPC_OPERATIONS = [
  'auth.begin',
  'auth.get',
  'auth.signOut',
  'attachments.register',
  'bootstrap.get',
  'capabilities.get',
  'conversations.delete',
  'conversations.get',
  'conversations.list',
  'conversations.upsert',
  'sessions.start',
  'sessions.stop',
  'settings.get',
  'settings.update',
  'subscriptions.subscribe',
  'subscriptions.unsubscribe',
  'windows.get',
  'windows.setBounds',
  'windows.setVisibility',
] as const

export const IpcOperationSchema = z.enum(IPC_OPERATIONS)

export type IpcChannel = z.infer<typeof IpcChannelSchema>
export type IpcOperation = z.infer<typeof IpcOperationSchema>
