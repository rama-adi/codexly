import { ChildProcessWithoutNullStreams, spawn } from "child_process"
import readline from "readline"

type PendingRequest = {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

type NotificationHandler = (params: any) => void
type RequestHandler = (params: any) => any

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private notificationHandlers = new Map<string, Set<NotificationHandler>>()
  private requestHandlers = new Map<string, RequestHandler>()
  private initialized = false
  private startPromise: Promise<void> | null = null

  constructor(private readonly cwd: string) {
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
    const command = process.env.CODEX_BIN?.trim() || "codex"
    this.child = spawn(command, ["app-server"], {
      cwd: this.cwd,
      env: { ...process.env },
      shell: process.platform === "win32",
    })

    this.child.once("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this.child = null
      this.initialized = false
      this.startPromise = null
    })

    this.child.stderr.on("data", chunk => {
      const message = String(chunk).trim()
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
    this.notify("initialized", undefined)
    this.initialized = true
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
