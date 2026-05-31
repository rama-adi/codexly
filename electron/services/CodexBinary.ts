import fs from "fs"
import os from "os"
import path from "path"

function candidateDirectories(): string[] {
  const home = os.homedir()
  return [
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".nvm", "versions", "node"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
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
    PATH: expandedPath(),
  }
}

export function resolveCodexBinary(): string {
  const configured = process.env.CODEX_BIN?.trim()
  if (configured) return configured

  const pathEnv = expandedPath()
  for (const directory of pathEnv.split(path.delimiter)) {
    const candidate = path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex")
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Keep searching.
    }
  }

  return "codex"
}

export function codexNotFoundMessage(command: string, cwd?: string): string {
  return [
    `Could not find the Codex CLI binary (${command}).`,
    cwd ? `Also verify the configured cwd exists: ${cwd}.` : "",
    "Set CODEX_BIN to the absolute path of your codex executable, or install codex in ~/.bun/bin, ~/.local/bin, /opt/homebrew/bin, or /usr/local/bin.",
  ].filter(Boolean).join(" ")
}
