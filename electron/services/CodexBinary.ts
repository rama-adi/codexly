import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"

function candidateDirectories(): string[] {
  const home = os.homedir()
  if (process.platform === "win32") {
    return [
      path.join(home, "AppData", "Roaming", "npm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".local", "bin"),
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Codex") : "",
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Codex") : "",
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Codex") : "",
    ].filter(Boolean)
  }

  const unixDirectories = [
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".nvm", "versions", "node"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
  return unixDirectories
}

function expandedPath(): string {
  const existing = process.env.PATH?.trim() ?? ""
  const paths = new Set(existing.split(path.delimiter).filter(Boolean))
  for (const directory of candidateDirectories()) {
    if (!directory.includes(".nvm")) {
      paths.add(directory)
      continue
    }

    try {
      const versions = fs.readdirSync(directory, { withFileTypes: true })
      for (const version of versions) {
        if (version.isDirectory()) paths.add(path.join(directory, version.name, "bin"))
      }
    } catch {
      // nvm is optional.
    }
  }
  return [...paths].join(path.delimiter)
}

export function codexSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: process.env.HOME?.trim() || os.homedir(),
    PATH: expandedPath(),
  }
}

export function resolveCodexBinary(): string {
  const configured = process.env.CODEX_BIN?.trim()
  if (configured && isExecutable(configured)) return configured

  const pathEnv = expandedPath()
  const candidates: string[] = []
  for (const directory of pathEnv.split(path.delimiter)) {
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
  const result = spawnSync(shell, ["-lc", "command -v codex"], {
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
