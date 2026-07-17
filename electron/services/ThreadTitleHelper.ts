import { generateObject } from "ai"
import { codexExec } from "ai-sdk-provider-codex-cli"
import fs from "fs"
import os from "os"
import { z } from "zod"

const TITLE_FALLBACK = "New session"
const TITLE_MAX_LENGTH = 28
const CODEX_TITLE_TIMEOUT_MS = 180_000
const CODEX_TITLE_REASONING_EFFORT = "low"
const threadTitleSchema = z.object({ title: z.string() })

export function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim()
  if (trimmedCurrentTitle === TITLE_FALLBACK) return true

  const trimmedTitleSeed = titleSeed?.trim()
  return Boolean(trimmedTitleSeed) && trimmedCurrentTitle === trimmedTitleSeed
}

export function sanitizeThreadTitle(raw: string): string {
  const normalized =
    raw
      .trim()
      .split(/\r?\n/g)[0]
      ?.trim()
      .replace(/^['"`]+|['"`]+$/g, "")
      .trim()
      .replace(/\s+/g, " ") ?? ""

  if (!normalized) return TITLE_FALLBACK
  if (normalized.length <= TITLE_MAX_LENGTH) return normalized
  return `${normalized.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`
}

function buildThreadTitlePrompt(input: { message: string; imageCount: number }): string {
  const rules = [
    "Title should summarize the user's request, not restate it verbatim.",
    "Keep it extremely short and specific (2-4 words, 28 characters max).",
    "Prefer compact noun phrases like 'History UI polish' or 'Fix auth retry'.",
    "Avoid quotes, filler, prefixes, and trailing punctuation.",
    "If images are attached, use them as primary context for visual/UI issues.",
  ]

  return [
    "You write concise thread titles for coding conversations.",
    "Return a JSON object with key: title.",
    "Rules:",
    ...rules.map(rule => `- ${rule}`),
    "",
    input.imageCount
      ? `Attachments: ${input.imageCount} screenshot${input.imageCount === 1 ? "" : "s"}.`
      : "",
    "",
    "User message:",
    input.message.trim() || "Solve the attached screenshot.",
  ].filter(Boolean).join("\n")
}

export async function generateThreadTitle(input: {
  message: string
  imagePaths?: string[]
  workingDirectory?: string
  model: string
}): Promise<string | null> {
  const imagePaths = (input.imagePaths ?? []).filter(imagePath => {
    try {
      return fs.statSync(imagePath).isFile()
    } catch {
      return false
    }
  })
  const result = await generateObject({
    model: codexExec(input.model, {
      cwd: input.workingDirectory || process.cwd() || os.homedir(),
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalMode: "never",
      reasoningEffort: CODEX_TITLE_REASONING_EFFORT,
      logger: false,
    }),
    schema: threadTitleSchema,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildThreadTitlePrompt({ message: input.message, imageCount: imagePaths.length }) },
          ...imagePaths.map(imagePath => ({ type: "image" as const, image: fs.readFileSync(imagePath) })),
        ],
      },
    ],
    abortSignal: AbortSignal.timeout(CODEX_TITLE_TIMEOUT_MS),
  })

  const title = sanitizeThreadTitle(result.object.title)
    return title === TITLE_FALLBACK ? null : title
}
