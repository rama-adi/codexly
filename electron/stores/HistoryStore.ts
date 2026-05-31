import { readJsonFile, statePath, writeJsonFile } from "./jsonStorage"

type HistoryState = {
  activeSessionId: string | null
}

const INDEX_PATH = statePath("history-index.json")

function readState(): HistoryState {
  const value = readJsonFile<Partial<HistoryState>>(INDEX_PATH)
  return {
    activeSessionId: typeof value?.activeSessionId === "string" ? value.activeSessionId : null,
  }
}

function writeState(state: HistoryState): void {
  writeJsonFile(INDEX_PATH, state)
}

export function getActiveSessionId(): string | null {
  return readState().activeSessionId
}

export function setActiveSessionId(sessionId: string | null): void {
  writeState({ activeSessionId: sessionId })
}

export function resetActiveSession(): void {
  setActiveSessionId(null)
}

export function clearChatSessions(): void {
  setActiveSessionId(null)
}
