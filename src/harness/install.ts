import { resolveRendererRole, type RendererRole } from '../renderer/roles'
import type { TurnOrigin } from '../shared/ipc/product'
import type { CodexlyDesktopBridge } from '../types/desktop-bridge'
import { createFakeBridge, type FakeBridge } from './fake-bridge'
import { createHarnessInspector, type HarnessInspector } from './inspector'
import {
  HARNESS_SCENARIOS,
  resolveHarnessScenario,
  type HarnessScenario,
  type HarnessScenarioName,
} from './scenarios'
import './harness.css'

/**
 * The browser harness: the REAL renderer, mounted in plain Vite against an
 * in-memory bridge. Everything in this directory is dev-only — `src/main.tsx`
 * reaches it through an `import.meta.env.DEV` guarded dynamic import, so the
 * production bundle contains none of it (see the marker grep in docs/testing.md).
 */
export const HARNESS_INSTALL_MARKER = 'codexly-harness-install'

const DEFAULT_DELAY_MS = 30
const MAX_DELAY_MS = 5_000
const BADGE_ID = 'codexly-harness-badge'

export interface HarnessRequest {
  role: RendererRole
  scenario: HarnessScenarioName
  delayMs: number
  /** Freeze every turn after this many frames — a stable screenshot target. */
  pauseAfter: number | undefined
}

export interface HarnessHandle {
  readonly request: HarnessRequest
  readonly bridge: FakeBridge
  readonly inspector: HarnessInspector
  dispose(): void
}

const parseDelay = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(Math.max(parsed, 0), MAX_DELAY_MS)
}

const parsePauseAfter = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

/**
 * Reads `?harness`/`?scenario`/`?role`/`?delay`. Returns null when the page did
 * not ask for the harness, so a plain `pnpm dev` page behaves exactly as before.
 */
export function resolveHarnessRequest(search: string): HarnessRequest | null {
  const params = new URLSearchParams(search)
  if (!params.has('harness') && !params.has('scenario')) return null
  if (params.get('harness') === 'off') return null
  const scenario = resolveHarnessScenario(params.get('scenario'))
  const definition: HarnessScenario = HARNESS_SCENARIOS[scenario]
  return {
    role: resolveRendererRole(search),
    scenario,
    delayMs: parseDelay(params.get('delay')) ?? definition.delayMs ?? DEFAULT_DELAY_MS,
    pauseAfter: parsePauseAfter(params.get('pauseAfter')),
  }
}

const originOf = (role: RendererRole): TurnOrigin => (role === 'overlay' ? 'overlay' : 'homepage')

function decorateDocument(request: HarnessRequest): () => void {
  if (typeof document === 'undefined') return () => undefined
  const body = document.body
  body.dataset['codexlyHarness'] = request.scenario
  body.dataset['codexlyRole'] = request.role
  const badge = document.createElement('div')
  badge.id = BADGE_ID
  badge.setAttribute('aria-hidden', 'true')
  badge.textContent = `harness · ${request.role} · ${request.scenario}`
  body.append(badge)
  return () => {
    delete body.dataset['codexlyHarness']
    delete body.dataset['codexlyRole']
    badge.remove()
  }
}

/** Installs the fake bridge and the inspector. Must run BEFORE React mounts. */
export function installHarness(request: HarnessRequest): HarnessHandle {
  const scenario: HarnessScenario = HARNESS_SCENARIOS[request.scenario]
  const bridge = createFakeBridge({
    scenario,
    origin: originOf(request.role),
    delayMs: request.delayMs,
    pauseAfter: request.pauseAfter,
  })

  const desktop: CodexlyDesktopBridge = Object.freeze({ v1: bridge })
  Object.defineProperty(globalThis, 'codexly', {
    value: desktop,
    configurable: true,
    writable: true,
  })

  const stores = new Map<string, { getState(): unknown }>()
  globalThis.__codexlyDevStores = stores

  const inspector = createHarnessInspector({
    role: request.role,
    scenario: request.scenario,
    bridge,
    stores,
  })
  globalThis.__codexly = inspector

  const undecorate = decorateDocument(request)

  if (scenario.autoStart) {
    bridge.whenListenersAttach(() => {
      bridge.emitScript()
    })
  }

  return {
    request,
    bridge,
    inspector,
    dispose() {
      bridge.dispose()
      undecorate()
      stores.clear()
      delete globalThis.__codexlyDevStores
      delete globalThis.__codexly
      Reflect.deleteProperty(globalThis, 'codexly')
    },
  }
}

/**
 * Installs the harness only when the page asked for it and no real desktop
 * bridge is present, so an Electron window is never affected.
 */
export function installHarnessIfRequested(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): HarnessHandle | null {
  if (typeof window !== 'undefined' && window.codexly) return null
  const request = resolveHarnessRequest(search)
  return request === null ? null : installHarness(request)
}
