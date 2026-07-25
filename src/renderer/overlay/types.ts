export type View = 'queue' | 'solution' | 'chat'

export type Attachment = { id: string; name: string; preview: string }

export type ToolActivity = {
  key: string
  activityId?: string
  name: string
  state: 'running' | 'complete' | 'error'
  detail?: string
  output?: string
  /**
   * Sequence of the status event that last set `state`, so a status reordered by
   * the transport cannot roll the row back to an older state.
   */
  sequence?: number
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ModelChoice = {
  id: string
  displayName: string
}
