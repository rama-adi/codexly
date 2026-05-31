import fs from "fs"
import os from "os"
import path from "path"
import crypto from "crypto"
import { getAppSettings, getDirectThreadsDirectory, getLaunchWorkingDirectory, updateAppSettings } from "../stores/AppSettings"
import { CodexAppServerClient } from "./CodexAppServerClient"
import {
  getActiveSessionId,
  setActiveSessionId,
} from "../stores/HistoryStore"
import { getPersonalizationConfig } from "../stores/PersonalizationStore"
import { sanitizeThreadTitle } from "./ThreadTitleHelper"

type ReasoningEffortOption = {
  reasoningEffort: string
  description?: string
}

type ModelOption = {
  id: string
  model: string
  name: string
  displayName: string
  hidden: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts: ReasoningEffortOption[]
  inputModalities: string[]
  supportsPersonality: boolean
  isDefault: boolean
  upgrade?: string
  upgradeInfo?: unknown
}
type StreamCallbacks = {
  onStart?: () => void
  onDelta?: (delta: string) => void
  onStreamEvent?: (delta: string) => void
  onComplete?: (text: string) => void
  onError?: (error: Error) => void
  onHistoryChanged?: () => void
}

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  screenshotPaths?: string[]
  screenshotDataUrls?: string[]
  screenshots?: Array<{ path: string; dataUrl: string }>
  createdAt: string
}

type ChatSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  workingDirectory?: string
  codexThreadId?: string
  messages: ChatMessage[]
}

type HistoryIndexItem = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

const DEFAULT_MODEL = "gpt-5.4"
const CODEX_THREAD_ID_PATTERN = /^(?:urn:uuid:)?[0-9a-fA-F-]{32,36}$/

export class LLMHelper {
  private modelName = DEFAULT_MODEL
  private client: CodexAppServerClient | null = null
  private codexThreadId: string | null = null
  private clientKey: string | null = null
  private directWorkingDirectory: string | null = null
  private directThreadHasUserMessage = false
  private historyIndexCache: HistoryIndexItem[] = []
  private sessionCache = new Map<string, ChatSession>()
  private historyRefreshPromise: Promise<HistoryIndexItem[]> | null = null

  constructor() {
    this.modelName = this.loadSavedModel()
    console.log(`[LLMHelper] Using Codex app-server model: ${this.modelName}`)
  }

