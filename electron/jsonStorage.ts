import fs from "fs"
import os from "os"
import path from "path"

export const BASE_DIR = process.env.CODEXLY_HOME?.trim() || path.join(os.homedir(), ".codexly")
export const STATE_DIR = path.join(BASE_DIR, "userdata")

export function statePath(...segments: string[]): string {
  return path.join(STATE_DIR, ...segments)
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
  } catch {
    return null
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath)
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
  fs.renameSync(tempPath, filePath)
}
