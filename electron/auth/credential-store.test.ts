import { describe, expect, it } from 'vitest'

import {
  CredentialStore,
  type CredentialPersistence,
  type SafeStorageAdapter,
} from './credential-store'

function createPersistence(initial: string | null = null) {
  let value = initial
  const persistence: CredentialPersistence = {
    readEncryptedApiKey: async () => value,
    writeEncryptedApiKey: async (next) => {
      value = next
    },
    deleteEncryptedApiKey: async () => {
      value = null
    },
  }
  return { persistence, read: () => value }
}

function createSafeStorage(available = true): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
  }
}

describe('CredentialStore', () => {
  it('defaults to ChatGPT local login without touching external auth files', async () => {
    const storage = createPersistence()
    const store = new CredentialStore({
      safeStorage: createSafeStorage(),
      persistence: storage.persistence,
    })

    expect(await store.initialize()).toEqual({
      mode: 'chatgpt-local',
      hasApiKey: false,
      apiKeyPersistence: 'none',
      revision: 0,
    })
    expect(storage.read()).toBeNull()
  })

  it('encrypts a persisted API key and only decrypts it for a provider snapshot', async () => {
    const storage = createPersistence()
    const store = new CredentialStore({
      safeStorage: createSafeStorage(),
      persistence: storage.persistence,
    })

    expect(await store.setApiKey(' sk-secret ')).toMatchObject({
      mode: 'api-key',
      apiKeyPersistence: 'encrypted',
      revision: 1,
    })
    expect(Buffer.from(storage.read()!, 'base64').toString()).toBe(
      'encrypted:sk-secret',
    )
    expect(await store.getProviderSnapshot()).toMatchObject({ apiKey: 'sk-secret' })
  })

  it('falls back to session-only storage when safeStorage is unavailable', async () => {
    const storage = createPersistence()
    const store = new CredentialStore({
      safeStorage: createSafeStorage(false),
      persistence: storage.persistence,
    })

    expect(await store.setApiKey('sk-session')).toMatchObject({
      apiKeyPersistence: 'session',
    })
    expect(storage.read()).toBeNull()
    expect(await store.getProviderSnapshot()).toMatchObject({ apiKey: 'sk-session' })
  })

  it('falls back to session-only storage when encrypted persistence fails', async () => {
    const persistence: CredentialPersistence = {
      readEncryptedApiKey: async () => null,
      writeEncryptedApiKey: async () => {
        throw new Error('disk unavailable')
      },
      deleteEncryptedApiKey: async () => undefined,
    }
    const store = new CredentialStore({
      safeStorage: createSafeStorage(),
      persistence,
    })

    expect(await store.setApiKey('sk-session')).toMatchObject({
      apiKeyPersistence: 'session',
      hasApiKey: true,
    })
  })

  it('loads an app-owned encrypted key and never exposes it in status', async () => {
    const encrypted = Buffer.from('encrypted:sk-loaded').toString('base64')
    const storage = createPersistence(encrypted)
    const store = new CredentialStore({
      safeStorage: createSafeStorage(),
      persistence: storage.persistence,
    })

    expect(await store.initialize()).toEqual({
      mode: 'api-key',
      hasApiKey: true,
      apiKeyPersistence: 'encrypted',
      revision: 0,
    })
    expect(await store.getProviderSnapshot()).toMatchObject({ apiKey: 'sk-loaded' })
  })

  it('switches to local login by deleting only the app-owned API key', async () => {
    const storage = createPersistence()
    const store = new CredentialStore({
      safeStorage: createSafeStorage(),
      persistence: storage.persistence,
    })
    await store.setApiKey('sk-secret')

    expect(await store.useChatGptLocalLogin()).toMatchObject({
      mode: 'chatgpt-local',
      hasApiKey: false,
      revision: 2,
    })
    expect(storage.read()).toBeNull()
  })

  it('shares one in-flight initialization across concurrent callers', async () => {
    const encrypted = Buffer.from('encrypted:sk-loaded').toString('base64')
    let release: ((value: string | null) => void) | undefined
    let reads = 0
    const persistence: CredentialPersistence = {
      readEncryptedApiKey: () => {
        reads += 1
        return new Promise((resolve) => {
          release = resolve
        })
      },
      writeEncryptedApiKey: async () => undefined,
      deleteEncryptedApiKey: async () => undefined,
    }
    const store = new CredentialStore({
      safeStorage: createSafeStorage(),
      persistence,
    })

    const initialization = store.initialize()
    const snapshot = store.getProviderSnapshot()
    release?.(encrypted)

    expect(await initialization).toMatchObject({ mode: 'api-key' })
    expect(await snapshot).toMatchObject({ apiKey: 'sk-loaded' })
    expect(reads).toBe(1)
  })

  it('removes an older persisted key before selecting a session-only key', async () => {
    const storage = createPersistence()
    const store = new CredentialStore({
      safeStorage: createSafeStorage(),
      persistence: storage.persistence,
    })
    await store.setApiKey('sk-old')
    await store.setApiKey('sk-new', { persist: false })

    expect(storage.read()).toBeNull()
    expect(await store.getProviderSnapshot()).toMatchObject({ apiKey: 'sk-new' })
    expect(store.getStatus()).toMatchObject({ apiKeyPersistence: 'session' })
  })

  it('does not report a clear when persistent deletion fails', async () => {
    const encrypted = Buffer.from('encrypted:sk-loaded').toString('base64')
    const persistence: CredentialPersistence = {
      readEncryptedApiKey: async () => encrypted,
      writeEncryptedApiKey: async () => undefined,
      deleteEncryptedApiKey: async () => {
        throw new Error('delete failed')
      },
    }
    const store = new CredentialStore({
      safeStorage: createSafeStorage(),
      persistence,
    })
    await store.initialize()

    await expect(store.clearApiKey()).rejects.toThrow('delete failed')
    expect(store.getStatus()).toMatchObject({ mode: 'api-key', hasApiKey: true })
  })
})
