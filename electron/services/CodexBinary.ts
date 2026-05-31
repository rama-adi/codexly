import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"

export function codexSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: process.env.HOME?.trim() || os.homedir(),
    PATH: process.env.PATH?.trim() ?? "",
  }
}

export function resolveCodexBinary(): string {
  const configured = process.env.CODEX_BIN?.trim()
  if (configured && isExecutable(configured)) return configured

  const pathEnv = codexSpawnEnv().PATH ?? ""
  const candidates: string[] = []
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue
    for (const executableName of codexExecutableNames()) {
      const candidate = path.join(directory, executableName)
      if (isExecutable(candidate) && !candidates.includes(candidate)) candidates.push(candidate)
    }
  }
  const shellCandidate = resolveCodexFromShell()
  if (shellCandidate && !candidates.includes(shellCandidate)) candidates.push(shellCandidate)
  for (const windowsCandidate of resolveCodexFromWindowsPath()) {
    if (!candidates.includes(windowsCandidate)) candidates.push(windowsCandidate)
  }

  return candidates.sort(compareCodexBinaryVersions).at(0) ?? codexExecutableNames()[0]
}

function codexExecutableNames(): string[] {
  if (process.platform !== "win32") return ["codex"]
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map(extension => extension.trim().toLowerCase())
    .filter(Boolean)
  return ["codex", ...extensions.map(extension => `codex${extension}`)]
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function compareCodexBinaryVersions(left: string, right: string): number {
  const leftVersion = getCodexVersion(left)
  const rightVersion = getCodexVersion(right)
  if (!leftVersion && !rightVersion) return 0
  if (!leftVersion) return 1
  if (!rightVersion) return -1

  for (let index = 0; index < 3; index += 1) {
    const diff = rightVersion[index] - leftVersion[index]
    if (diff !== 0) return diff
  }
  return 0
}

function getCodexVersion(command: string): [number, number, number] | null {
  const result = spawnSync(command, ["--version"], {
    env: codexSpawnEnv(),
    encoding: "utf-8",
    timeout: 2_000,
  })
  const match = `${result.stdout ?? ""} ${result.stderr ?? ""}`.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/i)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function resolveCodexFromShell(): string | null {
  if (process.platform === "win32") return null
  const shell = process.env.SHELL?.trim() || "/bin/sh"
  const args = shell.endsWith("sh") && !shell.endsWith("bash") && !shell.endsWith("zsh")
    ? ["-c", "command -v codex"]
    : ["-lc", "command -v codex"]
  const result = spawnSync(shell, args, {
    env: codexSpawnEnv(),
    encoding: "utf-8",
    timeout: 2_000,
  })
  const candidate = result.stdout.trim().split(/\r?\n/)[0]
  return candidate && isExecutable(candidate) ? candidate : null
}

function resolveCodexFromWindowsPath(): string[] {
  if (process.platform !== "win32") return []
  const result = spawnSync("where.exe", ["codex"], {
    env: codexSpawnEnv(),
    encoding: "utf-8",
    timeout: 2_000,
    shell: false,
  })
  return result.stdout
    .split(/\r?\n/)
    .map(candidate => candidate.trim())
    .filter(candidate => candidate && isExecutable(candidate))
}

export function codexNotFoundMessage(command: string, cwd?: string): string {
  return [
    `Could not find the Codex CLI binary (${command}).`,
    cwd ? `Also verify the configured cwd exists: ${cwd}.` : "",
    "Set CODEX_BIN to the absolute path of your codex executable, or install codex somewhere on PATH.",
  ].filter(Boolean).join(" ")
}
