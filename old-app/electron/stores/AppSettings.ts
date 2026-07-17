import { z } from "zod";
import { readJsonFile, statePath, writeJsonFile } from "./jsonStorage"

export const directoryProfileSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const appSettingsSchema = z.object({
  model: z.string().default("gpt-5.5"),
  stealthEnabled: z.boolean().default(true),
  mode: z.enum(["simpleQA", "coding"]).default("simpleQA"),
  // concise = just give me the answer (answer only for simpleQA, answer and code for coding)
  // -> {answer, code(if coding)}
  // thorough = answer, thoughts, why, code
  responseType: z.enum(["concise", "thorough"]).default("concise"),
  codingLanguage: z.string().default("javascript"),
  // Optional natural language for the response (e.g. "English", "Spanish", "Japanese").
  // Empty string means no preference — let the model decide based on the input.
  responseLanguage: z.string().default(""),
  // Max height of the solutions/answer panel in pixels.
  answerHeight: z.number().min(200).max(1400).default(600),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).default("low"),
  webSearchEnabled: z.boolean().default(false),
  launchMode: z.enum(["direct", "directory"]).default("direct"),
  selectedDirectoryId: z.string().nullable().default(null),
  directoryProfiles: z.array(directoryProfileSchema).default([]),
  // Legacy setting retained only for migration from older builds.
  workingDirectory: z.string().default(""),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type DirectoryProfile = z.infer<typeof directoryProfileSchema>;

const SETTINGS_FILE = statePath("app-settings.json")


export function getAppSettings(): AppSettings {
  const parsed = appSettingsSchema.catch(appSettingsSchema.parse({})).parse(readJsonFile(SETTINGS_FILE) ?? {})
  if (parsed.workingDirectory && parsed.directoryProfiles.length === 0) {
    const timestamp = new Date().toISOString()
    return appSettingsSchema.parse({
      ...parsed,
      launchMode: "directory",
      selectedDirectoryId: "legacy-working-directory",
      directoryProfiles: [
        {
          id: "legacy-working-directory",
          title: parsed.workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) || "Working directory",
          path: parsed.workingDirectory,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    })
  }
  return parsed
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = appSettingsSchema.parse({ ...getAppSettings(), ...patch })
  try {
    writeJsonFile(SETTINGS_FILE, next)
  } catch (error) {
    console.error("Failed to save app settings:", error)
  }
  return next
}

export function getSelectedDirectory(settings = getAppSettings()): DirectoryProfile | null {
  if (settings.launchMode !== "directory" || !settings.selectedDirectoryId) return null
  return settings.directoryProfiles.find(profile => profile.id === settings.selectedDirectoryId) ?? null
}

export function getLaunchWorkingDirectory(settings = getAppSettings()): string | undefined {
  return getSelectedDirectory(settings)?.path
}

export function getDirectThreadsDirectory(): string {
  return statePath("direct_threads")
}

export function getDirectWorkingDirectory(): string {
  return getDirectThreadsDirectory()
}
