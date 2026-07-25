import path from 'node:path'
import { z } from 'zod'

import { CredentialStore } from '../auth/credential-store'
import { AttachmentStore } from '../capture/attachment-store'
import {
  CodexProviderManager,
  resolvePinnedNativeCodexPath,
} from '../conversation/codex-provider-manager'
import {
  ConversationRuntime,
  type ConversationEventStore,
  type ConversationThreadStore,
} from '../conversation/conversation-runtime'
import { AtomicJsonStore } from '../persistence/atomic-json-store'
import {
  LegacyImporter,
  type ImportedLegacySettings,
} from '../persistence/legacy-import'
import { SessionStore } from '../persistence/session-store'
import { SettingsStore } from '../persistence/settings-store'
import { WorkspaceStore } from '../persistence/workspace-store'
import type { MainProcessAdapters } from './adapters'

/**
 * The store surfaces {@link ProductController} actually uses. Narrow `Pick`
 * aliases rather than the concrete classes, so a test can substitute a plain
 * object without also reproducing the on-disk machinery.
 */
export type SettingsStoreLike = Pick<SettingsStore, 'load' | 'update'>

export type SessionStoreLike = Pick<
  SessionStore,
  | 'list'
  | 'get'
  | 'getActive'
  | 'create'
  | 'delete'
  | 'reactivate'
  | 'clearActive'
  | 'update'
  | 'appendMessage'
  | 'removeMessage'
  | 'appendToolEvent'
  | 'setTerminalState'
>

export type WorkspaceStoreLike = Pick<
  WorkspaceStore,
  'list' | 'getSelected' | 'select' | 'remove' | 'registerApprovedPath' | 'importLegacyProfiles'
>

export type AttachmentStoreLike = Pick<
  AttachmentStore,
  | 'initialize'
  | 'list'
  | 'addPendingImage'
  | 'discardPending'
  | 'resolveVerifiedBytes'
  | 'associateMany'
  | 'releaseAndDiscardMany'
>

export type CredentialStoreLike = Pick<
  CredentialStore,
  'initialize' | 'getStatus' | 'getProviderSnapshot' | 'useChatGptLocalLogin' | 'setApiKey'
>

export type ConversationRuntimeLike = Pick<
  ConversationRuntime,
  'startTurn' | 'abortTurn' | 'listModels' | 'testConnection' | 'warm' | 'dispose'
>

export const CredentialRecordSchema = z
  .object({ version: z.literal(1), encryptedApiKey: z.string().nullable() })
  .strict()

export type CredentialRecord = z.infer<typeof CredentialRecordSchema>

/** What every store factory is handed: the host paths and the adapters. */
export interface ProductStoreContext {
  userDataPath: string
  isPackaged: boolean
  resourcesPath: string
  adapters: MainProcessAdapters
}

/** The one-shot legacy import, reduced to what the controller invokes. */
export interface LegacyImportRunner {
  importOnce(): Promise<unknown>
}

export interface LegacyImportContext extends ProductStoreContext {
  workspaces: WorkspaceStoreLike
  importSettings(settings: ImportedLegacySettings): Promise<void>
}

export interface ConversationRuntimeContext extends ProductStoreContext {
  credentials: CredentialStoreLike
  threads: ConversationThreadStore
  events: ConversationEventStore
}

/**
 * Construction seams for everything the controller owns. Each entry defaults to
 * the real implementation; a test overrides only what it needs to observe.
 */
export interface ProductStoreFactories {
  settings(context: ProductStoreContext): SettingsStoreLike
  sessions(context: ProductStoreContext): SessionStoreLike
  workspaces(context: ProductStoreContext): WorkspaceStoreLike
  attachments(context: ProductStoreContext): AttachmentStoreLike
  credentials(context: ProductStoreContext): CredentialStoreLike
  legacyImport(context: LegacyImportContext): LegacyImportRunner
  runtime(context: ConversationRuntimeContext): ConversationRuntimeLike
}

export const DEFAULT_PRODUCT_STORE_FACTORIES: ProductStoreFactories = {
  settings: ({ userDataPath }) => new SettingsStore({ userDataPath }),
  sessions: ({ userDataPath }) => new SessionStore({ userDataPath }),
  workspaces: ({ userDataPath, adapters }) =>
    new WorkspaceStore({
      userDataPath,
      allowedRootPaths: workspaceRoots(adapters.env.homedir()),
    }),
  attachments: ({ userDataPath }) => new AttachmentStore({ userDataPath }),
  credentials: ({ userDataPath, adapters }) => {
    const record = new AtomicJsonStore({
      basePath: userDataPath,
      filename: 'credentials.json',
      schema: CredentialRecordSchema,
    })
    return new CredentialStore({
      safeStorage: adapters.safeStorage,
      persistence: {
        readEncryptedApiKey: async () => (await record.read())?.encryptedApiKey ?? null,
        writeEncryptedApiKey: async (value) => {
          await record.write({ version: 1, encryptedApiKey: value })
        },
        deleteEncryptedApiKey: async () => {
          await record.write({ version: 1, encryptedApiKey: null })
        },
      },
    })
  },
  legacyImport: ({ userDataPath, adapters, workspaces, importSettings }) =>
    new LegacyImporter({
      userDataPath,
      legacyStatePath: legacyStatePath(adapters.env),
      workspaceStore: workspaces,
      importSettings,
    }),
  runtime: ({ isPackaged, resourcesPath, credentials, threads, events }) => {
    const codexPath = resolvePinnedNativeCodexPath({ isPackaged, resourcesPath })
    const providers = new CodexProviderManager({
      credentials,
      codexPath,
      onToolRequestUserInput: async () => {
        throw new Error('Codex requested user input; explicit UI handling is required.')
      },
    })
    return new ConversationRuntime({ providers, threads, events })
  },
}

export function resolveProductStoreFactories(
  overrides: Partial<ProductStoreFactories> = {},
): ProductStoreFactories {
  return { ...DEFAULT_PRODUCT_STORE_FACTORIES, ...overrides }
}

/** The read-only former state directory the one-time import reads. */
export function legacyStatePath(env: MainProcessAdapters['env']): string {
  const base = env.readEnv('CODEXLY_HOME')?.trim() || path.join(env.homedir(), '.codexly')
  return path.join(base, 'userdata')
}

/** The main-process-owned roots a user-picked workspace path must stay inside. */
export function workspaceRoots(home: string): string[] {
  return [...new Set([home, path.parse(home).root])]
}
