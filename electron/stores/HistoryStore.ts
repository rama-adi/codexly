import { readJsonFile, statePath, writeJsonFile } from "./jsonStorage"

type HistoryState = {
  activeSessionId: string | null
}

const INDEX_PATH = statePath("history-index.json")
const THREAD_ID_PATTERN = /^(?:urn:uuid:)?[0-9a-fA-F-]{32,36}$/

function isValidThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID_PATTERN.test(value)
}

function readState(): HistoryState {
  const value = readJsonFile<Partial<HistoryState>>(INDEX_PATH)
  if (value?.activeSessionId && !isValidThreadId(value.activeSessionId)) {
    writeState({ activeSessionId: null })
    return { activeSessionId: null }
  }
  return {
    activeSessionId: isValidThreadId(value?.activeSessionId) ? value.activeSessionId : null,
  }
}

function writeState(state: HistoryState): void {
  writeJsonFile(INDEX_PATH, state)
}

export function getActiveSessionId(): string | null {
  return readState().activeSessionId
}

export function setActiveSessionId(sessionId: string | null): void {
  writeState({ activeSessionId: isValidThreadId(sessionId) ? sessionId : null })
}

export function resetActiveSession(): void {
  setActiveSessionId(null)
}

export function clearChatSessions(): void {
  setActiveSessionId(null)
}
