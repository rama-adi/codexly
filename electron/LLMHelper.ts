import { generateText, generateObject, ModelMessage, LanguageModel } from "ai"
import { z } from "zod"
import fs from "fs"
import { getAppSettings, updateAppSettings } from "./AppSettings"

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
    code: z.string(),
    problem_statement: z.string(),
    context: z.string(),
    suggested_responses: z.array(z.string()),
    reasoning: z.string(),
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
  private readonly systemPrompt = `You are Wingman, a terse assistant. Answer in 1-3 short sentences. No preamble, no headings, no bullet lists unless explicitly asked. Skip reasoning unless asked. Just give the answer.`

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

  public async extractProblemFromImages(imagePaths: string[]): Promise<ProblemInfo> {
    const imageParts = await Promise.all(imagePaths.map(p => this.imagePart(p)))
    const prompt = `${this.systemPrompt}\n\nAnalyze these images and extract the problem statement, context, suggested responses, and reasoning.`
    const { object } = await generateObject({
      model: await this.getModel(),
      schema: problemSchema,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageParts] }],
    })
    return object
  }

  public async generateSolution(problemInfo: any): Promise<SolutionInfo> {
    const prompt = `${this.systemPrompt}\n\nGiven this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nProvide a solution with code/main answer, restated problem, context, suggested responses, and reasoning.`
    const { object } = await generateObject({
      model: await this.getModel(),
      schema: solutionSchema,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    })
    return object
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]): Promise<SolutionInfo> {
    const imageParts = await Promise.all(debugImagePaths.map(p => this.imagePart(p)))
    const prompt = `${this.systemPrompt}\n\nGiven:\n1. Original problem: ${JSON.stringify(problemInfo, null, 2)}\n2. Current response: ${currentCode}\n3. Debug information in the provided images\n\nAnalyze the debug information and produce an updated solution.`
    const { object } = await generateObject({
      model: await this.getModel(),
      schema: solutionSchema,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageParts] }],
    })
    return object
  }

  public async analyzeImageFile(imagePath: string) {
    const imagePart = await this.imagePart(imagePath)
    const prompt = `${this.systemPrompt}\n\nLook at the image and answer directly in 1-3 sentences. No suggestions, no follow-up actions unless asked.`
    const text = await this.runText([
      { role: "user", content: [{ type: "text", text: prompt }, imagePart] },
    ])
    return { text, timestamp: Date.now() }
  }

  public async chat(message: string): Promise<string> {
    const { text } = await generateText({ model: await this.getModel(), prompt: message })
    return text
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
