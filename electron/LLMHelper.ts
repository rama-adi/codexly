import { generateText, generateObject, ModelMessage, LanguageModel } from "ai"
import { z } from "zod"
import fs from "fs"
import { AppSettings, getAppSettings, updateAppSettings } from "./AppSettings"

// `openai-oauth-provider` is ESM-only; load it dynamically so this CommonJS
// build can still consume it at runtime. The Function-constructor trick stops
// TS from rewriting the dynamic import into `require`.
const dynamicImport = new Function("s", "return import(s)") as <T = any>(s: string) => Promise<T>

const problemSchema = z.object({
  problem_statement: z.string(),
  context: z.string(),
  suggested_responses: z.array(z.string()),
  reasoning: z.string(),
})

const solutionSchema = z.object({
  solution: z.object({
    answer: z.string(),
    code: z.string(),
    problem_statement: z.string(),
    context: z.string(),
    suggested_responses: z.array(z.string()),
    reasoning: z.string(),
    thoughts: z.array(z.string()),
    why: z.string(),
    time_complexity: z.string(),
    space_complexity: z.string(),
  }),
})

export type ProblemInfo = z.infer<typeof problemSchema>
export type SolutionInfo = z.infer<typeof solutionSchema>

type ProviderFactory = (modelId: string) => LanguageModel
type ModelOption = { id: string; name: string }

const DEFAULT_MODEL = "gpt-5.4"
const FALLBACK_MODELS: ModelOption[] = [
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
]

export class LLMHelper {
  private modelName = DEFAULT_MODEL
  private providerPromise: Promise<ProviderFactory> | null = null
  private chatHistory: ModelMessage[] = []
  private readonly baseSystemPrompt = `You are Wingman, a terse assistant. No preamble. Be direct and useful.`

  constructor() {
    this.modelName = this.loadSavedModel()
    console.log(`[LLMHelper] Using OpenAI model: ${this.modelName}`)
  }

  private async getModel(): Promise<LanguageModel> {
    if (!this.providerPromise) {
      this.providerPromise = dynamicImport<{ createOpenAIOAuth: () => ProviderFactory }>("openai-oauth-provider")
        .then(mod => mod.createOpenAIOAuth())
    }
    const provider = await this.providerPromise
    return provider(this.modelName)
  }

  private async imagePart(imagePath: string) {
    const data = await fs.promises.readFile(imagePath)
    return { type: "image" as const, image: data, mediaType: "image/png" }
  }

  private async runText(messages: ModelMessage[]): Promise<string> {
    const { text } = await generateText({ model: await this.getModel(), messages })
    return text
  }

  private getSettings(): AppSettings {
    return getAppSettings()
  }

  private buildPromptInstructions(settings = this.getSettings()): string {
    const codingLanguage = settings.codingLanguage?.trim() || "javascript"
    const modeInstructions =
      settings.mode === "coding"
        ? `Mode: coding. Solve programming problems. Use ${codingLanguage} for code solutions unless the screenshot or user explicitly requires another language. Return a plain-language answer and a complete ${codingLanguage} code solution when code is relevant.`
        : "Mode: simpleQA. Answer the question directly. Do not include code unless the user explicitly asks for it."

    const detailInstructions =
      settings.responseType === "thorough"
        ? "Response type: thorough. Include concise thoughts, why the answer is correct, and complexity for coding tasks."
        : "Response type: concise. Keep the answer short. For coding, include only the answer and code."

    const responseLanguage = settings.responseLanguage?.trim()
    const languageInstructions = responseLanguage
      ? `Respond in ${responseLanguage}. Write all natural-language fields (answer, thoughts, why, problem_statement, context, reasoning, suggested_responses) in ${responseLanguage}. Keep code, identifiers, and technical tokens unchanged.`
      : ""

    return [this.baseSystemPrompt, modeInstructions, detailInstructions, languageInstructions]
      .filter(Boolean)
      .join("\n")
  }

