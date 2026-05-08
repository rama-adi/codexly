import { z } from "zod";
import { readJsonFile, statePath, writeJsonFile } from "./jsonStorage"

export const appSettingsSchema = z.object({
  model: z.string().default("gpt-5.4"),
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
  workingDirectory: z.string().default(""),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const SETTINGS_FILE = statePath("app-settings.json")


export function getAppSettings(): AppSettings {
  return appSettingsSchema.catch(appSettingsSchema.parse({})).parse(readJsonFile(SETTINGS_FILE) ?? {})
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
