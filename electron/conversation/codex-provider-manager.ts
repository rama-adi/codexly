import {
  createCodexAppServer,
  type CodexAppServerProvider,
  type CodexAppServerProviderSettings,
  type CodexAppServerRequestHandlers,
} from 'ai-sdk-provider-codex-cli'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { CredentialStore } from '../auth/credential-store'
import { createProviderEnvironment } from '../auth/provider-environment'

export const PINNED_CODEX_VERSION = '0.144.5'
export const MIN_CODEX_VERSION = '0.144.0'

const require = createRequire(import.meta.url)
const PLATFORM_PACKAGES: Record<string, string> = {
  'darwin-arm64': '@openai/codex-darwin-arm64',
  'darwin-x64': '@openai/codex-darwin-x64',
  'linux-arm64': '@openai/codex-linux-arm64',
  'linux-x64': '@openai/codex-linux-x64',
  'win32-arm64': '@openai/codex-win32-arm64',
  'win32-x64': '@openai/codex-win32-x64',
}

interface CodexNativeManifest {
  version: string
  entrypoint: string
}

export interface NativeCodexPathOptions {
  isPackaged: boolean
  resourcesPath: string
  platform?: NodeJS.Platform
  arch?: string
}

export function resolvePinnedNativeCodexPath(
  options: NativeCodexPathOptions,
): string {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const nativeRoot = options.isPackaged
    ? path.join(options.resourcesPath, 'codex')
    : resolveDevelopmentNativeRoot(platform, arch)
  const manifest = readNativeManifest(nativeRoot)

  if (manifest.version !== PINNED_CODEX_VERSION) {
    throw new Error(
      `Expected Codex ${PINNED_CODEX_VERSION}, found ${manifest.version}`,
    )
  }

  const executable = path.join(nativeRoot, manifest.entrypoint)
  if (!statSync(executable).isFile()) {
    throw new Error(`Codex native executable is missing: ${executable}`)
  }
  return executable
}

function resolveDevelopmentNativeRoot(
  platform: NodeJS.Platform,
  arch: string,
): string {
  const packageName = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (!packageName) {
    throw new Error(`Codex is not supported on ${platform}-${arch}`)
  }

  const codexPackage = require.resolve('@openai/codex/package.json')
  const platformManifest = require.resolve(`${packageName}/package.json`, {
    paths: [path.dirname(codexPackage)],
  })
  const vendorRoot = path.join(path.dirname(platformManifest), 'vendor')
  const targets = readdirSync(vendorRoot, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  )
  if (targets.length !== 1) {
    throw new Error(`Expected one Codex target directory in ${vendorRoot}`)
  }
  return path.join(vendorRoot, targets[0].name)
}

function readNativeManifest(nativeRoot: string): CodexNativeManifest {
  const value = JSON.parse(
    readFileSync(path.join(nativeRoot, 'codex-package.json'), 'utf8'),
  ) as Partial<CodexNativeManifest>
  if (typeof value.version !== 'string' || typeof value.entrypoint !== 'string') {
    throw new Error(`Invalid Codex native manifest in ${nativeRoot}`)
  }
  return { version: value.version, entrypoint: value.entrypoint }
}

export interface ProviderRevisionInput {
  workspacePath: string
  workspaceRevision: number
  configRevision: number
}

export interface CodexProviderLease {
  provider: CodexAppServerProvider
  release(): Promise<void>
}

export interface CodexProviderManagerOptions {
  credentials: CredentialStore
  codexPath: string
  createProvider?: (
    settings: CodexAppServerProviderSettings,
  ) => CodexAppServerProvider
  requestHandlers?: CodexAppServerRequestHandlers
  onToolRequestUserInput: NonNullable<
    CodexAppServerRequestHandlers['onToolRequestUserInput']
  >
  connectionTimeoutMs?: number
  requestTimeoutMs?: number
  idleTimeoutMs?: number
}

