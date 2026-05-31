import { ChildProcessWithoutNullStreams, spawn } from "child_process"
import readline from "readline"
import { codexNotFoundMessage, codexSpawnEnv, resolveCodexBinary } from "./CodexBinary"

type PendingRequest = {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

type NotificationHandler = (params: any) => void
type RequestHandler = (params: any) => any

let daemonUnavailable = false

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private notificationHandlers = new Map<string, Set<NotificationHandler>>()
  private requestHandlers = new Map<string, RequestHandler>()
  private initialized = false
  private startPromise: Promise<void> | null = null

  constructor(
    private readonly cwd: string,
    private readonly webSearchEnabled: boolean
  ) {
    this.requestHandlers.set("item/tool/requestUserInput", (params) => ({
      answers: Object.fromEntries(
        (params?.questions ?? []).map((question: any) => [
          question.id,
          { answers: question?.options?.[0]?.label ? [question.options[0].label] : ["ok"] },
        ])
      ),
    }))
    this.requestHandlers.set("permissions/requestApproval", () => ({
      permissions: { mode: "read-only" },
      scope: "turn",
    }))
    this.requestHandlers.set("item/commandExecution/requestApproval", () => ({
      decision: "decline",
    }))
    this.requestHandlers.set("item/fileChange/requestApproval", () => ({
      decision: "decline",
    }))
  }

  public on(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set()
    handlers.add(handler)
    this.notificationHandlers.set(method, handlers)
    return () => handlers.delete(handler)
  }

  public async start(): Promise<void> {
    if (this.initialized) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startInternal(): Promise<void> {
    const command = resolveCodexBinary()
    const webSearchMode = this.webSearchEnabled ? "live" : "disabled"
    const configArgs = ["-c", `web_search="${webSearchMode}"`]
    const appServerArgs = await this.resolveAppServerArgs(command, configArgs)

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        this.child = null
        reject(error)
      }

      this.child = spawn(command, appServerArgs, {
        cwd: this.cwd,
        env: codexSpawnEnv(),
        shell: process.platform === "win32",
      })

      this.child.once("error", error => {
        const errno = error as NodeJS.ErrnoException
        const message = errno.code === "ENOENT"
          ? codexNotFoundMessage(command, this.cwd)
          : error.message
        fail(new Error(message))
      })

      this.child.once("spawn", () => {
        settled = true
        resolve()
      })
    })

    if (!this.child) throw new Error("Codex app-server failed to start")

    let stderr = ""
    this.child.once("exit", (code, signal) => {
      const detail = stderr.trim()
      const suffix = detail ? `: ${detail}` : ""
      if (!this.initialized && code !== 0 && signal !== "SIGTERM") {
        console.warn("[codex app-server] startup failed", {
          command,
          args: appServerArgs,
          cwd: this.cwd,
        })
      }
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})${suffix}`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this.child = null
      this.initialized = false
      this.startPromise = null
    })

    this.child.stderr.on("data", chunk => {
      const message = String(chunk).trim()
      stderr += String(chunk)
      if (message) console.warn("[codex app-server]", message)
    })

    readline.createInterface({ input: this.child.stdout }).on("line", line => {
      this.handleLine(line)
    })

    await this.requestWithoutStart("initialize", {
      clientInfo: {
        name: "codexly",
        title: "Codexly",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    })
    this.notify("initialized", {})
    this.initialized = true
  }

  private async resolveAppServerArgs(command: string, configArgs: string[]): Promise<string[]> {
    if (daemonUnavailable) return ["app-server", ...configArgs]

    try {
      await this.startDaemon(command, configArgs)
      return ["app-server", "proxy", ...configArgs]
    } catch (error: any) {
      if (this.isStandaloneDaemonUnavailable(error)) {
        daemonUnavailable = true
        return ["app-server", ...configArgs]
      }
      throw error
    }
  }

  private async startDaemon(command: string, configArgs: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, ["app-server", "daemon", ...configArgs, "start"], {
        cwd: this.cwd,
        env: codexSpawnEnv(),
        shell: process.platform === "win32",
      })
      let stderr = ""
      let stdout = ""

      child.stdout.on("data", chunk => {
        stdout += String(chunk)
      })
      child.stderr.on("data", chunk => {
        stderr += String(chunk)
      })
      child.once("error", error => {
        const errno = error as NodeJS.ErrnoException
        const message = errno.code === "ENOENT"
          ? codexNotFoundMessage(command, this.cwd)
          : error.message
        reject(new Error(message))
      })
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve()
          return
        }
        const detail = stderr.trim() || stdout.trim() || signal || "unknown"
        reject(new Error(`Codex app-server daemon failed to start (${detail})`))
      })
    })
  }

  private isStandaloneDaemonUnavailable(error: any): boolean {
    const message = String(error?.message ?? error)
    return message.includes("managed standalone Codex install not found")
      || message.includes("failed to connect to socket")
      || message.includes("unrecognized subcommand 'daemon'")
      || message.includes("unrecognized subcommand \"daemon\"")
  }

  public async request(method: string, params?: unknown): Promise<any> {
    await this.ensureChild()
    return this.requestWithoutStart(method, params)
  }

  private async requestWithoutStart(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    const payload = params === undefined ? { id, method } : { id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(payload)
    })
  }

  public notify(method: string, params?: unknown): void {
    if (!this.child) return
    this.write(params === undefined ? { method } : { method, params })
  }

  public stop(): void {
    this.child?.kill()
    this.child = null
    this.initialized = false
    this.startPromise = null
  }

  private async ensureChild(): Promise<void> {
    if (!this.initialized) await this.start()
  }

  private write(payload: unknown): void {
    if (!this.child) throw new Error("Codex app-server is not running")
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: any
    try {
      message = JSON.parse(line)
    } catch (error) {
      console.warn("Could not parse Codex app-server message:", error)
      return
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(Number(message.id))
      if (!pending) return
      this.pending.delete(Number(message.id))
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }

    if ("id" in message && typeof message.method === "string") {
      this.handleRequest(message)
      return
    }

    if (typeof message.method === "string") {
      const handlers = this.notificationHandlers.get(message.method)
      handlers?.forEach(handler => handler(message.params))
    }
  }

  private async handleRequest(message: any): Promise<void> {
    const handler = this.requestHandlers.get(message.method)
    try {
      const result = handler ? await handler(message.params) : null
      this.write({ id: message.id, result })
    } catch (error: any) {
      this.write({
        id: message.id,
        error: { code: -32000, message: error?.message ?? String(error) },
      })
    }
  }
}
