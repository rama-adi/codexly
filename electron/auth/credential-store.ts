export type CodexAuthMode = 'chatgpt-local' | 'api-key'
export type ApiKeyPersistence = 'none' | 'encrypted' | 'session'

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface CredentialPersistence {
  readEncryptedApiKey(): Promise<string | null>
  writeEncryptedApiKey(value: string): Promise<void>
  deleteEncryptedApiKey(): Promise<void>
}

export interface CredentialStoreStatus {
  mode: CodexAuthMode
  hasApiKey: boolean
  apiKeyPersistence: ApiKeyPersistence
  revision: number
}

export interface ProviderCredentialSnapshot {
  mode: CodexAuthMode
  revision: number
  apiKey?: string
}

export interface CredentialStoreOptions {
  safeStorage: SafeStorageAdapter
  persistence: CredentialPersistence
}

type CredentialState =
  | { kind: 'chatgpt-local' }
  | { kind: 'session-api-key'; apiKey: string }
  | { kind: 'encrypted-api-key'; encrypted: string }

export class CredentialStore {
  readonly #safeStorage: SafeStorageAdapter
  readonly #persistence: CredentialPersistence
  #state: CredentialState = { kind: 'chatgpt-local' }
  #revision = 0
  #initializePromise: Promise<CredentialStoreStatus> | null = null

  constructor(options: CredentialStoreOptions) {
    this.#safeStorage = options.safeStorage
    this.#persistence = options.persistence
  }

  initialize(): Promise<CredentialStoreStatus> {
    this.#initializePromise ??= this.#loadPersistedCredential()
    return this.#initializePromise
  }

  async #loadPersistedCredential(): Promise<CredentialStoreStatus> {
    if (!this.#safeStorage.isEncryptionAvailable()) {
      return this.getStatus()
    }

    try {
      const encrypted = await this.#persistence.readEncryptedApiKey()
      if (encrypted) {
        this.#state = { kind: 'encrypted-api-key', encrypted }
      }
    } catch {
      this.#state = { kind: 'chatgpt-local' }
    }
    return this.getStatus()
  }

  getStatus(): CredentialStoreStatus {
    if (this.#state.kind === 'chatgpt-local') {
      return {
        mode: 'chatgpt-local',
        hasApiKey: false,
        apiKeyPersistence: 'none',
        revision: this.#revision,
      }
    }
    return {
      mode: 'api-key',
      hasApiKey: true,
      apiKeyPersistence:
        this.#state.kind === 'encrypted-api-key' ? 'encrypted' : 'session',
      revision: this.#revision,
    }
  }

  async getProviderSnapshot(): Promise<ProviderCredentialSnapshot> {
    await this.initialize()
    if (this.#state.kind === 'chatgpt-local') {
      return { mode: 'chatgpt-local', revision: this.#revision }
    }
    if (this.#state.kind === 'session-api-key') {
      return {
        mode: 'api-key',
        revision: this.#revision,
        apiKey: this.#state.apiKey,
      }
    }

    try {
      return {
        mode: 'api-key',
        revision: this.#revision,
        apiKey: this.#safeStorage.decryptString(
          Buffer.from(this.#state.encrypted, 'base64'),
        ),
      }
    } catch {
      this.#state = { kind: 'chatgpt-local' }
      this.#revision += 1
      void this.#persistence.deleteEncryptedApiKey().catch(() => undefined)
      return { mode: 'chatgpt-local', revision: this.#revision }
    }
  }

  async useChatGptLocalLogin(): Promise<CredentialStoreStatus> {
    return this.clearApiKey()
  }

  async setApiKey(
    rawApiKey: string,
    options: { persist?: boolean } = {},
  ): Promise<CredentialStoreStatus> {
    await this.initialize()
    const apiKey = rawApiKey.trim()
    if (!apiKey) {
      throw new Error('An API key is required')
    }

    const shouldPersist = options.persist ?? true
    if (shouldPersist && this.#safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = this.#safeStorage.encryptString(apiKey).toString('base64')
        await this.#persistence.writeEncryptedApiKey(encrypted)
        this.#state = { kind: 'encrypted-api-key', encrypted }
      } catch {
        await this.#persistence.deleteEncryptedApiKey()
        this.#state = { kind: 'session-api-key', apiKey }
      }
    } else {
      await this.#persistence.deleteEncryptedApiKey()
      this.#state = { kind: 'session-api-key', apiKey }
    }

    this.#revision += 1
    return this.getStatus()
  }

  async clearApiKey(): Promise<CredentialStoreStatus> {
    await this.initialize()
    const changed = this.#state.kind !== 'chatgpt-local'
    await this.#persistence.deleteEncryptedApiKey()
    this.#state = { kind: 'chatgpt-local' }
    if (changed) {
      this.#revision += 1
    }
    return this.getStatus()
  }
}
