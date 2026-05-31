import os from "os"
import { getAppSettings, getLaunchWorkingDirectory, updateAppSettings } from "../stores/AppSettings"
import { CodexAppServerClient } from "./CodexAppServerClient"
import {
  appendChatMessage,
  embedMessageScreenshots,
  getActiveSessionId,
  getChatSession,
  updateChatSessionCodexThreadId,
  updateChatSessionTitle,
} from "../stores/HistoryStore"
import { getPersonalizationConfig } from "../stores/PersonalizationStore"
import { canReplaceThreadTitle, generateThreadTitle, sanitizeThreadTitle } from "./ThreadTitleHelper"

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
    const configuredCwd = input.workingDirectory || getLaunchWorkingDirectory(settings)
    const client = await this.getClient(configuredCwd)
    let threadId = await this.ensureThread(client, configuredCwd)
    const prompt = this.buildPrompt(input.message, input.imagePaths ?? [])
    const userInput = [
      { type: "text", text: prompt },
      ...(input.imagePaths ?? []).map(path => ({ type: "localImage", path })),
    ]
    const titleSeed = sanitizeThreadTitle(input.message?.trim() || "Screenshot session")

    callbacks.onStart?.()
    const userSession = appendChatMessage(
      {
        role: "user",
        content: input.message?.trim() || "Solve the attached screenshot.",
        screenshotPaths: input.imagePaths,
      },
      {
        titleHint: titleSeed,
        workingDirectory: configuredCwd,
        codexThreadId: threadId,
        embedScreenshots: false,
      }
    )
    const userMessageId = userSession.messages.at(-1)?.id
    this.generateTitleForFirstTurn({
      sessionId: userSession.id,
      titleSeed,
      message: input.message?.trim() || "Solve the attached screenshot.",
      imagePaths: input.imagePaths,
      workingDirectory: configuredCwd,
      onHistoryChanged: callbacks.onHistoryChanged,
    })

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
        appendChatMessage(
          { role: "assistant", content },
          { workingDirectory: configuredCwd, codexThreadId: threadId }
        )
        callbacks.onComplete?.(content)
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
        if (userMessageId && input.imagePaths?.length) {
          setImmediate(() => {
            embedMessageScreenshots(userSession.id, userMessageId)
            callbacks.onHistoryChanged?.()
          })
        }
      } catch (error: any) {
        if (this.isThreadNotFoundError(error)) {
          try {
            this.codexThreadId = null
            updateChatSessionCodexThreadId(userSession.id, undefined)
            threadId = await this.startThread(client, configuredCwd)
            updateChatSessionCodexThreadId(userSession.id, threadId)
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
    const configuredCwd = workingDirectory || getLaunchWorkingDirectory(settings)
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
    const configuredCwd = workingDirectory || getLaunchWorkingDirectory(settings)
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
      const cwd = getLaunchWorkingDirectory(getAppSettings())
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
      await this.getClient(getLaunchWorkingDirectory(getAppSettings()))
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) }
    }
  }

  private async getClient(cwd: string | undefined): Promise<CodexAppServerClient> {
    const settings = getAppSettings()
    const spawnCwd = cwd || process.cwd() || os.homedir()
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
    return `${cwd || "__direct__"}::web_search:${webSearchEnabled ? "live" : "disabled"}`
  }

  private async ensureThread(client: CodexAppServerClient, cwd: string | undefined): Promise<string> {
    if (this.codexThreadId) return this.codexThreadId
    const activeSessionId = getActiveSessionId()
    const activeSession = activeSessionId ? getChatSession(activeSessionId) : null
    if (activeSession?.codexThreadId) {
      this.codexThreadId = activeSession.codexThreadId
      return this.codexThreadId
    }

    return this.startThread(client, cwd)
  }

  private async startThread(client: CodexAppServerClient, cwd: string | undefined): Promise<string> {
    const activeSessionId = getActiveSessionId()
    const response = await client.request("thread/start", {
      ...(cwd ? { cwd } : {}),
      config: { web_search: getAppSettings().webSearchEnabled ? "live" : "disabled" },
      model: this.modelName,
      personality: "pragmatic",
      sandbox: "read-only",
      approvalPolicy: "never",
      serviceName: "codexly",
      sessionStartSource: activeSessionId ? "startup" : "clear",
    })
    this.codexThreadId = response?.thread?.id ?? response?.threadId ?? response?.id
    if (!this.codexThreadId) throw new Error("Codex app-server did not return a thread id")
    return this.codexThreadId
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

  private generateTitleForFirstTurn(input: {
    sessionId: string
    titleSeed: string
    message: string
    imagePaths?: string[]
    workingDirectory?: string
    onHistoryChanged?: () => void
  }): void {
    setImmediate(async () => {
      try {
        const session = getChatSession(input.sessionId)
        if (!session || session.messages.length !== 1) return
        if (!canReplaceThreadTitle(session.title, input.titleSeed)) return

        const title = await generateThreadTitle({
          message: input.message,
          imagePaths: input.imagePaths,
          workingDirectory: input.workingDirectory,
          model: this.modelName,
        })
        if (!title) return

        const latestSession = getChatSession(input.sessionId)
        if (!latestSession || !canReplaceThreadTitle(latestSession.title, input.titleSeed)) return
        updateChatSessionTitle(input.sessionId, title)
        input.onHistoryChanged?.()
      } catch (error) {
        console.warn("Failed to generate Codex thread title:", error)
      }
    })
  }

  private buildPrompt(message = "", imagePaths: string[]): string {
    const settings = getAppSettings()
    const personalization = getPersonalizationConfig()
    const modeInstructions =
      personalization.mode === "coding"
        ? `Mode: coding. Provide code, implementation guidance, or debugging detail when useful. Use ${settings.codingLanguage || "javascript"} unless the user or screenshot clearly requires another language.`
        : "Mode: question. Answer directly and avoid code unless the user explicitly asks for it."
    const verbosityInstructions =
      personalization.verbosity === "verbose"
        ? "Verbosity: verbose. Break the problem into clear steps and explain the reasoning like a human would."
        : "Verbosity: concise. Answer only."
    const languageInstructions = settings.responseLanguage
      ? `Respond in ${settings.responseLanguage}. Keep code and identifiers unchanged.`
      : ""
    const screenshotInstructions = imagePaths.length
      ? `There ${imagePaths.length === 1 ? "is" : "are"} ${imagePaths.length} screenshot${imagePaths.length === 1 ? "" : "s"} attached. Read them directly and answer in streamed markdown.`
      : ""
    const customInstructions =
      personalization.customInstructionsEnabled && personalization.customInstructions.trim()
        ? `\n\nUser-enabled custom instructions:\n${personalization.customInstructions.trim()}`
        : ""

    return [
      "You are Codexly, a direct assistant. Return only markdown for the answer.",
      modeInstructions,
      verbosityInstructions,
      languageInstructions,
      screenshotInstructions,
      message.trim() ? `User message:\n${message.trim()}` : "User message:\nSolve the attached screenshot.",
    ].filter(Boolean).join("\n\n") + customInstructions
  }

  private loadSavedModel(): string {
    return getAppSettings().model || DEFAULT_MODEL
  }
}
