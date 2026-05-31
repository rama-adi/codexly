import fs from "fs"
import { getAppSettings, getDirectWorkingDirectory, getLaunchWorkingDirectory, updateAppSettings } from "../stores/AppSettings"
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

export class LLMHelper {
  private modelName = DEFAULT_MODEL
  private client: CodexAppServerClient | null = null
  private codexThreadId: string | null = null
  private clientKey: string | null = null

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
    if (threadId) setActiveSessionId(threadId)

    callbacks.onStart?.()

    let answer = ""
    let transcript = ""
    let turnId: string | null = null
    let settled = false
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
        resolve(content)
      }

      const appendStreamEvent = (delta: string) => {
        if (!delta) return
        transcript += delta
        callbacks.onStreamEvent?.(delta)
      }

      cleanups.push(
        client.on("turn/started", params => {
          if (params?.threadId === threadId) turnId = params.turnId
        }),
        client.on("item/started", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
          appendStreamEvent(this.formatStartedItem(params.item))
        }),
        client.on("item/completed", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
          appendStreamEvent(this.formatCompletedItem(params.item))
        }),
        client.on("item/agentMessage/delta", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
          const delta = String(params.delta ?? "")
          answer += delta
          transcript += delta
          callbacks.onDelta?.(delta)
        }),
        client.on("item/plan/delta", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
          appendStreamEvent(String(params.delta ?? ""))
        }),
        client.on("item/reasoning/summaryTextDelta", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
          appendStreamEvent(String(params.delta ?? ""))
        }),
        client.on("item/commandExecution/outputDelta", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
          const text = String(params.delta ?? params.output ?? "")
          if (text) appendStreamEvent(`\n\n\`\`\`text\n${text}\n\`\`\``)
        }),
        client.on("item/fileChange/outputDelta", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
          appendStreamEvent(String(params.delta ?? params.output ?? ""))
        }),
        client.on("turn/completed", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
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
      } catch (error: any) {
        if (this.isThreadNotFoundError(error)) {
          try {
            this.codexThreadId = null
            setActiveSessionId(null)
            threadId = await this.startThread(client, configuredCwd)
            setActiveSessionId(threadId)
            await startTurn()
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
    const client = await this.getClient(configuredCwd)
    await this.ensureThread(client, configuredCwd)
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
      ready: Boolean(this.client && this.codexThreadId && this.clientKey === this.getClientKey(configuredCwd)),
      threadId: this.codexThreadId,
      cwd: configuredCwd,
      model: this.modelName,
    }
  }

  public async chat(message: string): Promise<string> {
    return this.streamAnswer({ message })
  }

  public clearChatHistory(): void {
    this.codexThreadId = null
  }

  public async listChatSessions(): Promise<HistoryIndexItem[]> {
    const client = await this.getClient(this.resolveWorkingDirectory(getLaunchWorkingDirectory(getAppSettings())))
    const response = await client.request("thread/list", {
      limit: 100,
      archived: false,
      sourceKinds: ["appServer"],
      sortKey: "updated_at",
      sortDirection: "desc",
    })
    const threads = Array.isArray(response?.data) ? response.data : []
    return threads
      .filter((thread: any) => String(thread?.preview ?? thread?.name ?? "").trim())
      .map((thread: any) => this.threadToIndexItem(thread))
  }

  public async getChatSession(threadId: string): Promise<ChatSession | null> {
    if (!threadId) return null
    const client = await this.getClient(this.resolveWorkingDirectory(getLaunchWorkingDirectory(getAppSettings())))
    try {
      const response = await client.request("thread/read", { threadId, includeTurns: true })
      return this.threadToChatSession(response?.thread)
    } catch (error) {
      if (this.isThreadNotFoundError(error)) return null
      throw error
    }
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
      try {
        await this.ensureThread(client, cwd)
      } catch (error) {
        console.warn("Codex thread warmup failed before model discovery:", error)
      }
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
    if (activeSessionId) {
      try {
        return await this.resumeThread(client, activeSessionId, cwd)
      } catch (error) {
        if (!this.isThreadNotFoundError(error)) throw error
        setActiveSessionId(null)
      }
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
    setActiveSessionId(this.codexThreadId)
    return this.codexThreadId
  }

  private resolveWorkingDirectory(cwd: string | undefined): string {
    const resolved = cwd?.trim() || getDirectWorkingDirectory()
    fs.mkdirSync(resolved, { recursive: true })
    return resolved
  }

  private isThreadNotFoundError(error: unknown): boolean {
    return /thread not found/i.test(error instanceof Error ? error.message : String(error))
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

  private threadToChatSession(thread: any): ChatSession | null {
    if (!thread?.id) return null
    const messages = this.threadToMessages(thread)
    return {
      ...this.threadToIndexItem(thread),
      workingDirectory: typeof thread.cwd === "string" ? thread.cwd : undefined,
      codexThreadId: thread.id,
      messages,
    }
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
    return turn.items
      .map((item: any, index: number) => this.threadItemToMessage(item, createdAt, index))
      .filter((message: ChatMessage | null): message is ChatMessage => Boolean(message))
  }

  private threadItemToMessage(item: any, createdAt: string, index: number): ChatMessage | null {
    const id = String(item?.id ?? `item-${index}`)
    switch (item?.type) {
      case "userMessage": {
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
      case "agentMessage":
        if (!String(item.text ?? "").trim()) return null
        return { id, role: "assistant", content: String(item.text), createdAt }
      case "plan":
        return { id, role: "assistant", content: String(item.text ?? ""), createdAt }
      case "reasoning": {
        const summary = Array.isArray(item.summary) ? item.summary.join("\n\n") : ""
        const content = Array.isArray(item.content) ? item.content.join("\n\n") : ""
        const text = [summary, content].filter(Boolean).join("\n\n")
        return text ? { id, role: "assistant", content: text, createdAt } : null
      }
      case "webSearch":
        return { id, role: "assistant", content: `_Searched the web${this.describeWebSearch(item)}._`, createdAt }
      case "commandExecution": {
        const command = String(item.command ?? "command")
        const output = String(item.aggregatedOutput ?? "").trim()
        const status = item.exitCode === null || item.exitCode === undefined ? String(item.status ?? "completed") : `exit ${item.exitCode}`
        return {
          id,
          role: "assistant",
          content: [`_Ran command: \`${this.truncateInline(command)}\` (${status})._`, output ? `\n\`\`\`text\n${output}\n\`\`\`` : ""].join(""),
          createdAt,
        }
      }
      case "fileChange":
        return { id, role: "assistant", content: "_Applied file changes._", createdAt }
      case "mcpToolCall":
        return { id, role: "assistant", content: `_Used ${this.truncateInline(String(item.server ?? "app"))}: ${this.truncateInline(String(item.tool ?? "tool"))}._`, createdAt }
      case "dynamicToolCall":
        return { id, role: "assistant", content: `_Used tool: ${this.truncateInline(String(item.tool ?? "tool"))}._`, createdAt }
      default:
        return null
    }
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
