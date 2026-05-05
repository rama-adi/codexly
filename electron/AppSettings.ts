import fs from "fs"
import os from "os"
import path from "path"
import { z } from "zod";

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
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const SETTINGS_FILE = path.join(os.homedir(), ".codexlysetting.json")


export function getAppSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8")
    const parsed = JSON.parse(raw)
    return appSettingsSchema.parse(parsed)
  } catch {
    return appSettingsSchema.parse({})
  }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = appSettingsSchema.parse({ ...getAppSettings(), ...patch })
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf-8")
  } catch (error) {
    console.error("Failed to save app settings:", error)
  }
  return next
}