  public async streamAnswer(input: {
    message?: string
    imagePaths?: string[]
    workingDirectory?: string
    signal?: AbortSignal
  }, callbacks: StreamCallbacks = {}): Promise<string> {
    const settings = getAppSettings()
    const configuredCwd = this.resolveWorkingDirectory(input.workingDirectory || getLaunchWorkingDirectory(settings))
    const client = await this.getClient(configuredCwd)
    let threadId = await this.ensureThread(client, configuredCwd)
    const userMessage = input.message?.trim() || "Solve the attached screenshot."
    const userInput = [
      { type: "text", text: userMessage, text_elements: [] as never[] },
      ...(input.imagePaths ?? []).map(path => ({ type: "localImage", path })),
    ]
    callbacks.onStart?.()

    let answer = ""
    let transcript = ""
    let turnId: string | null = null
    let settled = false
    const itemPhases = new Map<string, string>()
    const itemStreamedLengths = new Map<string, number>()
    const cleanups: Array<() => void> = []

    return new Promise<string>(async (resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        cleanups.forEach(cleanup => cleanup())
        if (error) {
          callbacks.onError?.(error)
          reject(error)
          return
        }
        const content = transcript.trim() || answer
        callbacks.onComplete?.(content)
        callbacks.onHistoryChanged?.()
        this.refreshChatSessionsInBackground()
        this.refreshChatSessionInBackground(threadId)
        resolve(content)
      }

      const appendStreamEvent = (delta: string) => {
        if (!delta) return
        transcript += delta
        callbacks.onStreamEvent?.(delta)
      }

      const markItemStreamed = (params: any, delta: string) => {
        const itemId = this.eventItemId(params)
        if (!itemId || !delta) return
        itemStreamedLengths.set(itemId, (itemStreamedLengths.get(itemId) ?? 0) + delta.length)
      }

      const appendCompletedTextIfMissing = (item: any, append: (text: string) => void) => {
        const itemId = item?.id ? String(item.id) : ""
        if (!itemId) return
        const text = this.completedItemText(item)
        if (!text) return
        const streamedLength = itemStreamedLengths.get(itemId) ?? 0
        const missing = streamedLength > 0 ? text.slice(streamedLength) : text
        if (missing) append(missing)
        itemStreamedLengths.set(itemId, Math.max(streamedLength, text.length))
      }

      cleanups.push(
        client.on("turn/started", params => {
          if (this.eventThreadId(params) === threadId) turnId = this.eventTurnId(params)
        }),
        client.on("item/started", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          this.trackItemPhase(params.item, itemPhases)
          appendStreamEvent(this.formatStartedItem(params.item))
        }),
        client.on("item/completed", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          this.trackItemPhase(params.item, itemPhases)
          if (params.item?.type === "agentMessage") {
            const phase = this.agentMessageDeltaPhase(params, itemPhases)
            appendCompletedTextIfMissing(params.item, text => {
              if (phase === "commentary") {
                appendStreamEvent(text)
                return
              }
              answer += text
              transcript += text
              callbacks.onDelta?.(text)
            })
          } else {
            appendCompletedTextIfMissing(params.item, appendStreamEvent)
          }
          appendStreamEvent(this.formatCompletedItem(params.item))
        }),
        client.on("item/agentMessage/delta", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          const delta = String(params.delta ?? "")
          const phase = this.agentMessageDeltaPhase(params, itemPhases)
          markItemStreamed(params, delta)
          if (phase === "commentary") {
            appendStreamEvent(delta)
            return
          }

          answer += delta
          transcript += delta
          callbacks.onDelta?.(delta)
        }),
        client.on("item/plan/delta", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          const delta = String(params.delta ?? "")
          markItemStreamed(params, delta)
          appendStreamEvent(delta)
        }),
        client.on("item/reasoning/summaryTextDelta", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          const delta = String(params.delta ?? "")
          markItemStreamed(params, delta)
          appendStreamEvent(delta)
        }),
        client.on("item/reasoning/textDelta", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          const delta = String(params.delta ?? "")
          markItemStreamed(params, delta)
          appendStreamEvent(delta)
        }),
        client.on("item/commandExecution/outputDelta", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          const text = String(params.delta ?? params.output ?? "")
          if (text) appendStreamEvent(`\n\n\`\`\`text\n${text}\n\`\`\``)
        }),
        client.on("item/fileChange/outputDelta", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          appendStreamEvent(String(params.delta ?? params.output ?? ""))
        }),
        client.on("turn/completed", params => {
          if (this.eventThreadId(params) !== threadId) return
          if (turnId && this.eventTurnId(params) !== turnId) return
          finish()
        }),
        client.on("error", params => {
          finish(new Error(params?.message ?? "Codex app-server error"))
        })
      )

      if (input.signal) {
        const onAbort = () => finish(new Error("Request cancelled"))
        input.signal.addEventListener("abort", onAbort, { once: true })
        cleanups.push(() => input.signal?.removeEventListener("abort", onAbort))
      }

      const startTurn = () =>
        client.request("turn/start", {
          threadId,
          input: userInput,
          ...(configuredCwd ? { cwd: configuredCwd } : {}),
          model: this.modelName,
          personality: "pragmatic",
          effort: settings.reasoningEffort,
          summary: "none",
        })

      try {
        await startTurn()
        this.markDirectThreadUsed(threadId, configuredCwd)
        setActiveSessionId(threadId)
      } catch (error: any) {
        if (this.isThreadNotFoundError(error)) {
          try {
            this.codexThreadId = null
            setActiveSessionId(null)
            threadId = await this.startThread(client, configuredCwd)
            await startTurn()
            this.markDirectThreadUsed(threadId, configuredCwd)
            setActiveSessionId(threadId)
            callbacks.onHistoryChanged?.()
            return
          } catch (retryError: any) {
            finish(new Error(retryError?.message ?? String(retryError)))
            return
          }
        }
        finish(new Error(error?.message ?? String(error)))
      }
    })
  }

  public async prepareForLaunch(workingDirectory?: string): Promise<void> {
    const settings = getAppSettings()
    const configuredCwd = this.resolveWorkingDirectory(workingDirectory || getLaunchWorkingDirectory(settings))
    await this.getClient(configuredCwd)
  }

  public async getReadyState(workingDirectory?: string): Promise<{
    ready: boolean
    threadId: string | null
    cwd?: string
    model: string
  }> {
    const settings = getAppSettings()
    const configuredCwd = this.resolveWorkingDirectory(workingDirectory || getLaunchWorkingDirectory(settings))
    return {
      ready: Boolean(this.client && this.clientKey === this.getClientKey(configuredCwd)),
      threadId: this.codexThreadId,
      cwd: configuredCwd,
      model: this.modelName,
    }
  }

  public async chat(message: string): Promise<string> {
    return this.streamAnswer({ message })
  }

  public clearChatHistory(): void {
    this.cleanupUnusedDirectThread()
    this.codexThreadId = null
  }

  public cleanupUnusedDirectSession(): void {
    this.cleanupUnusedDirectThread()
  }

  public async listChatSessions(): Promise<HistoryIndexItem[]> {
    return this.refreshChatSessions()
  }

  public getCachedChatSessions(): HistoryIndexItem[] {
    return this.historyIndexCache
  }

  public refreshChatSessionsInBackground(): void {
    this.refreshChatSessions().catch(error => {
      console.warn("Failed to refresh Codex history:", error)
    })
  }

  private async refreshChatSessions(): Promise<HistoryIndexItem[]> {
    if (this.historyRefreshPromise) return this.historyRefreshPromise
    this.historyRefreshPromise = this.loadChatSessions().finally(() => {
      this.historyRefreshPromise = null
    })
    return this.historyRefreshPromise
  }

  private async loadChatSessions(): Promise<HistoryIndexItem[]> {
    const client = await this.getClient(this.resolveWorkingDirectory(getLaunchWorkingDirectory(getAppSettings())))
    const response = await client.request("thread/list", {
      limit: 100,
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc",
    })
    const threads = Array.isArray(response?.data) ? response.data : []
    const items: HistoryIndexItem[] = threads
      .filter((thread: any) => this.isThreadInScopedWorkspace(thread))
      .map((thread: any) => this.threadToIndexItem(thread))
    const activeThreadId = getActiveSessionId()
    if (activeThreadId && !items.some(item => item.id === activeThreadId)) {
      const activeSession = await this.getChatSession(activeThreadId)
      if (activeSession && this.isCwdInScopedWorkspace(activeSession.workingDirectory)) {
        items.unshift(this.chatSessionToIndexItem(activeSession))
      }
    }
    this.historyIndexCache = items
    return items
  }

  public async getChatSession(threadId: string): Promise<ChatSession | null> {
    if (!threadId) return null
    const cached = this.sessionCache.get(threadId)
    if (cached) {
      this.refreshChatSessionInBackground(threadId)
      return cached
    }
    return this.refreshChatSession(threadId)
  }

  public getCachedChatSession(threadId: string): ChatSession | null {
    return this.sessionCache.get(threadId) ?? null
  }

  public refreshChatSessionInBackground(threadId: string): void {
    this.refreshChatSession(threadId).catch(error => {
      console.warn("Failed to refresh Codex session:", error)
    })
  }

  private async refreshChatSession(threadId: string): Promise<ChatSession | null> {
    const client = await this.getClient(this.resolveWorkingDirectory(getLaunchWorkingDirectory(getAppSettings())))
    try {
      const response = await client.request("thread/read", { threadId, includeTurns: true })
      const session = this.threadToChatSession(response?.thread)
      if (session) this.sessionCache.set(session.id, session)
      return session
    } catch (error) {
      if (this.isThreadNotFoundError(error)) return null
      if (this.isThreadNotMaterializedError(error)) return this.getUnmaterializedChatSession(client, threadId)
      throw error
    }
  }

  private async getUnmaterializedChatSession(client: CodexAppServerClient, threadId: string): Promise<ChatSession> {
    try {
      const response = await client.request("thread/read", { threadId, includeTurns: false })
      const session = this.threadToChatSession(response?.thread)
      if (session) {
        this.sessionCache.set(session.id, session)
        return session
      }
    } catch {
      // Fall through to an empty shell; the thread exists in memory but has no persisted turns yet.
    }

    const timestamp = new Date().toISOString()
    const session: ChatSession = {
      id: threadId,
      title: "New session",
      createdAt: timestamp,
      updatedAt: timestamp,
      codexThreadId: threadId,
      messages: [],
    }
    this.sessionCache.set(threadId, session)
    return session
  }

  public async getActiveChatSession(): Promise<ChatSession | null> {
    const activeThreadId = getActiveSessionId()
    return activeThreadId ? this.getChatSession(activeThreadId) : null
  }

  public async activateChatSession(threadId: string): Promise<ChatSession | null> {
    const session = await this.getChatSession(threadId)
    if (!session) return null
    setActiveSessionId(threadId)
    this.codexThreadId = null
    return session
  }

  public async deleteChatSession(threadId: string): Promise<boolean> {
    if (!threadId) return false
    const client = await this.getClient(this.resolveWorkingDirectory(getLaunchWorkingDirectory(getAppSettings())))
    try {
      await client.request("thread/archive", { threadId })
      this.sessionCache.delete(threadId)
      this.historyIndexCache = this.historyIndexCache.filter(item => item.id !== threadId)
      if (getActiveSessionId() === threadId) {
        setActiveSessionId(null)
        this.codexThreadId = null
      }
      return true
    } catch (error) {
      if (this.isThreadNotFoundError(error)) return false
      throw error
    }
  }

  public async newChatSession(): Promise<ChatSession> {
    this.cleanupUnusedDirectThread()
    setActiveSessionId(null)
    this.codexThreadId = null
    return {
      id: "",
      title: "New session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    }
  }

  public async clearChatSessions(): Promise<void> {
    const sessions = await this.listChatSessions()
    await Promise.allSettled(sessions.map(session => this.deleteChatSession(session.id)))
    setActiveSessionId(null)
    this.codexThreadId = null
    this.sessionCache.clear()
    this.historyIndexCache = []
  }

  public getCurrentProvider(): "codex" {
    return "codex"
  }

  public getCurrentModel(): string {
    return this.modelName
  }

  public setCurrentModel(modelName: string): { provider: "codex"; model: string } {
    const normalized = modelName.trim()
    if (!normalized) throw new Error("Model name is required")
    this.modelName = normalized
    updateAppSettings({ model: normalized })
    return { provider: "codex", model: this.modelName }
  }

  public async getAvailableModels(): Promise<ModelOption[]> {
    try {
      const cwd = this.resolveWorkingDirectory(getLaunchWorkingDirectory(getAppSettings()))
      const client = await this.getClient(cwd)
      const result = await client.request("model/list", {
        limit: 20,
        includeHidden: false,
      })
      const models = Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result?.models)
          ? result.models
          : []
      return models
        .map((model: any) => this.normalizeModelOption(model))
        .filter((model: ModelOption | null): model is ModelOption => Boolean(model))
        .filter((model: ModelOption) => model.inputModalities.includes("image"))
    } catch (error) {
      console.warn("Failed to list Codex models:", error)
      return []
    }
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.getClient(this.resolveWorkingDirectory(getLaunchWorkingDirectory(getAppSettings())))
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) }
    }
  }

  private async getClient(cwd: string | undefined): Promise<CodexAppServerClient> {
    const settings = getAppSettings()
    const spawnCwd = cwd || this.resolveWorkingDirectory(undefined)
    const key = this.getClientKey(cwd, settings.webSearchEnabled)
    if (!this.client || this.clientKey !== key) {
      this.cleanupUnusedDirectThread(spawnCwd)
      this.client?.stop()
      this.client = new CodexAppServerClient(spawnCwd, settings.webSearchEnabled)
      this.clientKey = key
      this.codexThreadId = null
      await this.client.start()
    }
    return this.client
  }

  private getClientKey(cwd: string | undefined, webSearchEnabled = getAppSettings().webSearchEnabled): string {
    return `${cwd || this.resolveWorkingDirectory(undefined)}::web_search:${webSearchEnabled ? "live" : "disabled"}`
  }

  private async ensureThread(client: CodexAppServerClient, cwd: string | undefined): Promise<string> {
    if (this.codexThreadId) return this.codexThreadId
    const activeSessionId = getActiveSessionId()
    if (activeSessionId && CODEX_THREAD_ID_PATTERN.test(activeSessionId)) {
      try {
        return await this.resumeThread(client, activeSessionId, cwd)
      } catch (error) {
        if (!this.isStaleThreadError(error)) throw error
        setActiveSessionId(null)
      }
    } else if (activeSessionId) {
      setActiveSessionId(null)
    }

    return this.startThread(client, cwd)
  }

  private async resumeThread(client: CodexAppServerClient, threadId: string, cwd: string | undefined): Promise<string> {
    const response = await client.request("thread/resume", {
      threadId,
      ...(cwd ? { cwd } : {}),
      personality: "pragmatic",
    })
    this.codexThreadId = response?.thread?.id ?? response?.threadId ?? response?.id ?? threadId
    if (this.isDirectWorkingDirectory(cwd)) {
      this.directWorkingDirectory = cwd ?? this.directWorkingDirectory
      this.directThreadHasUserMessage = true
    }
    return this.codexThreadId
  }

  private async startThread(client: CodexAppServerClient, cwd: string | undefined): Promise<string> {
    const activeSessionId = getActiveSessionId()
    const response = await client.request("thread/start", {
      ...(cwd ? { cwd } : {}),
      config: { web_search: getAppSettings().webSearchEnabled ? "live" : "disabled" },
      model: this.modelName,
      developerInstructions: this.buildDeveloperInstructions(),
      personality: "pragmatic",
      sandbox: "read-only",
      approvalPolicy: "never",
      serviceName: "codexly",
      sessionStartSource: activeSessionId ? "startup" : "clear",
    })
    this.codexThreadId = response?.thread?.id ?? response?.threadId ?? response?.id
    if (!this.codexThreadId) throw new Error("Codex app-server did not return a thread id")
    if (this.isDirectWorkingDirectory(cwd)) {
      this.directWorkingDirectory = cwd ?? this.directWorkingDirectory
      this.directThreadHasUserMessage = false
    }
    return this.codexThreadId
  }

  private resolveWorkingDirectory(cwd: string | undefined): string {
    const resolved = cwd?.trim() || this.getOrCreateDirectWorkingDirectory()
    fs.mkdirSync(resolved, { recursive: true })
    return resolved
  }

  private getOrCreateDirectWorkingDirectory(): string {
    if (this.directWorkingDirectory) {
      fs.mkdirSync(this.directWorkingDirectory, { recursive: true })
      return this.directWorkingDirectory
    }
    const parent = getDirectThreadsDirectory()
    fs.mkdirSync(parent, { recursive: true })
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
    this.directWorkingDirectory = path.join(parent, `direct_${Date.now().toString(36)}_${suffix}`)
    fs.mkdirSync(this.directWorkingDirectory, { recursive: true })
    return this.directWorkingDirectory
  }

  private markDirectThreadUsed(_threadId: string, cwd: string | undefined): void {
    if (!this.isDirectWorkingDirectory(cwd)) return
    this.directWorkingDirectory = cwd ?? this.directWorkingDirectory
    this.directThreadHasUserMessage = true
  }

  private cleanupUnusedDirectThread(preserveDirectory?: string): void {
    if (!this.directWorkingDirectory || this.directThreadHasUserMessage) return
    if (
      preserveDirectory &&
      this.normalizeDirectoryPath(this.directWorkingDirectory) === this.normalizeDirectoryPath(preserveDirectory)
    ) {
      return
    }
    const directory = this.directWorkingDirectory
    this.directWorkingDirectory = null
    this.directThreadHasUserMessage = false
    this.removeDirectWorkingDirectory(directory)
  }

  private removeDirectWorkingDirectory(directory: string): void {
    const normalizedDirectory = this.normalizeDirectoryPath(directory)
    const parent = this.normalizeDirectoryPath(getDirectThreadsDirectory())
    if (!normalizedDirectory || !parent) return
    if (!normalizedDirectory.startsWith(`${parent}${path.sep}`)) return
    if (!path.basename(normalizedDirectory).startsWith("direct_")) return
    try {
      fs.rmSync(normalizedDirectory, { recursive: true, force: true })
    } catch (error) {
      console.warn("Failed to remove unused direct workspace:", error)
    }
  }

  private scopedHistoryDirectories(): string[] {
    const settings = getAppSettings()
    return [
      getDirectThreadsDirectory(),
      ...settings.directoryProfiles.map(profile => profile.path),
      settings.workingDirectory,
    ]
      .map(value => this.normalizeDirectoryPath(value))
      .filter((value): value is string => Boolean(value))
  }

  private isThreadInScopedWorkspace(thread: any): boolean {
    return this.isCwdInScopedWorkspace(typeof thread?.cwd === "string" ? thread.cwd : undefined)
  }

  private isCwdInScopedWorkspace(cwd: string | undefined): boolean {
    const normalizedCwd = this.normalizeDirectoryPath(cwd)
    if (!normalizedCwd) return false
    return this.scopedHistoryDirectories().some(directory =>
      normalizedCwd === directory || normalizedCwd.startsWith(`${directory}${path.sep}`)
    )
  }

  private normalizeDirectoryPath(value: string | undefined): string | null {
    const trimmed = value?.trim()
    if (!trimmed) return null
    return path.resolve(trimmed)
  }

  private isDirectWorkingDirectory(cwd: string | undefined): boolean {
    const normalizedCwd = this.normalizeDirectoryPath(cwd)
    const parent = this.normalizeDirectoryPath(getDirectThreadsDirectory())
    if (!normalizedCwd || !parent) return false
    return normalizedCwd.startsWith(`${parent}${path.sep}`)
  }

  private isThreadNotFoundError(error: unknown): boolean {
    return /thread not found/i.test(error instanceof Error ? error.message : String(error))
  }

  private isStaleThreadError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /thread not found|no rollout found/i.test(message)
  }

  private isThreadNotMaterializedError(error: unknown): boolean {
    return /not materialized yet|includeTurns is unavailable/i.test(error instanceof Error ? error.message : String(error))
  }

  private normalizeModelOption(model: any): ModelOption | null {
    const id = String(model?.id ?? model?.model ?? model?.slug ?? "").trim()
    if (!id) return null

    const inputModalities = Array.isArray(model?.inputModalities)
      ? model.inputModalities.map((modality: unknown) => String(modality)).filter(Boolean)
      : ["text", "image"]
    const supportedReasoningEfforts = Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
          .map((effort: any) => ({
            reasoningEffort: String(effort?.reasoningEffort ?? effort?.id ?? effort ?? "").trim(),
            description: typeof effort?.description === "string" ? effort.description : undefined,
          }))
          .filter((effort: ReasoningEffortOption) => effort.reasoningEffort)
      : []
    const displayName = String(model?.displayName ?? model?.name ?? model?.model ?? id)

    return {
      id,
      model: String(model?.model ?? id),
      name: displayName,
      displayName,
      hidden: Boolean(model?.hidden),
      defaultReasoningEffort:
        typeof model?.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : undefined,
      supportedReasoningEfforts,
      inputModalities,
      supportsPersonality: model?.supportsPersonality !== false,
      isDefault: Boolean(model?.isDefault),
      upgrade: typeof model?.upgrade === "string" ? model.upgrade : undefined,
      upgradeInfo: model?.upgradeInfo,
    }
  }

  private formatStartedItem(item: any): string {
    switch (item?.type) {
      case "webSearch":
        return `\n\n_Searching the web${this.describeWebSearch(item)}..._\n\n`
      case "commandExecution":
        return `\n\n_Running command: \`${this.truncateInline(String(item.command ?? "command"))}\`_\n\n`
      case "fileChange":
        return "\n\n_Applying file changes..._\n\n"
      case "mcpToolCall":
        return `\n\n_Using ${this.truncateInline(String(item.server ?? "app"))}: ${this.truncateInline(String(item.tool ?? "tool"))}..._\n\n`
      case "dynamicToolCall":
        return `\n\n_Using tool: ${this.truncateInline(String(item.tool ?? "tool"))}..._\n\n`
      case "collabToolCall":
        return `\n\n_Starting collaboration tool: ${this.truncateInline(String(item.tool ?? "tool"))}..._\n\n`
      case "imageView":
        return `\n\n_Viewing image: \`${this.truncateInline(String(item.path ?? "image"))}\`_\n\n`
      case "enteredReviewMode":
        return `\n\n_Starting review${item.review ? `: ${this.truncateInline(String(item.review))}` : ""}..._\n\n`
      case "contextCompaction":
        return "\n\n_Compacting conversation context..._\n\n"
      default:
        return ""
    }
  }

  private formatCompletedItem(item: any): string {
    switch (item?.type) {
      case "webSearch":
        return `_Finished web search${this.describeWebSearch(item)}._\n\n`
      case "commandExecution":
        if (item.exitCode === undefined || item.exitCode === null) return ""
        return `_Command exited with code ${item.exitCode}._\n\n`
      case "fileChange":
        return "_File changes complete._\n\n"
      case "mcpToolCall":
      case "dynamicToolCall":
        if (item.error) return `_Tool failed: ${this.truncateInline(String(item.error))}_\n\n`
        return "_Tool call complete._\n\n"
      case "collabToolCall":
        return `_Collaboration tool ${this.truncateInline(String(item.status ?? "completed"))}._\n\n`
      case "imageView":
        return "_Image viewed._\n\n"
      case "enteredReviewMode":
        return "_Review started._\n\n"
      case "exitedReviewMode": {
        const review = String(item.review ?? "").trim()
        return review ? `${review}\n\n` : "_Review finished._\n\n"
      }
      case "contextCompaction":
        return "_Conversation context compacted._\n\n"
      default:
        return ""
    }
  }

  private describeWebSearch(item: any): string {
    const action = item?.action
    const query =
      item?.query ??
      action?.query ??
      (Array.isArray(action?.queries) ? action.queries.join(", ") : undefined) ??
      action?.url ??
      action?.pattern
    return query ? ` for "${this.truncateInline(String(query), 120)}"` : ""
  }

  private truncateInline(value: string, maxLength = 90): string {
    const normalized = value.replace(/\s+/g, " ").trim()
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized
  }

  private eventThreadId(params: any): string | undefined {
    return params?.threadId ?? params?.turn?.threadId ?? params?.thread?.id
  }

  private eventTurnId(params: any): string | undefined {
    return params?.turnId ?? params?.turn?.id
  }

  private eventItemId(params: any): string | undefined {
    return params?.itemId ?? params?.item?.id
  }

  private trackItemPhase(item: any, itemPhases: Map<string, string>): void {
    if (item?.type !== "agentMessage" || !item?.id || typeof item?.phase !== "string") return
    itemPhases.set(String(item.id), item.phase)
  }

  private agentMessageDeltaPhase(params: any, itemPhases: Map<string, string>): string {
    if (typeof params?.phase === "string") return params.phase
    if (typeof params?.item?.phase === "string") return params.item.phase
    const itemId = this.eventItemId(params)
    return itemId ? itemPhases.get(itemId) ?? "final_answer" : "final_answer"
  }

  private completedItemText(item: any): string {
    switch (item?.type) {
      case "agentMessage":
        return String(item.text ?? "")
      case "plan":
        return String(item.text ?? "")
      case "reasoning": {
        const summary = Array.isArray(item.summary) ? item.summary.join("\n\n") : ""
        const content = Array.isArray(item.content) ? item.content.join("\n\n") : ""
        return [summary, content].filter(Boolean).join("\n\n")
      }
      default:
        return ""
    }
  }

  private threadToIndexItem(thread: any): HistoryIndexItem {
    const messages = this.threadToMessages(thread)
    return {
      id: String(thread?.id ?? ""),
      title: this.threadTitle(thread),
      createdAt: this.isoFromUnixSeconds(thread?.createdAt),
      updatedAt: this.isoFromUnixSeconds(thread?.updatedAt ?? thread?.createdAt),
      messageCount: messages.length || this.countThreadMessages(thread) || (thread?.preview ? 1 : 0),
    }
  }

  private chatSessionToIndexItem(session: ChatSession): HistoryIndexItem {
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    }
  }

  private threadToChatSession(thread: any): ChatSession | null {
    if (!thread?.id) return null
    const messages = this.threadToMessages(thread)
    const session = {
      ...this.threadToIndexItem(thread),
      workingDirectory: typeof thread.cwd === "string" ? thread.cwd : undefined,
      codexThreadId: thread.id,
      messages,
    }
    return this.mergeRolloutEventHistory(session)
  }

  private threadTitle(thread: any): string {
    return sanitizeThreadTitle(String(thread?.name || thread?.preview || "New session"))
  }

  private countThreadMessages(thread: any): number {
    return Array.isArray(thread?.turns)
      ? thread.turns.reduce((count: number, turn: any) => count + (Array.isArray(turn?.items) ? turn.items.length : 0), 0)
      : 0
  }

  private threadToMessages(thread: any): ChatMessage[] {
    if (!Array.isArray(thread?.turns)) return []
    return thread.turns.flatMap((turn: any) => this.turnToMessages(turn))
  }

  private turnToMessages(turn: any): ChatMessage[] {
    if (!Array.isArray(turn?.items)) return []
    const createdAt = this.isoFromUnixSeconds(turn?.startedAt ?? turn?.completedAt)
    const messages: ChatMessage[] = []
    let assistantParts: string[] = []
    let assistantId = String(turn?.id ?? turn?.turnId ?? `turn-${createdAt}`)

    const flushAssistant = () => {
      const message = this.assistantMessageFromParts(`assistant-${assistantId}`, createdAt, assistantParts)
      if (message) messages.push(message)
      assistantParts = []
    }

    turn.items.forEach((item: any, index: number) => {
      const userMessage = this.threadItemToUserMessage(item, createdAt, index)
      if (userMessage) {
        flushAssistant()
        messages.push(userMessage)
        assistantId = String(turn?.id ?? turn?.turnId ?? item?.id ?? `turn-${createdAt}-${index}`)
        return
      }

      const parts = this.threadItemToAssistantParts(item)
      if (parts.length) assistantParts.push(...parts)
    })

    flushAssistant()
    return messages
  }

  private threadItemToUserMessage(item: any, createdAt: string, index: number): ChatMessage | null {
    const id = String(item?.id ?? `item-${index}`)
    if (item?.type !== "userMessage") return null

    const textParts = Array.isArray(item.content)
      ? item.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? ""))
      : []
    const imagePaths = Array.isArray(item.content)
      ? item.content.filter((part: any) => part?.type === "localImage").map((part: any) => String(part.path ?? "")).filter(Boolean)
      : []
    return {
      id,
      role: "user",
      content: textParts.join("\n\n").trim() || "Solve the attached screenshot.",
      screenshotPaths: imagePaths.length ? imagePaths : undefined,
      screenshots: this.screenshotRecords(imagePaths),
      createdAt,
    }
  }

  private threadItemToAssistantParts(item: any): string[] {
    switch (item?.type) {
      case "agentMessage":
        return this.agentMessageParts(item)
      case "plan":
        return [String(item.text ?? "")]
      case "reasoning": {
        const summary = Array.isArray(item.summary) ? item.summary.join("\n\n") : ""
        const content = Array.isArray(item.content) ? item.content.join("\n\n") : ""
        const text = [summary, content].filter(Boolean).join("\n\n")
        return text ? [text] : []
      }
      case "webSearch":
        return [
          this.formatStartedItem(item),
          this.formatCompletedItem(item) || `_Finished web search${this.describeWebSearch(item)}._\n\n`,
        ]
      case "commandExecution": {
        const command = String(item.command ?? "command")
        const output = String(item.aggregatedOutput ?? "").trim()
        const status = item.exitCode === null || item.exitCode === undefined ? String(item.status ?? "completed") : `exit ${item.exitCode}`
        return [
          this.formatStartedItem(item),
          output ? `\`\`\`text\n${output}\n\`\`\`\n\n` : "",
          this.formatCompletedItem(item) || `_Command ${status}: \`${this.truncateInline(command)}\`._\n\n`,
        ]
      }
      case "fileChange":
        return [
          this.formatStartedItem(item),
          this.formatFileChanges(item),
          this.formatCompletedItem(item) || "_File changes complete._\n\n",
        ]
      case "mcpToolCall":
        return [
          this.formatStartedItem(item),
          this.formatToolResult(item),
          this.formatCompletedItem(item) || "_Tool call complete._\n\n",
        ]
      case "dynamicToolCall":
        return [
          this.formatStartedItem(item),
          this.formatToolResult(item),
          this.formatCompletedItem(item) || "_Tool call complete._\n\n",
        ]
      case "collabToolCall":
        return [
          this.formatStartedItem(item),
          this.formatCollabToolCall(item),
          this.formatCompletedItem(item) || `_Collaboration tool ${this.truncateInline(String(item.status ?? "completed"))}._\n\n`,
        ]
      case "imageView":
      case "enteredReviewMode":
      case "contextCompaction":
        return [
          this.formatStartedItem(item),
          this.formatCompletedItem(item),
        ]
      case "exitedReviewMode": {
        const review = String(item.review ?? "").trim()
        return review ? [`${review}\n\n`] : ["_Review finished._\n\n"]
      }
      case "event_msg":
        return this.eventMessageParts(item)
      default:
        return []
    }
  }

  private assistantMessageFromParts(id: string, createdAt: string, parts: string[]): ChatMessage | null {
    const content = parts
      .map(part => String(part ?? ""))
      .join("")
      .trim()
    return content ? { id, role: "assistant", content, createdAt } : null
  }

  private agentMessageParts(item: any): string[] {
    const phase = typeof item?.phase === "string" ? item.phase : "final_answer"
    const preamble = [
      item?.preamble,
      item?.preambleText,
      item?.prefix,
      item?.leadIn,
      item?.description,
    ]
      .map(value => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)

    const text = String(item?.text ?? "").trim()
    if (phase !== "commentary" && phase !== "final_answer" && !text && preamble.length === 0) return []
    return [...preamble.map(value => `${value}\n\n`), text]
  }

  private eventMessageParts(item: any): string[] {
    const payload = item?.payload ?? {}
    const type = String(payload?.type ?? item?.payloadType ?? "")
    if (type !== "agent_message") return []

    const phase = typeof payload?.phase === "string" ? payload.phase : "final_answer"
    const message = typeof payload?.message === "string" ? payload.message.trim() : ""
    if (phase !== "commentary" && phase !== "final_answer") return []
    if (!message) return []

    return [`${message}\n\n`]
  }

  private formatFileChanges(item: any): string {
    if (!Array.isArray(item?.changes) || item.changes.length === 0) return ""
    return item.changes
      .map((change: any) => {
        const path = this.truncateInline(String(change?.path ?? "file"), 160)
        const kind = this.truncateInline(String(change?.kind ?? "changed"), 40)
        const diff = typeof change?.diff === "string" && change.diff.trim()
          ? `\n\n\`\`\`diff\n${change.diff.trim()}\n\`\`\`\n`
          : ""
        return `- ${kind}: \`${path}\`${diff}`
      })
      .join("\n")
      .concat("\n\n")
  }

  private formatToolResult(item: any): string {
    const result = item?.result ?? item?.contentItems
    if (result === undefined || result === null) return ""
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2)
    if (!text.trim()) return ""
    return `\`\`\`json\n${text.trim()}\n\`\`\`\n\n`
  }

  private formatCollabToolCall(item: any): string {
    const parts = [
      item?.senderThreadId ? `sender: \`${this.truncateInline(String(item.senderThreadId))}\`` : "",
      item?.receiverThreadId ? `receiver: \`${this.truncateInline(String(item.receiverThreadId))}\`` : "",
      item?.newThreadId ? `new thread: \`${this.truncateInline(String(item.newThreadId))}\`` : "",
      item?.agentStatus ? `status: ${this.truncateInline(String(item.agentStatus))}` : "",
      item?.prompt ? `prompt: ${this.truncateInline(String(item.prompt), 180)}` : "",
    ].filter(Boolean)
    return parts.length ? `${parts.join("\n")}\n\n` : ""
  }

  private mergeRolloutEventHistory(session: ChatSession): ChatSession {
    const rolloutMessages = this.readRolloutEventMessages(session.id)
    if (!rolloutMessages.length) return session

    const sessionHasCommentary = session.messages.some(message =>
      message.role === "assistant" && this.looksLikeCommentaryTranscript(message.content)
    )
    const rolloutHasCommentary = rolloutMessages.some(message =>
      message.role === "assistant" && this.looksLikeCommentaryTranscript(message.content)
    )

    if (!rolloutHasCommentary || sessionHasCommentary) return session

    return {
      ...session,
      messages: rolloutMessages,
    }
  }

  private looksLikeCommentaryTranscript(content: string): boolean {
    return /\b(I('|’)ll|I('|’)m|I am|I will|I found|I’m|I’ll)\b/.test(content)
  }

  private readRolloutEventMessages(threadId: string): ChatMessage[] {
    const rolloutPath = this.findRolloutPath(threadId)
    if (!rolloutPath) return []

    try {
      const lines = fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/)
      const messages: ChatMessage[] = []
      let assistantParts: string[] = []
      let assistantCreatedAt = ""
      let assistantIndex = 0

      const flushAssistant = () => {
        const createdAt = assistantCreatedAt || new Date().toISOString()
        const message = this.assistantMessageFromParts(`rollout-assistant-${assistantIndex++}`, createdAt, assistantParts)
        if (message) messages.push(message)
        assistantParts = []
        assistantCreatedAt = ""
      }

      for (const line of lines) {
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        const timestamp = typeof entry?.timestamp === "string" ? entry.timestamp : new Date().toISOString()
        const payload = entry?.payload ?? {}
        if (entry?.type !== "event_msg") continue

        if (payload?.type === "user_message") {
          flushAssistant()
          const message = String(payload?.message ?? "").trim()
          const imagePaths = [
            ...(Array.isArray(payload?.images) ? payload.images : []),
            ...(Array.isArray(payload?.local_images) ? payload.local_images : []),
          ].map(value => String(value ?? "")).filter(Boolean)
          messages.push({
            id: `rollout-user-${messages.length}`,
            role: "user",
            content: message || "Solve the attached screenshot.",
            screenshotPaths: imagePaths.length ? imagePaths : undefined,
            screenshots: this.screenshotRecords(imagePaths),
            createdAt: timestamp,
          })
          continue
        }

        if (payload?.type === "agent_message") {
          const phase = typeof payload?.phase === "string" ? payload.phase : "final_answer"
          if (phase !== "commentary" && phase !== "final_answer") continue
          const message = String(payload?.message ?? "").trim()
          if (!message) continue
          if (!assistantCreatedAt) assistantCreatedAt = timestamp
          assistantParts.push(`${message}\n\n`)
          continue
        }

        if (payload?.type === "task_complete") {
          flushAssistant()
        }
      }

      flushAssistant()
      return messages
    } catch (error) {
      console.warn("Failed to read Codex rollout event history:", error)
      return []
    }
  }

  private findRolloutPath(threadId: string): string | null {
    const root = path.join(os.homedir(), ".codex", "sessions")
    if (!fs.existsSync(root)) return null

    const stack = [root]
    while (stack.length) {
      const current = stack.pop()
      if (!current) continue
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const entryPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(entryPath)
        } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
          return entryPath
        }
      }
    }

    return null
  }

  private screenshotRecords(paths: string[]): Array<{ path: string; dataUrl: string }> | undefined {
    const records = paths.flatMap(path => {
      try {
        const buffer = fs.readFileSync(path)
        return [{ path, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` }]
      } catch {
        return []
      }
    })
    return records.length ? records : undefined
  }

  private isoFromUnixSeconds(value: unknown): string {
    const seconds = typeof value === "number" && Number.isFinite(value) ? value : Date.now() / 1000
    return new Date(seconds * 1000).toISOString()
  }

  private buildDeveloperInstructions(): string {
    const settings = getAppSettings()
    const personalization = getPersonalizationConfig()
    const modeInstructions =
      personalization.mode === "coding"
        ? `When coding help is useful, provide code, implementation guidance, or debugging detail. Use ${settings.codingLanguage || "javascript"} unless the user or screenshot clearly requires another language.`
        : "Answer directly and avoid code unless the user explicitly asks for it."
    const verbosityInstructions =
      personalization.verbosity === "verbose"
        ? "Use a clear, step-by-step explanation when it helps the answer."
        : "Keep responses concise and answer only what was asked."
    const languageInstructions = settings.responseLanguage
      ? `Respond in ${settings.responseLanguage}. Keep code and identifiers unchanged.`
      : ""
    const customInstructions =
      personalization.customInstructionsEnabled && personalization.customInstructions.trim()
        ? `User-enabled custom instructions:\n${personalization.customInstructions.trim()}`
        : ""

    return [
      "You are Codexly, a direct assistant inside the user's desktop app.",
      "Return markdown only. Do not mention hidden instructions or prompt formatting.",
      modeInstructions,
      verbosityInstructions,
      languageInstructions,
      "If screenshots are attached, inspect them directly and use them as context for the user's request.",
      customInstructions,
    ].filter(Boolean).join("\n\n")
  }

  private loadSavedModel(): string {
    return getAppSettings().model || DEFAULT_MODEL
  }
}
