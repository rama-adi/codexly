import fs from "fs"
import os from "os"
import path from "path"
import { z } from "zod";

export const appSettingsSchema = z.object({
  model: z.string().default("gpt-5.4"),
  stealthEnabled: z.boolean().default(true)
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

