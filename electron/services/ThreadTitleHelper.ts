import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { codexSpawnEnv, resolveCodexBinary } from "./CodexBinary"

const TITLE_FALLBACK = "New session"
const TITLE_MAX_LENGTH = 28
const CODEX_TITLE_TIMEOUT_MS = 180_000
const CODEX_TITLE_REASONING_EFFORT = "low"

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

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codexly-title-"))
}

function readGeneratedTitle(outputPath: string): string | null {
  const content = fs.readFileSync(outputPath, "utf8").trim()
  if (!content) return null

  try {
    const parsed = JSON.parse(content)
    return typeof parsed?.title === "string" ? parsed.title : null
  } catch {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
    if (fenced) {
      try {
        const parsed = JSON.parse(fenced.trim())
        return typeof parsed?.title === "string" ? parsed.title : null
      } catch {
        return null
      }
    }
    return null
  }
}

export async function generateThreadTitle(input: {
  message: string
  imagePaths?: string[]
  workingDirectory?: string
  model: string
}): Promise<string | null> {
  const tempDir = makeTempDir()
  const schemaPath = path.join(tempDir, "schema.json")
  const outputPath = path.join(tempDir, "output.json")

  try {
    fs.writeFileSync(
      schemaPath,
      JSON.stringify({
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string" } },
        required: ["title"],
      })
    )
    fs.writeFileSync(outputPath, "")

    const command = resolveCodexBinary()
    const imagePaths = (input.imagePaths ?? []).filter(imagePath => {
      try {
        return fs.statSync(imagePath).isFile()
      } catch {
        return false
      }
    })
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "--model",
      input.model,
      "--config",
      `model_reasoning_effort="${CODEX_TITLE_REASONING_EFFORT}"`,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      ...imagePaths.flatMap(imagePath => ["--image", imagePath]),
      "-",
    ]

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: input.workingDirectory || process.cwd() || os.homedir(),
        env: codexSpawnEnv(),
        shell: process.platform === "win32",
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error("Codex title generation timed out"))
      }, CODEX_TITLE_TIMEOUT_MS)
      let stderr = ""
      let stdout = ""

      child.stdout.on("data", chunk => {
        stdout += String(chunk)
      })
      child.stderr.on("data", chunk => {
        stderr += String(chunk)
      })
      child.once("error", error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", code => {
        clearTimeout(timer)
        if (code === 0) {
          resolve()
          return
        }
        const detail = stderr.trim() || stdout.trim()
        reject(new Error(detail || `Codex title generation exited with code ${code ?? "unknown"}`))
      })
      child.stdin.end(buildThreadTitlePrompt({ message: input.message, imageCount: imagePaths.length }))
    })

    const rawTitle = readGeneratedTitle(outputPath)
    if (!rawTitle) return null

    const title = sanitizeThreadTitle(rawTitle)
    return title === TITLE_FALLBACK ? null : title
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
