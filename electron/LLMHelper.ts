import { generateText, generateObject, ModelMessage, LanguageModel } from "ai"
import { z } from "zod"
import fs from "fs"

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

export class LLMHelper {
  private modelName = "gpt-5.4"
  private providerPromise: Promise<ProviderFactory> | null = null
  private readonly systemPrompt = `You are Wingman, a terse assistant. Answer in 1-3 short sentences. No preamble, no headings, no bullet lists unless explicitly asked. Skip reasoning unless asked. Just give the answer.`

  constructor() {
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

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const text = await this.chat("Hello")
      return text ? { success: true } : { success: false, error: "Empty response from OpenAI" }
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) }
    }
  }
}
