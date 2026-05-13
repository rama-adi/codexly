import crypto from "crypto"
import fs from "fs"
import path from "path"
import { readJsonFile, statePath, writeJsonFile } from "./jsonStorage"
import { sanitizeThreadTitle } from "../services/ThreadTitleHelper"

export type ScreenshotRecord = {
  path: string
  dataUrl: string
}

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  screenshotPaths?: string[]
  screenshotDataUrls?: string[]
  screenshots?: ScreenshotRecord[]
  createdAt: string
}

type AppendChatMessageOptions = {
  titleHint?: string
  workingDirectory?: string
  codexThreadId?: string
  embedScreenshots?: boolean
}

export type ChatSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  workingDirectory?: string
  codexThreadId?: string
  messages: ChatMessage[]
}

export type HistoryIndexItem = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

type HistoryIndex = {
  activeSessionId: string | null
  sessions: HistoryIndexItem[]
}

const HISTORY_DIR = statePath("history")
const INDEX_PATH = statePath("history-index.json")

const emptyIndex = (): HistoryIndex => ({ activeSessionId: null, sessions: [] })

function nowIso() {
  return new Date().toISOString()
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function sessionPath(sessionId: string) {
  return path.join(HISTORY_DIR, `${sessionId}.json`)
}

function cleanSessionTitle(title: string | undefined): string {
  return sanitizeThreadTitle(title?.trim() || "New session")
}

function readIndex(): HistoryIndex {
  const value = readJsonFile<HistoryIndex>(INDEX_PATH)
  if (!value || !Array.isArray(value.sessions)) return emptyIndex()
  return {
    activeSessionId: typeof value.activeSessionId === "string" ? value.activeSessionId : null,
    sessions: value.sessions
      .filter(item => typeof item.id === "string")
      .map(item => ({ ...item, title: cleanSessionTitle(item.title) })),
  }
}

function writeIndex(index: HistoryIndex) {
  writeJsonFile(INDEX_PATH, index)
}

function writeSession(session: ChatSession) {
  writeJsonFile(sessionPath(session.id), session)
}

function screenshotToDataUrl(filePath: string): ScreenshotRecord | null {
  try {
    const buffer = fs.readFileSync(filePath)
    return {
      path: filePath,
      dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
    }
  } catch (error) {
    console.warn("Failed to embed screenshot in history:", filePath, error)
    return null
  }
}

function embedScreenshots(filePaths?: string[]): ScreenshotRecord[] | undefined {
  const screenshots = filePaths?.map(screenshotToDataUrl).filter(Boolean) as ScreenshotRecord[] | undefined
  return screenshots?.length ? screenshots : undefined
}

export function listChatSessions(): HistoryIndexItem[] {
  return readIndex().sessions
}

export function getActiveSessionId(): string | null {
  return readIndex().activeSessionId
}

export function getChatSession(sessionId: string): ChatSession | null {
  const session = readJsonFile<ChatSession>(sessionPath(sessionId))
  return session ? { ...session, title: cleanSessionTitle(session.title) } : null
}

export function getActiveChatSession(): ChatSession | null {
  const activeSessionId = getActiveSessionId()
  return activeSessionId ? getChatSession(activeSessionId) : null
}

export function activateChatSession(sessionId: string): ChatSession | null {
  const session = getChatSession(sessionId)
  if (!session) return null

  const index = readIndex()
  writeIndex({ ...index, activeSessionId: session.id })
  return session
}

export function deleteChatSession(sessionId: string): boolean {
  const index = readIndex()
  const sessions = index.sessions.filter(item => item.id !== sessionId)
  if (sessions.length === index.sessions.length) return false

  try {
    fs.rmSync(sessionPath(sessionId), { force: true })
  } catch {
    // The index is authoritative; a missing session file should not block removal.
  }

  writeIndex({
    activeSessionId:
      index.activeSessionId === sessionId
        ? sessions[0]?.id ?? null
        : index.activeSessionId,
    sessions,
  })
  return true
}

export function clearChatSessions(): void {
  try {
    fs.rmSync(HISTORY_DIR, { recursive: true, force: true })
  } catch {
    // Missing history directory is already the desired state.
  }
  writeIndex(emptyIndex())
}

export function createChatSession(input: { title?: string; workingDirectory?: string } = {}): ChatSession {
  const timestamp = nowIso()
  const session: ChatSession = {
    id: newId("session"),
    title: cleanSessionTitle(input.title),
    createdAt: timestamp,
    updatedAt: timestamp,
    workingDirectory: input.workingDirectory,
    messages: [],
  }
  writeSession(session)
  const index = readIndex()
  index.activeSessionId = session.id
  index.sessions = [
    {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: 0,
    },
    ...index.sessions,
  ]
  writeIndex(index)
  return session
}

export function resetActiveSession(): ChatSession {
  const index = readIndex()
  writeIndex({ ...index, activeSessionId: null })
  return {
    id: "",
    title: "New session",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
  }
}

export function appendChatMessage(
  message: Omit<ChatMessage, "id" | "createdAt">,
  options: AppendChatMessageOptions = {}
): ChatSession {
  const index = readIndex()
  let session = index.activeSessionId ? getChatSession(index.activeSessionId) : null
  if (!session) {
    session = createChatSession({
      title: options.titleHint,
      workingDirectory: options.workingDirectory,
    })
  }

  const nextMessage: ChatMessage = {
    ...message,
    screenshots:
      message.screenshots ??
      (options.embedScreenshots === false
        ? undefined
        : embedScreenshots(message.screenshotPaths)),
    id: newId("message"),
    createdAt: nowIso(),
  }
  if (!nextMessage.screenshotDataUrls && nextMessage.screenshots?.length) {
    nextMessage.screenshotDataUrls = nextMessage.screenshots.map(screenshot => screenshot.dataUrl)
  }
  const nextTitle =
    session.messages.length === 0 && options.titleHint?.trim()
      ? cleanSessionTitle(options.titleHint)
      : session.title
  const next: ChatSession = {
    ...session,
    title: nextTitle,
    updatedAt: nextMessage.createdAt,
    workingDirectory: options.workingDirectory ?? session.workingDirectory,
    codexThreadId: options.codexThreadId ?? session.codexThreadId,
    messages: [...session.messages, nextMessage],
  }
  writeSession(next)

  const nextIndex = readIndex()
  nextIndex.activeSessionId = next.id
  nextIndex.sessions = [
    {
      id: next.id,
      title: next.title,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      messageCount: next.messages.length,
    },
    ...nextIndex.sessions.filter(item => item.id !== next.id),
  ]
  writeIndex(nextIndex)
  return next
}

export function updateChatSessionTitle(sessionId: string, title: string): ChatSession | null {
  const cleanTitle = cleanSessionTitle(title)
  const session = getChatSession(sessionId)
  if (!session || !cleanTitle || session.title === cleanTitle) return session

  const next = { ...session, title: cleanTitle, updatedAt: nowIso() }
  writeSession(next)

  const index = readIndex()
  writeIndex({
    ...index,
    sessions: index.sessions.map(item =>
      item.id === sessionId
        ? { ...item, title: cleanTitle, updatedAt: next.updatedAt }
        : item
    ),
  })
  return next
}

export function embedMessageScreenshots(sessionId: string, messageId: string): ChatSession | null {
  const session = getChatSession(sessionId)
  if (!session) return null

  let changed = false
  const messages = session.messages.map(message => {
    if (message.id !== messageId || message.screenshots?.length || !message.screenshotPaths?.length) {
      return message
    }
    const screenshots = embedScreenshots(message.screenshotPaths)
    if (!screenshots?.length) return message
    changed = true
    return {
      ...message,
      screenshots,
      screenshotDataUrls: screenshots.map(screenshot => screenshot.dataUrl),
    }
  })

  if (!changed) return session
  const next = { ...session, messages }
  writeSession(next)
  return next
}
