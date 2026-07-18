export type View = 'queue' | 'solution' | 'chat'

export type Attachment = { id: string; name: string; preview: string }

export type ToolActivity = {
  key: string
  activityId?: string
  name: string
  state: 'running' | 'complete' | 'error'
  detail?: string
  output?: string
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export type ModelChoice = {
  id: string
  displayName: string
}
