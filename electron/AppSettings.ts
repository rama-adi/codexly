import fs from "fs"
import os from "os"
import path from "path"

export type AppSettings = {
  model: string
  stealthEnabled: boolean
}

const SETTINGS_FILE = path.join(os.homedir(), ".codexlysetting.json")

const DEFAULT_SETTINGS: AppSettings = {
  model: "gpt-5.4",
  stealthEnabled: true,
}

export function getAppSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8")
    const parsed = JSON.parse(raw)
    return {
      model: typeof parsed?.model === "string" && parsed.model.trim()
        ? parsed.model.trim()
        : DEFAULT_SETTINGS.model,
      stealthEnabled: typeof parsed?.stealthEnabled === "boolean"
        ? parsed.stealthEnabled
        : DEFAULT_SETTINGS.stealthEnabled,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getAppSettings(), ...patch }
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf-8")
  } catch (error) {
    console.error("Failed to save app settings:", error)
  }
  return next
}