interface ManagedProvider {
  provider: CodexAppServerProvider
  key: string
  activeLeases: number
  retired: boolean
}

export class CodexProviderManager {
  readonly #credentials: CredentialStore
  readonly #codexPath: string
  readonly #createProvider: NonNullable<
    CodexProviderManagerOptions['createProvider']
  >
  readonly #requestHandlers: CodexAppServerRequestHandlers
  readonly #timeouts: Pick<
    CodexProviderManagerOptions,
    'connectionTimeoutMs' | 'requestTimeoutMs' | 'idleTimeoutMs'
  >
  readonly #retired = new Set<ManagedProvider>()
  #current: ManagedProvider | null = null
  #transition: Promise<void> = Promise.resolve()

  constructor(options: CodexProviderManagerOptions) {
    this.#credentials = options.credentials
    this.#codexPath = options.codexPath
    this.#createProvider = options.createProvider ?? createCodexAppServer
    this.#requestHandlers = {
      ...options.requestHandlers,
      onCommandExecutionApproval: async () => ({ decision: 'decline' }),
      onFileChangeApproval: async () => ({ decision: 'decline' }),
      onSkillApproval: async () => ({ decision: 'decline' }),
      onMcpElicitation: async () => ({ action: 'decline', content: null }),
      onToolRequestUserInput: options.onToolRequestUserInput,
    }
    this.#timeouts = {
      connectionTimeoutMs: options.connectionTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
    }
  }

  async getProvider(input: ProviderRevisionInput): Promise<CodexProviderLease> {
    const acquired: { value: ManagedProvider | null } = { value: null }
    await this.#serialize(async () => {
      const credentials = await this.#credentials.getProviderSnapshot()
      const key = JSON.stringify({
        auth: credentials.revision,
        workspace: input.workspaceRevision,
        config: input.configRevision,
        cwd: input.workspacePath,
      })
      if (this.#current?.key === key) {
        acquired.value = this.#current
        acquired.value.activeLeases += 1
        return
      }

      if (this.#current) {
        this.#current.retired = true
        this.#retired.add(this.#current)
        await this.#closeIfUnused(this.#current)
      }

      const provider = this.#createProvider({
        defaultSettings: {
          codexPath: this.#codexPath,
          cwd: input.workspacePath,
          env: createProviderEnvironment(credentials),
          minCodexVersion: MIN_CODEX_VERSION,
          autoApprove: false,
          approvalPolicy: 'never',
          sandboxPolicy: 'read-only',
          threadMode: 'persistent',
          persistExtendedHistory: true,
          includeRawChunks: true,
          serverRequests: this.#requestHandlers,
          logger: false,
          ...this.#timeouts,
        },
      })
      acquired.value = {
        provider,
        key,
        activeLeases: 1,
        retired: false,
      }
      this.#current = acquired.value
    })

    const managed = acquired.value
    if (!managed) {
      throw new Error('Codex provider creation did not complete')
    }
    let released = false
    return {
      provider: managed.provider,
      release: async () => {
        if (released) {
          return
        }
        released = true
        await this.#serialize(async () => {
          managed.activeLeases = Math.max(0, managed.activeLeases - 1)
          await this.#closeIfUnused(managed)
        })
      },
    }
  }

  async dispose(): Promise<void> {
    await this.#serialize(async () => {
      const providers = new Set(this.#retired)
      if (this.#current) {
        providers.add(this.#current)
      }
      this.#current = null
      this.#retired.clear()
      await Promise.allSettled([...providers].map(({ provider }) => provider.close()))
    })
  }

  async #closeIfUnused(managed: ManagedProvider): Promise<void> {
    if (!managed.retired || managed.activeLeases > 0) {
      return
    }
    this.#retired.delete(managed)
    await managed.provider.close()
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const previous = this.#transition
    let release: (() => void) | undefined
    this.#transition = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      await operation()
    } finally {
      release?.()
    }
  }
}
