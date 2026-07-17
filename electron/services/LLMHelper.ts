import fs from "fs"
import os from "os"
import path from "path"
import crypto from "crypto"
import { streamText } from "ai"
import { createCodexAppServer, type CodexAppServerProvider, type CodexAppServerSession } from "ai-sdk-provider-codex-cli"
import { getAppSettings, getDirectThreadsDirectory, getLaunchWorkingDirectory, updateAppSettings } from "../stores/AppSettings"
import {
  getActiveSessionId,
  setActiveSessionId,
} from "../stores/HistoryStore"
import { getPersonalizationConfig } from "../stores/PersonalizationStore"
import { sanitizeThreadTitle } from "./ThreadTitleHelper"
import { devLog, devMeasure } from "../utils/devLog"

type ReasoningEffortOption = {
  reasoningEffort: string
  description?: string
}

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

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

const DEFAULT_MODEL = "gpt-5.5"
const CODEX_THREAD_ID_PATTERN = /^(?:urn:uuid:)?[0-9a-fA-F-]{32,36}$/
const HISTORY_INDEX_LIMIT = 100
const HISTORY_CODEX_INDEX_SCAN_LIMIT = 60
const HISTORY_ROLLOUT_FALLBACK_SCAN_LIMIT = 80

export class LLMHelper {
  private modelName = DEFAULT_MODEL
  private provider: CodexAppServerProvider | null = null
  private codexThreadId: string | null = null
  private providerKey: string | null = null
  private providerReplacePromise: Promise<CodexAppServerProvider> | null = null
  private currentSession: CodexAppServerSession | null = null
  private providerWarmupKey: string | null = null
  private providerWarmupPromise: Promise<void> | null = null
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
    forceEffort?: ReasoningEffort
  }, callbacks: StreamCallbacks = {}): Promise<string> {
    const done = devMeasure("llm", "streamAnswer")
    const settings = getAppSettings()
    const configuredCwd = this.resolveWorkingDirectory(input.workingDirectory || getLaunchWorkingDirectory(settings))
    const provider = await this.getProvider(configuredCwd)
    let threadId = this.getActiveThreadId()
    const userMessage = input.message?.trim() || "Solve the attached screenshot."
    const textOnlyTurn = !input.imagePaths?.length
    const turnConfigOverrides = this.appServerConfigOverrides(textOnlyTurn ? false : settings.webSearchEnabled)
    const turnEffort = input.forceEffort ?? this.resolveTurnEffort(settings.reasoningEffort, textOnlyTurn)
    devLog("llm", "streamAnswer prepared", {
      cwd: configuredCwd,
      model: this.modelName,
      effort: turnEffort,
      hasThreadId: Boolean(threadId),
      imageCount: input.imagePaths?.length ?? 0,
      messageLength: userMessage.length,
    })
    callbacks.onStart?.()

    let answer = ""
    let transcript = ""
    let turnId: string | null = null
    let sawFirstDelta = false
    const itemPhases = new Map<string, string>()
    const itemStreamedLengths = new Map<string, number>()
    const appendStreamEvent = (delta: string) => {
      if (!delta) return
      transcript += delta
      callbacks.onStreamEvent?.(delta)
    }
    const appendAssistantDelta = (delta: string) => {
      if (!delta) return
      if (!sawFirstDelta) {
        sawFirstDelta = true
        devLog("llm", "first assistant delta", { threadId, turnId })
      }
      answer += delta
      transcript += delta
      callbacks.onDelta?.(delta)
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
    const handleRaw = (rawValue: unknown) => {
      const raw = rawValue as { method?: string; params?: any }
      const method = raw?.method
      const params = raw?.params ?? {}
      if (!method) return
      const rawThreadId = this.eventThreadId(params)
      if (rawThreadId) {
        threadId = rawThreadId
        this.codexThreadId = rawThreadId
        setActiveSessionId(rawThreadId)
      }
      if (threadId && rawThreadId && rawThreadId !== threadId) return
      if (turnId && this.eventTurnId(params) && this.eventTurnId(params) !== turnId) return

      if (method === "turn/started") {
        turnId = this.eventTurnId(params)
        devLog("llm", "turn started", { threadId, turnId })
        return
      }
      if (method === "item/started") {
        this.trackItemPhase(params.item, itemPhases)
        appendStreamEvent(this.formatStartedItem(params.item))
        return
      }
      if (method === "item/completed") {
        this.trackItemPhase(params.item, itemPhases)
        if (params.item?.type === "agentMessage") {
          const phase = this.agentMessageDeltaPhase(params, itemPhases)
          appendCompletedTextIfMissing(params.item, phase === "commentary" ? appendStreamEvent : appendAssistantDelta)
        } else {
          appendCompletedTextIfMissing(params.item, appendStreamEvent)
        }
        appendStreamEvent(this.formatCompletedItem(params.item))
        return
      }
      if (method === "item/agentMessage/delta") {
        const delta = String(params.delta ?? "")
        const phase = this.agentMessageDeltaPhase(params, itemPhases)
        markItemStreamed(params, delta)
        if (phase === "commentary") appendStreamEvent(delta)
        else appendAssistantDelta(delta)
        return
      }
      if (
        method === "item/plan/delta" ||
        method === "item/reasoning/summaryTextDelta" ||
        method === "item/reasoning/textDelta"
      ) {
        const delta = String(params.delta ?? "")
        markItemStreamed(params, delta)
        appendStreamEvent(delta)
        return
      }
      if (method === "item/commandExecution/outputDelta") {
        const text = String(params.delta ?? params.output ?? "")
        if (text) appendStreamEvent(`\n\n\`\`\`text\n${text}\n\`\`\``)
        return
      }
      if (method === "item/fileChange/outputDelta") {
        appendStreamEvent(String(params.delta ?? params.output ?? ""))
      }
    }

    try {
      const result = streamText({
        model: provider(this.modelName, {
          cwd: configuredCwd,
          personality: "pragmatic",
          effort: turnEffort,
          summary: "none",
          approvalPolicy: "never",
          sandboxPolicy: "read-only",
          developerInstructions: this.buildDeveloperInstructions(),
          configOverrides: turnConfigOverrides,
          includeRawChunks: true,
          persistExtendedHistory: true,
          serverRequests: this.providerRequestHandlers(),
          onSessionCreated: session => {
            this.currentSession = session
            this.codexThreadId = session.threadId
            threadId = session.threadId
            setActiveSessionId(session.threadId)
          },
        }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: userMessage },
              ...(input.imagePaths ?? []).map(imagePath => ({ type: "image" as const, image: fs.readFileSync(imagePath) })),
            ],
          },
        ],
        abortSignal: input.signal,
        includeRawChunks: true,
        providerOptions: {
          "codex-app-server": {
            ...(threadId ? { threadId } : { threadMode: "persistent" }),
            includeRawChunks: true,
            persistExtendedHistory: true,
            configOverrides: turnConfigOverrides,
          },
        } as any,
      })

      for await (const part of result.fullStream) {
        if (part.type === "raw") {
          handleRaw(part.rawValue)
          continue
        }
        if (part.type === "text-delta" && !turnId) {
          appendAssistantDelta(String(part.text ?? ""))
          continue
        }
        if (part.type === "reasoning-delta" && !turnId) {
          appendStreamEvent(String(part.text ?? ""))
        }
      }

      const content = transcript.trim() || answer
      this.markDirectThreadUsed(threadId, configuredCwd)
      callbacks.onComplete?.(content)
      callbacks.onHistoryChanged?.()
      this.refreshChatSessionsInBackground()
      if (threadId) this.refreshChatSessionInBackground(threadId)
      done({ threadId, answerLength: answer.length, transcriptLength: transcript.length })
      return content
    } catch (error: any) {
      if (this.isThreadNotFoundError(error) && threadId) {
        this.codexThreadId = null
        setActiveSessionId(null)
      }
      const normalized = new Error(error?.message ?? String(error))
      if (turnEffort === "minimal" && this.isMinimalToolIncompatibilityError(normalized)) {
        devLog("llm", "minimal effort rejected by tools; retrying with low effort", {
          threadId,
          messageLength: userMessage.length,
        })
        done({ retry: "low", error: normalized.message })
        return this.streamAnswer({ ...input, forceEffort: "low" }, callbacks)
      }
      callbacks.onError?.(normalized)
      done({ error: normalized.message })
      throw normalized
    }
  }

  public async prepareForLaunch(workingDirectory?: string): Promise<void> {
    const done = devMeasure("llm", "prepareForLaunch")
    const settings = getAppSettings()
    const configuredCwd = this.resolveWorkingDirectory(workingDirectory || getLaunchWorkingDirectory(settings))
    const provider = await this.getProvider(configuredCwd)
    const key = this.getProviderKey(configuredCwd, settings.webSearchEnabled)
    if (this.providerWarmupKey === key) {
      done({ cwd: configuredCwd, cached: true })
      return
    }
    if (!this.providerWarmupPromise) {
      this.providerWarmupPromise = this.warmProvider(provider, configuredCwd, key)
        .finally(() => {
          this.providerWarmupPromise = null
        })
    }
    await this.providerWarmupPromise
    done({ cwd: configuredCwd, cached: false })
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
      ready: Boolean(this.provider && this.providerKey === this.getProviderKey(configuredCwd)),
      threadId: this.codexThreadId,
      cwd: configuredCwd,
      model: this.modelName,
    }
  }

  public async chat(message: string): Promise<string> {
    return this.streamAnswer({ message })
  }

  public clearChatHistory(): void {
    this.resetActiveThread()
    this.cleanupUnusedDirectThread()
  }

  public resetActiveThread(): void {
    this.codexThreadId = null
    this.currentSession = null
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
      if (this.shouldIgnoreBackgroundError(error)) return
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
    const done = devMeasure("history", "loadChatSessions")
    const items = this.readRolloutIndexItems()
      .filter(item => item)
      .slice(0, 100) as HistoryIndexItem[]
    const activeThreadId = getActiveSessionId()
    if (activeThreadId && !items.some(item => item.id === activeThreadId)) {
      const activeSession = await this.getChatSession(activeThreadId)
      if (activeSession) {
        items.unshift(this.chatSessionToIndexItem(activeSession))
      }
    }
    this.historyIndexCache = items
    done({ count: items.length, activeSessionId: activeThreadId ?? null })
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
      if (this.shouldIgnoreBackgroundError(error)) return
      console.warn("Failed to refresh Codex session:", error)
    })
  }

  private async refreshChatSession(threadId: string): Promise<ChatSession | null> {
    const done = devMeasure("history", "refreshChatSession")
    const session = this.readRolloutSession(threadId) ?? this.getUnmaterializedChatSession(threadId)
    this.sessionCache.set(session.id, session)
    done({ threadId, messageCount: session.messages.length })
    return session
  }

  private getUnmaterializedChatSession(threadId: string): ChatSession {
    const timestamp = new Date().toISOString()
    return {
      id: threadId,
      title: "New session",
      createdAt: timestamp,
      updatedAt: timestamp,
      codexThreadId: threadId,
      messages: [],
    }
  }

  public async getActiveChatSession(): Promise<ChatSession | null> {
    const activeThreadId = getActiveSessionId()
    return activeThreadId ? this.getChatSession(activeThreadId) : null
  }

  public getActiveChatSessionWorkingDirectory(): string | undefined {
    const activeThreadId = getActiveSessionId()
    if (!activeThreadId) return undefined
    const cached = this.sessionCache.get(activeThreadId)
    if (cached?.workingDirectory) return cached.workingDirectory
    const rolloutPath = this.findRolloutPath(activeThreadId)
    return rolloutPath ? this.readRolloutWorkingDirectory(rolloutPath) : undefined
  }

  public async activateChatSession(threadId: string): Promise<ChatSession | null> {
    const session = await this.getChatSession(threadId)
    if (!session) return null
    setActiveSessionId(threadId)
    this.codexThreadId = threadId
    return session
  }

  public async deleteChatSession(threadId: string): Promise<boolean> {
    if (!threadId) return false
    const rolloutPath = this.findRolloutPath(threadId)
    if (rolloutPath) {
      try {
        fs.rmSync(rolloutPath, { force: true })
      } catch (error) {
        console.warn("Failed to remove Codex session history:", error)
        return false
      }
    }
    this.sessionCache.delete(threadId)
    this.historyIndexCache = this.historyIndexCache.filter(item => item.id !== threadId)
    if (getActiveSessionId() === threadId) {
      setActiveSessionId(null)
      this.codexThreadId = null
    }
    return Boolean(rolloutPath)
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
      const provider = await this.getProvider(cwd)
      const result = await provider.listModels()
      const models = Array.isArray(result?.models) ? result.models : []
      return models
        .map((model: any) => this.normalizeModelOption(model))
        .filter((model: ModelOption | null): model is ModelOption => Boolean(model))
    } catch (error) {
      console.warn("Failed to list Codex models:", error)
      return []
    }
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const provider = await this.getProvider(this.resolveWorkingDirectory(getLaunchWorkingDirectory(getAppSettings())))
      await provider.listModels().catch((): undefined => undefined)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) }
    }
  }

  private async getProvider(cwd: string | undefined): Promise<CodexAppServerProvider> {
    const settings = getAppSettings()
    const resolvedCwd = cwd || this.resolveWorkingDirectory(undefined)
    const key = this.getProviderKey(cwd, settings.webSearchEnabled)
    if (this.provider && this.providerKey === key) {
      devLog("llm", "provider reused", { key })
      return this.provider
    }
    if (!this.providerReplacePromise) {
      this.providerReplacePromise = this.replaceProvider(resolvedCwd, key, settings.webSearchEnabled)
        .finally(() => {
          this.providerReplacePromise = null
        })
    }
    return this.providerReplacePromise
  }

  private async replaceProvider(cwd: string, key: string, webSearchEnabled: boolean): Promise<CodexAppServerProvider> {
    const done = devMeasure("llm", "replaceProvider")
    this.cleanupUnusedDirectThread(cwd)
    await this.provider?.close().catch(error => console.warn("Failed to close Codex provider:", error))
    this.provider = null
    this.providerKey = null
    this.providerWarmupKey = null
    this.providerWarmupPromise = null
    this.codexThreadId = null
    this.currentSession = null
    const provider = createCodexAppServer({
      defaultSettings: {
        cwd,
        minCodexVersion: "0.130.0",
        personality: "pragmatic",
        approvalPolicy: "never",
        sandboxPolicy: "read-only",
        effort: getAppSettings().reasoningEffort,
        summary: "none",
        persistExtendedHistory: true,
        includeRawChunks: true,
        autoApprove: false,
        configOverrides: this.appServerConfigOverrides(webSearchEnabled),
        serverRequests: this.providerRequestHandlers(),
      },
    })
    this.provider = provider
    this.providerKey = key
    done({ cwd, key, webSearchEnabled })
    return provider
  }

  private async warmProvider(provider: CodexAppServerProvider, cwd: string, key: string): Promise<void> {
    const done = devMeasure("llm", "warmProvider")
    const settings = getAppSettings()
    await provider.listModels().catch(error => {
      devLog("llm", "warmProvider model list skipped", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    if (this.provider === provider && this.getProviderKey(cwd, settings.webSearchEnabled) === key) {
      this.providerWarmupKey = key
    }
    done({ cwd, key, warmupKey: this.providerWarmupKey })
  }

  private getProviderKey(cwd: string | undefined, webSearchEnabled = getAppSettings().webSearchEnabled): string {
    return `${cwd || this.resolveWorkingDirectory(undefined)}::web_search:${webSearchEnabled ? "live" : "disabled"}`
  }

  private appServerConfigOverrides(webSearchEnabled: boolean): Record<string, boolean> {
    return {
      "tools.web_search": webSearchEnabled,
      "tools.image_generation": false,
    }
  }

  private resolveTurnEffort(configuredEffort: ReasoningEffort, textOnlyTurn: boolean): ReasoningEffort {
    if (!textOnlyTurn) return configuredEffort
    return "minimal"
  }

  private getActiveThreadId(): string | null {
    if (this.codexThreadId) return this.codexThreadId
    const activeSessionId = getActiveSessionId()
    if (activeSessionId && CODEX_THREAD_ID_PATTERN.test(activeSessionId)) return activeSessionId
    if (activeSessionId) {
      setActiveSessionId(null)
    }
    return null
  }

  private providerRequestHandlers() {
    return {
      onToolRequestUserInput: async (request: any) => ({
        answers: Object.fromEntries(
          (request.params?.questions ?? []).map((question: any) => [
            question.id,
            { answers: question?.options?.[0]?.label ? [question.options[0].label] : ["ok"] },
          ])
        ),
      }),
      onCommandExecutionApproval: async () => ({ decision: "decline" as const }),
      onFileChangeApproval: async () => ({ decision: "decline" as const }),
      onSkillApproval: async () => ({ decision: "decline" as const }),
    }
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
    if (this.providerReplacePromise) return
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
    if (!normalizedCwd) return true
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

  private isMinimalToolIncompatibilityError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /reasoning\.effort 'minimal'|reasoning\.effort "minimal"|cannot be used with reasoning\.effort/i.test(message)
  }

  public shouldIgnoreBackgroundError(error: unknown): boolean {
    return this.isBenignCodexExitError(error)
  }

  private isBenignCodexExitError(error: unknown): boolean {
    return /Codex app-server exited \((0|SIGTERM)\)/i.test(error instanceof Error ? error.message : String(error))
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
    const imagePaths = this.userInputImageReferences(item.content)
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

  private readRolloutSessions(): ChatSession[] {
    return this.listRolloutPaths()
      .flatMap(rolloutPath => {
        const threadId = this.threadIdFromRolloutPath(rolloutPath)
        if (!threadId) return []
        const session = this.readRolloutSession(threadId, rolloutPath)
        return session ? [session] : []
      })
  }

  private readRolloutIndexItems(): Array<HistoryIndexItem | null> {
    const codexSessionIndex = this.readCodexSessionIndex()
    const rolloutPathsByThreadId = this.listRolloutPathsByThreadId()
    const seen = new Set<string>()
    const items: Array<HistoryIndexItem | null> = []

    for (const [threadId, indexedSession] of Array.from(codexSessionIndex.entries())
      .sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
      .slice(0, HISTORY_CODEX_INDEX_SCAN_LIMIT)) {
      seen.add(threadId)
      const item = this.rolloutIndexItemFromPath(threadId, rolloutPathsByThreadId.get(threadId), indexedSession)
      if (item) items.push(item)
      if (items.length >= HISTORY_INDEX_LIMIT) return items
    }

    for (const [threadId, rolloutPath] of this.recentRolloutPathEntries(rolloutPathsByThreadId, HISTORY_ROLLOUT_FALLBACK_SCAN_LIMIT)) {
      if (seen.has(threadId)) continue
      const item = this.rolloutIndexItemFromPath(threadId, rolloutPath, codexSessionIndex.get(threadId))
      if (item) items.push(item)
      if (items.length >= HISTORY_INDEX_LIMIT) return items
    }

    return items.sort((left, right) => {
      if (!left) return 1
      if (!right) return -1
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    })
  }

  private recentRolloutPathEntries(
    rolloutPathsByThreadId: Map<string, string>,
    limit: number
  ): Array<[string, string]> {
    return Array.from(rolloutPathsByThreadId.entries())
      .sort((left, right) => {
        try {
          return fs.statSync(right[1]).mtimeMs - fs.statSync(left[1]).mtimeMs
        } catch {
          return 0
        }
      })
      .slice(0, limit)
  }

  private rolloutIndexItemFromPath(
    threadId: string,
    rolloutPath: string | undefined,
    indexedSession?: { title: string; updatedAt: string }
  ): HistoryIndexItem | null {
    if (!rolloutPath) return null
    let stat: fs.Stats
    try {
      stat = fs.statSync(rolloutPath)
    } catch {
      return null
    }
    const metadata = this.readRolloutIndexMetadata(rolloutPath)
    if (!this.isCwdInScopedWorkspace(metadata.workingDirectory)) return null
    const timestamp = stat.mtime.toISOString()
    return {
      id: threadId,
      title: sanitizeThreadTitle(indexedSession?.title || metadata.titleSeed || "New session"),
      createdAt: metadata.createdAt || timestamp,
      updatedAt: indexedSession?.updatedAt || metadata.updatedAt || timestamp,
      messageCount: metadata.messageCount,
    }
  }

  private readRolloutIndexMetadata(rolloutPath: string): {
    titleSeed: string
    createdAt: string
    updatedAt: string
    messageCount: number
    workingDirectory?: string
  } {
    let titleSeed = ""
    let createdAt = ""
    let updatedAt = ""
    let messageCount = 0
    let workingDirectory: string | undefined

    try {
      const lines = fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/)
      const hasResponseItems = lines.some(line => {
        if (!line.trim()) return false
        try {
          const entry = JSON.parse(line)
          return entry?.type === "response_item" && entry?.payload?.type === "message"
        } catch {
          return false
        }
      })

      for (const line of lines) {
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        const timestamp = typeof entry?.timestamp === "string" ? entry.timestamp : ""
        if (timestamp) {
          if (!createdAt) createdAt = timestamp
          updatedAt = timestamp
        }
        workingDirectory ??= this.rolloutEntryWorkingDirectory(entry)
        const payload = entry?.payload ?? {}
        if (hasResponseItems && entry?.type === "event_msg") continue
        if (entry?.type === "event_msg" && payload?.type === "user_message") {
          messageCount += 1
          if (!titleSeed) titleSeed = String(payload?.message ?? "").trim()
          continue
        }
        if (entry?.type === "event_msg" && payload?.type === "agent_message") {
          messageCount += 1
          continue
        }
        if (entry?.type === "response_item" && payload?.type === "message") {
          const message = this.responseItemToChatMessage(payload, timestamp || updatedAt || createdAt, messageCount)
          if (!message) continue
          messageCount += 1
          if (message.role === "user" && !titleSeed) titleSeed = message.content
        }
      }
    } catch {
      return { titleSeed: "", createdAt: "", updatedAt: "", messageCount: 0 }
    }

    return { titleSeed, createdAt, updatedAt, messageCount, workingDirectory }
  }

  private readRolloutSession(threadId: string, rolloutPath = this.findRolloutPath(threadId)): ChatSession | null {
    if (!rolloutPath) return null
    const messages = this.readRolloutEventMessagesFromPath(rolloutPath)
    if (!messages.length) return null
    const createdAt = messages[0]?.createdAt ?? new Date().toISOString()
    const updatedAt = messages.at(-1)?.createdAt ?? createdAt
    const firstUserMessage = messages.find(message => message.role === "user")?.content
    return {
      id: threadId,
      title: sanitizeThreadTitle(this.readCodexSessionIndex().get(threadId)?.title || firstUserMessage || "New session"),
      createdAt,
      updatedAt,
      codexThreadId: threadId,
      workingDirectory: this.readRolloutWorkingDirectory(rolloutPath),
      messages,
    }
  }

  private readCodexSessionIndex(): Map<string, { title: string; updatedAt: string }> {
    const indexPath = path.join(os.homedir(), ".codex", "session_index.jsonl")
    const sessions = new Map<string, { title: string; updatedAt: string }>()
    if (!fs.existsSync(indexPath)) return sessions

    try {
      for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        const id = typeof entry?.id === "string" ? entry.id : ""
        const title = typeof entry?.thread_name === "string" ? entry.thread_name.trim() : ""
        const updatedAt = typeof entry?.updated_at === "string" ? entry.updated_at : ""
        if (id && title) sessions.set(id, { title, updatedAt })
      }
    } catch {
      return sessions
    }

    return sessions
  }

  private readRolloutEventMessages(threadId: string): ChatMessage[] {
    const rolloutPath = this.findRolloutPath(threadId)
    if (!rolloutPath) return []
    return this.readRolloutEventMessagesFromPath(rolloutPath)
  }

  private readRolloutEventMessagesFromPath(rolloutPath: string): ChatMessage[] {
    try {
      const lines = fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/)
      const hasResponseItems = lines.some(line => {
        if (!line.trim()) return false
        try {
          const entry = JSON.parse(line)
          return entry?.type === "response_item" && entry?.payload?.type === "message"
        } catch {
          return false
        }
      })
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

        if (entry?.type === "response_item") {
          const message = this.responseItemToChatMessage(payload, timestamp, messages.length)
          if (message?.role === "user") flushAssistant()
          if (message) messages.push(message)
          continue
        }

        if (hasResponseItems) continue
        if (entry?.type !== "event_msg") continue

        if (payload?.type === "user_message") {
          flushAssistant()
          const message = String(payload?.message ?? "").trim()
          const imagePaths = this.rolloutImageReferences(payload)
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

  private readRolloutWorkingDirectory(rolloutPath: string): string | undefined {
    try {
      for (const line of fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        const cwd = this.rolloutEntryWorkingDirectory(entry)
        if (cwd) return cwd
      }
    } catch {
      return undefined
    }
    return undefined
  }

  private listRolloutPaths(): string[] {
    return Array.from(this.listRolloutPathsByThreadId().values()).sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs
      } catch {
        return 0
      }
    })
  }

  private listRolloutPathsByThreadId(): Map<string, string> {
    const root = path.join(os.homedir(), ".codex", "sessions")
    const paths = new Map<string, string>()
    if (!fs.existsSync(root)) return paths
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
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const threadId = this.threadIdFromRolloutPath(entryPath)
          if (threadId) paths.set(threadId, entryPath)
        }
      }
    }
    return paths
  }

  private threadIdFromRolloutPath(rolloutPath: string): string | null {
    const filename = path.basename(rolloutPath)
    const match = filename.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/)
    return match?.[1] ?? null
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

  private userInputImageReferences(content: unknown): string[] {
    if (!Array.isArray(content)) return []
    return content.flatMap((part: any) => {
      if (part?.type === "localImage") {
        const path = String(part.path ?? "").trim()
        return path ? [path] : []
      }
      if (part?.type === "image") {
        const url = String(part.url ?? "").trim()
        return url ? [url] : []
      }
      return []
    })
  }

  private rolloutImageReferences(payload: any): string[] {
    return [
      ...this.normalizeRolloutImageList(payload?.images),
      ...this.normalizeRolloutImageList(payload?.local_images),
      ...this.normalizeRolloutImageList(payload?.localImages),
    ]
  }

  private rolloutEntryWorkingDirectory(entry: any): string | undefined {
    const cwd =
      entry?.cwd ??
      entry?.payload?.cwd ??
      entry?.payload?.metadata?.cwd ??
      entry?.payload?.turn?.cwd ??
      entry?.payload?.thread?.cwd
    return typeof cwd === "string" && cwd.trim() ? cwd : undefined
  }

  private responseItemToChatMessage(payload: any, createdAt: string, index: number): ChatMessage | null {
    if (payload?.type !== "message") return null
    const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null
    if (!role) return null
    const content = Array.isArray(payload.content) ? payload.content : []
    const text = this.responseItemText(payload)
    if (!text && this.isSyntheticResponseItemMessage(payload)) return null
    const imagePaths = content.flatMap((part: any) => {
      const reference = part?.image ?? part?.image_url ?? part?.imageUrl ?? part?.url ?? part?.path
      return typeof reference === "string" && reference.trim() ? [reference.trim()] : []
    })
    if (!text && !imagePaths.length) return null
    return {
      id: String(payload.id ?? `response-item-${index}`),
      role,
      content: text || (role === "user" ? "Solve the attached screenshot." : ""),
      screenshotPaths: imagePaths.length ? imagePaths : undefined,
      screenshots: imagePaths.length ? this.screenshotRecords(imagePaths) : undefined,
      createdAt,
    }
  }

  private responseItemText(payload: any): string {
    const content = Array.isArray(payload?.content) ? payload.content : []
    return content
      .flatMap((part: any) => {
        const text = part?.text ?? part?.content
        if (typeof text !== "string") return []
        const cleaned = this.cleanResponseItemText(text)
        return cleaned ? [cleaned] : []
      })
      .join("\n\n")
      .trim()
  }

  private isSyntheticResponseItemMessage(payload: any): boolean {
    const content = Array.isArray(payload?.content) ? payload.content : []
    const textParts: string[] = content
      .flatMap((part: any) => {
        const text = part?.text ?? part?.content
        return typeof text === "string" ? [text] : []
      })
      .filter((text: string) => text.trim())
    return textParts.length > 0 && textParts.every(text => !this.cleanResponseItemText(text))
  }

  private cleanResponseItemText(text: string): string {
    const trimmed = text.trim()
    if (!trimmed) return ""
    if (/^<image\s+name=\[[^\]]+\]>\s*$/i.test(trimmed)) return ""
    if (/^<\/image>\s*$/i.test(trimmed)) return ""
    if (/^<(?:environment_context|permissions instructions|apps_instructions|skills_instructions|plugins_instructions|codex_internal_context)\b[\s\S]*<\/(?:environment_context|permissions instructions|apps_instructions|skills_instructions|plugins_instructions|codex_internal_context)>$/i.test(trimmed)) {
      return ""
    }
    return trimmed.replace(/^User:\s*/i, "").trim()
  }

  private normalizeRolloutImageList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.flatMap(item => {
      if (typeof item === "string") return item.trim() ? [item.trim()] : []
      if (!item || typeof item !== "object") return []
      const record = item as { path?: unknown; url?: unknown }
      const reference = String(record.path ?? record.url ?? "").trim()
      return reference ? [reference] : []
    })
  }

  private screenshotRecords(references: string[]): Array<{ path: string; dataUrl: string }> | undefined {
    const records = references.flatMap(reference => {
      if (/^(?:https?:|data:image\/)/i.test(reference)) {
        return [{ path: reference, dataUrl: reference }]
      }
      try {
        const buffer = fs.readFileSync(reference)
        return [{ path: reference, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` }]
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
    const settings = getAppSettings()
    const savedModel = settings.model?.trim()
    if (!savedModel || savedModel === "gpt-5.4" || /spark/i.test(savedModel)) {
      updateAppSettings({
        model: DEFAULT_MODEL,
        reasoningEffort: "low",
      })
      return DEFAULT_MODEL
    }
    if (settings.reasoningEffort !== "low") {
      updateAppSettings({ reasoningEffort: "low" })
    }
    return savedModel
  }
}
