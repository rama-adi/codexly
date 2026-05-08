import os from "os"
import { getAppSettings, getLaunchWorkingDirectory, updateAppSettings } from "./AppSettings"
import { CodexAppServerClient } from "./CodexAppServerClient"
import {
  appendChatMessage,
  embedMessageScreenshots,
  getActiveSessionId,
  getChatSession,
  updateChatSessionTitle,
} from "./HistoryStore"
import { getPersonalizationConfig } from "./PersonalizationStore"

type ModelOption = { id: string; name: string }
type StreamCallbacks = {
  onStart?: () => void
  onDelta?: (delta: string) => void
  onComplete?: (text: string) => void
  onError?: (error: Error) => void
  onHistoryChanged?: () => void
}

const DEFAULT_MODEL = "gpt-5.4"
const FALLBACK_MODELS: ModelOption[] = [
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.2", name: "GPT-5.2" },
]

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
    const threadId = await this.ensureThread(client, configuredCwd)
    const prompt = this.buildPrompt(input.message, input.imagePaths ?? [])
    const userInput = [
      { type: "text", text: prompt },
      ...(input.imagePaths ?? []).map(path => ({ type: "localImage", path })),
    ]

    callbacks.onStart?.()
    const userSession = appendChatMessage(
      {
        role: "user",
        content: input.message?.trim() || "Solve the attached screenshot.",
        screenshotPaths: input.imagePaths,
      },
      {
        titleHint: input.message || "Screenshot session",
        workingDirectory: configuredCwd,
        codexThreadId: threadId,
        embedScreenshots: false,
      }
    )
    const userMessageId = userSession.messages.at(-1)?.id

    let answer = ""
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
        appendChatMessage(
          { role: "assistant", content: answer },
          { workingDirectory: configuredCwd, codexThreadId: threadId }
        )
        this.syncCodexTitle(client, threadId, userSession.id, callbacks.onHistoryChanged)
        callbacks.onComplete?.(answer)
        resolve(answer)
      }

      cleanups.push(
        client.on("turn/started", params => {
          if (params?.threadId === threadId) turnId = params.turnId
        }),
        client.on("item/agentMessage/delta", params => {
          if (params?.threadId !== threadId) return
          if (turnId && params.turnId !== turnId) return
          const delta = String(params.delta ?? "")
          answer += delta
          callbacks.onDelta?.(delta)
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

      try {
        await client.request("turn/start", {
          threadId,
          input: userInput,
          ...(configuredCwd ? { cwd: configuredCwd } : {}),
          model: this.modelName,
          personality: "pragmatic",
          effort: settings.reasoningEffort,
          summary: "none",
        })
        if (userMessageId && input.imagePaths?.length) {
          setImmediate(() => {
            embedMessageScreenshots(userSession.id, userMessageId)
            callbacks.onHistoryChanged?.()
          })
        }
      } catch (error: any) {
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
      ready: Boolean(this.client && this.codexThreadId && this.clientKey === (configuredCwd || "__direct__")),
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
      const client = await this.getClient(getLaunchWorkingDirectory(getAppSettings()))
      const result = await client.request("model/list", {})
      const models = Array.isArray(result?.models) ? result.models : []
      const discovered = models
        .map((model: any) => ({ id: String(model.id ?? model.slug ?? ""), name: String(model.name ?? model.id ?? "") }))
        .filter((model: ModelOption) => model.id)
      return mergeModels(discovered, FALLBACK_MODELS)
    } catch {
      return FALLBACK_MODELS
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
    const spawnCwd = cwd || process.cwd() || os.homedir()
    const key = cwd || "__direct__"
    if (!this.client || this.clientKey !== key) {
      this.client?.stop()
      this.client = new CodexAppServerClient(spawnCwd)
      this.clientKey = key
      this.codexThreadId = null
      await this.client.start()
    }
    return this.client
  }

  private async ensureThread(client: CodexAppServerClient, cwd: string | undefined): Promise<string> {
    if (this.codexThreadId) return this.codexThreadId
    const response = await client.request("thread/start", {
      ...(cwd ? { cwd } : {}),
      model: this.modelName,
      personality: "pragmatic",
      sandbox: "read-only",
      approvalPolicy: "never",
      serviceName: "codexly",
      sessionStartSource: getActiveSessionId() ? "startup" : "clear",
    })
    this.codexThreadId = response?.thread?.id ?? response?.threadId ?? response?.id
    if (!this.codexThreadId) throw new Error("Codex app-server did not return a thread id")
    return this.codexThreadId
  }

  private syncCodexTitle(
    client: CodexAppServerClient,
    threadId: string,
    sessionId: string,
    onHistoryChanged?: () => void
  ): void {
    setImmediate(async () => {
      try {
        for (const delay of [0, 500, 1500]) {
          if (delay) await new Promise(resolve => setTimeout(resolve, delay))
          const response = await client.request("thread/read", {
            threadId,
            includeTurns: false,
          })
          const title = response?.thread?.name || response?.thread?.preview
          if (typeof title === "string" && title.trim()) {
            updateChatSessionTitle(sessionId, title)
            onHistoryChanged?.()
            return
          }
        }
      } catch (error) {
        console.warn("Failed to sync Codex thread title:", error)
      }
    })
  }

  private buildPrompt(message = "", imagePaths: string[]): string {
    const settings = getAppSettings()
    const personalization = getPersonalizationConfig()
    const session = getActiveSessionId() ? getChatSession(getActiveSessionId()!) : null
    const history = session?.messages.slice(-8).map(item => `${item.role}: ${item.content}`).join("\n")
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
      history ? `Recent chat history:\n${history}` : "",
      screenshotInstructions,
      message.trim() ? `User message:\n${message.trim()}` : "User message:\nSolve the attached screenshot.",
    ].filter(Boolean).join("\n\n") + customInstructions
  }

  private loadSavedModel(): string {
    return getAppSettings().model || DEFAULT_MODEL
  }
}

function mergeModels(...groups: ModelOption[][]): ModelOption[] {
  const seen = new Set<string>()
  const merged: ModelOption[] = []
  for (const group of groups) {
    for (const model of group) {
      if (!model.id || seen.has(model.id)) continue
      seen.add(model.id)
      merged.push(model)
    }
  }
  return merged
}