  public async extractProblemFromImages(imagePaths: string[]): Promise<ProblemInfo> {
    const imageParts = await Promise.all(imagePaths.map(p => this.imagePart(p)))
    const prompt = `${this.buildPromptInstructions()}\n\nAnalyze these images and extract the problem statement, context, suggested responses, and reasoning.`
    const { object } = await generateObject({
      model: await this.getModel(),
      schema: problemSchema,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageParts] }],
    })
    return object
  }

  public async generateSolution(problemInfo: any): Promise<SolutionInfo> {
    const settings = this.getSettings()
    const codingLanguage = settings.codingLanguage?.trim() || "javascript"
    const prompt = `${this.buildPromptInstructions(settings)}\n\nGiven this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nReturn JSON matching the schema. Every schema field is required. For simpleQA, put the final response in answer, set code to an empty string, set thoughts to an empty array, and use "N/A" for complexity. For coding, put the explanation/answer in answer and the complete ${codingLanguage} code in code unless the problem explicitly requires another language. In concise mode, keep thoughts/reasoning/why short or empty strings where appropriate.`
    const { object } = await generateObject({
      model: await this.getModel(),
      schema: solutionSchema,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    })
    return object
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]): Promise<SolutionInfo> {
    const imageParts = await Promise.all(debugImagePaths.map(p => this.imagePart(p)))
    const settings = { ...this.getSettings(), mode: "coding" as const }
    const codingLanguage = settings.codingLanguage?.trim() || "javascript"
    const prompt = `${this.buildPromptInstructions(settings)}\n\nGiven:\n1. Original problem: ${JSON.stringify(problemInfo, null, 2)}\n2. Current response: ${currentCode}\n3. Debug information in the provided images\n\nAnalyze the debug information and produce an updated ${codingLanguage} coding solution unless the original response is clearly in another required language. Set answer to what changed, code to the updated code, and include thoughts plus complexity when available.`
    const { object } = await generateObject({
      model: await this.getModel(),
      schema: solutionSchema,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageParts] }],
    })
    return object
  }

  public async analyzeImageFile(imagePath: string) {
    return this.analyzeImageFiles([imagePath])
  }

  public async analyzeImageFiles(imagePaths: string[]) {
    const imageParts = await Promise.all(imagePaths.map(p => this.imagePart(p)))
    const prompt = `${this.buildPromptInstructions()}\n\nLook at the image${imagePaths.length === 1 ? "" : "s"} and answer directly.`
    const text = await this.runText([
      { role: "user", content: [{ type: "text", text: prompt }, ...imageParts] },
    ])
    return { text, timestamp: Date.now() }
  }

  public async chat(message: string): Promise<string> {
    if (this.chatHistory.length === 0) {
      this.chatHistory = [{ role: "system", content: this.buildPromptInstructions() }]
    }

    this.chatHistory.push({ role: "user", content: message })
    const { text } = await generateText({
      model: await this.getModel(),
      messages: this.chatHistory,
    })
    this.chatHistory.push({ role: "assistant", content: text })
    return text
  }

  public clearChatHistory(): void {
    this.chatHistory = []
  }

  public getCurrentProvider(): "openai" {
    return "openai"
  }

  public getCurrentModel(): string {
    return this.modelName
  }

  public setCurrentModel(modelName: string): { provider: "openai"; model: string } {
    const normalized = modelName.trim()
    if (!normalized) {
      throw new Error("Model name is required")
    }

    this.modelName = normalized
    this.saveModel(normalized)
    console.log(`[LLMHelper] Switched OpenAI model: ${this.modelName}`)
    return { provider: "openai", model: this.modelName }
  }

  public async getAvailableModels(): Promise<ModelOption[]> {
    const discovered = await this.discoverModels()
    return mergeModels(discovered, FALLBACK_MODELS)
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const text = await this.chat("Hello")
      return text ? { success: true } : { success: false, error: "Empty response from OpenAI" }
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) }
    }
  }

  private loadSavedModel(): string {
    return getAppSettings().model || DEFAULT_MODEL
  }

  private saveModel(model: string): void {
    updateAppSettings({ model })
  }

  private async discoverModels(): Promise<ModelOption[]> {
    try {
      const mod = await dynamicImport<{
        loadAuthTokens: (options: { fetch: typeof fetch; ensureFresh?: boolean }) => Promise<{
          accessToken: string
          accountId: string
        }>
      }>("openai-oauth-provider")
      const auth = await mod.loadAuthTokens({ fetch, ensureFresh: true })
      const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
      }

      for (const endpoint of [
        "https://chatgpt.com/backend-api/codex/models",
        "https://chatgpt.com/backend-api/codex/model_list",
      ]) {
        const response = await fetch(endpoint, { headers })
        if (!response.ok) continue
        const payload = await response.json()
        const models = extractModelOptions(payload)
        if (models.length > 0) return models
      }
    } catch (error) {
      console.warn("Could not discover OpenAI OAuth models, using fallback list:", error)
    }

    return []
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

function extractModelOptions(value: unknown): ModelOption[] {
  const models: ModelOption[] = []
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit)
      return
    }
    if (!item || typeof item !== "object") return

    const record = item as Record<string, unknown>
    const id = firstString(record.id, record.slug, record.model, record.model_slug, record.name)
    if (id && /^gpt-|^o\d|^codex/.test(id)) {
      models.push({
        id,
        name: firstString(record.title, record.display_name, record.displayName, record.name) ?? formatModelName(id),
      })
    }

    for (const nested of Object.values(record)) {
      if (Array.isArray(nested)) visit(nested)
    }
  }

  visit(value)
  return mergeModels(models)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim()
}

function formatModelName(id: string): string {
  return id
    .split("-")
    .map(part => part.toUpperCase() === "GPT" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
