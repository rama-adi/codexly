import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerProvider,
  CodexAppServerProviderSettings,
} from 'ai-sdk-provider-codex-cli'

import { CredentialStore } from '../auth/credential-store'
import {
  CodexProviderManager,
  MIN_CODEX_VERSION,
  PINNED_CODEX_VERSION,
  resolvePinnedNativeCodexPath,
} from './codex-provider-manager'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

function createCredentials() {
  return new CredentialStore({
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    },
    persistence: {
      readEncryptedApiKey: async () => null,
      writeEncryptedApiKey: async () => undefined,
      deleteEncryptedApiKey: async () => undefined,
    },
  })
}

function fakeProvider(close = vi.fn(async () => undefined)) {
  const provider = (() => ({ specificationVersion: 'v4' })) as unknown as CodexAppServerProvider
  provider.close = close
  provider.dispose = close
  provider.listModels = vi.fn()
  provider.languageModel = provider
  provider.chat = provider
  provider.embeddingModel = () => {
    throw new Error('unsupported')
  }
  provider.imageModel = () => {
    throw new Error('unsupported')
  }
  return provider
}

describe('CodexProviderManager', () => {
  it('creates a locked-down app-server provider with the exact native path', async () => {
    const settings: CodexAppServerProviderSettings[] = []
    const provider = fakeProvider()
    const manager = new CodexProviderManager({
      credentials: createCredentials(),
      onToolRequestUserInput: async () => ({ answers: {} }),
      codexPath: '/opt/codex/bin/codex',
      createProvider: (value) => {
        settings.push(value)
        return provider
      },
    })

    await manager.getProvider({
      workspacePath: '/workspace',
      workspaceRevision: 1,
      configRevision: 2,
    })

    expect(settings).toHaveLength(1)
    expect(settings[0].defaultSettings).toMatchObject({
      codexPath: '/opt/codex/bin/codex',
      cwd: '/workspace',
      env: { OPENAI_API_KEY: '' },
      minCodexVersion: MIN_CODEX_VERSION,
      autoApprove: false,
      approvalPolicy: 'never',
      sandboxPolicy: 'read-only',
      threadMode: 'persistent',
      persistExtendedHistory: true,
      includeRawChunks: true,
    })
  })

  it('reuses a provider until auth, workspace, or config revision changes', async () => {
    const credentials = createCredentials()
    const providers = [fakeProvider(), fakeProvider(), fakeProvider(), fakeProvider()]
    let index = 0
    const manager = new CodexProviderManager({
      credentials,
      onToolRequestUserInput: async () => ({ answers: {} }),
      codexPath: '/codex',
      createProvider: () => providers[index++],
    })
    const input = {
      workspacePath: '/workspace',
      workspaceRevision: 1,
      configRevision: 1,
    }

    const first = await manager.getProvider(input)
    const second = await manager.getProvider(input)
    expect(first.provider).toBe(providers[0])
    expect(second.provider).toBe(providers[0])
    const workspaceChanged = await manager.getProvider({
      ...input,
      workspaceRevision: 2,
    })
    expect(workspaceChanged.provider).toBe(providers[1])
    expect(providers[0].close).not.toHaveBeenCalled()
    await first.release()
    expect(providers[0].close).not.toHaveBeenCalled()
    await second.release()
    expect(providers[0].close).toHaveBeenCalledOnce()

    const configChanged = await manager.getProvider({
      ...input,
      workspaceRevision: 2,
      configRevision: 2,
    })
    expect(configChanged.provider).toBe(providers[2])
    await credentials.setApiKey('sk-revision', { persist: false })
    const authChanged = await manager.getProvider({
      ...input,
      workspaceRevision: 2,
      configRevision: 2,
    })
    expect(authChanged.provider).toBe(providers[3])

    await workspaceChanged.release()
    await configChanged.release()
    await authChanged.release()
  })

  it('uses explicit declining approval handlers', async () => {
    let captured: CodexAppServerProviderSettings | undefined
    const manager = new CodexProviderManager({
      credentials: createCredentials(),
      onToolRequestUserInput: async () => ({ answers: {} }),
      codexPath: '/codex',
      createProvider: (settings) => {
        captured = settings
        return fakeProvider()
      },
    })
    await manager.getProvider({
      workspacePath: '/workspace',
      workspaceRevision: 1,
      configRevision: 1,
    })

    const handlers = captured?.defaultSettings?.serverRequests
    expect(
      await handlers?.onCommandExecutionApproval?.({} as never),
    ).toEqual({ decision: 'decline' })
    expect(await handlers?.onFileChangeApproval?.({} as never)).toEqual({
      decision: 'decline',
    })
    expect(await handlers?.onMcpElicitation?.({} as never)).toEqual({
      action: 'decline',
      content: null,
    })
    expect(await handlers?.onToolRequestUserInput?.({} as never)).toEqual({
      answers: {},
    })
  })
})

describe('resolvePinnedNativeCodexPath', () => {
  it('resolves the packaged manifest entrypoint and enforces the pinned version', async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), 'codex-native-'))
    temporaryDirectories.push(resourcesPath)
    const root = path.join(resourcesPath, 'codex')
    await mkdir(path.join(root, 'bin'), { recursive: true })
    await writeFile(
      path.join(root, 'codex-package.json'),
      JSON.stringify({ version: PINNED_CODEX_VERSION, entrypoint: 'bin/codex' }),
    )
    await writeFile(path.join(root, 'bin/codex'), '')

    expect(
      resolvePinnedNativeCodexPath({ isPackaged: true, resourcesPath }),
    ).toBe(path.join(root, 'bin/codex'))
  })

  it('rejects a native payload with a different version', async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), 'codex-native-'))
    temporaryDirectories.push(resourcesPath)
    const root = path.join(resourcesPath, 'codex')
    await mkdir(root, { recursive: true })
    await writeFile(
      path.join(root, 'codex-package.json'),
      JSON.stringify({ version: '0.145.0', entrypoint: 'codex' }),
    )
    await writeFile(path.join(root, 'codex'), '')

    expect(() =>
      resolvePinnedNativeCodexPath({ isPackaged: true, resourcesPath }),
    ).toThrow(PINNED_CODEX_VERSION)
  })
})
