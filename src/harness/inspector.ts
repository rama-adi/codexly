import type { RendererRole } from '../renderer/roles'
import type { ProductEvent } from '../shared/ipc/product'
import type { FakeBridge, FakeBridgeState } from './fake-bridge'
import { HARNESS_SCENARIO_NAMES, type HarnessScenarioName } from './scenarios'
import { TURN_RECIPE_NAMES } from './turn-recipes'

export const HARNESS_INSPECTOR_MARKER = 'codexly-harness-inspector'

/** The store state the inspector reports, with the action functions removed. */
export type StoreSnapshot = Record<string, unknown>

export interface HarnessStateSnapshot {
  role: RendererRole
  scenario: HarnessScenarioName
  /** One entry per mounted store: `overlay` and/or `conversation`. */
  stores: Record<string, StoreSnapshot>
  bridge: FakeBridgeState
  eventCount: number
}

export interface HarnessInspector {
  readonly marker: string
  readonly role: RendererRole
  readonly scenario: HarnessScenarioName
  readonly scenarios: readonly HarnessScenarioName[]
  readonly recipes: readonly string[]
  /** The fake bridge, for imperative driving (`emitScript`, `emit`, `setDelay`, …). */
  readonly bridge: FakeBridge
  /** Bounded log of every product event the fake published, oldest first. */
  readonly events: readonly ProductEvent[]
  getState(): HarnessStateSnapshot
  /** The inspector one-liners, also listed in docs/testing.md. */
  help(): readonly string[]
}

const HELP: readonly string[] = [
  "window.__codexly.getState()                         // role, scenario, store + machine state",
  "window.__codexly.getState().stores.overlay.turn      // the turn machine state",
  "window.__codexly.events.map((event) => event.type)   // the product event stream so far",
  "window.__codexly.bridge.emitScript('toolUse')        // start a scripted turn now",
  "window.__codexly.bridge.setDelay(0)                  // stream the rest instantly",
  "window.__codexly.bridge.capture()                    // queue one more screenshot",
  "window.__codexly.bridge.state().sessions             // the fake's persisted sessions",
]

/** Copies a zustand store's state, dropping the action functions. */
export function snapshotStore(state: unknown): StoreSnapshot {
  if (state === null || typeof state !== 'object') return {}
  const snapshot: StoreSnapshot = {}
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    if (typeof value === 'function') continue
    snapshot[key] = value
  }
  return snapshot
}

export interface HarnessInspectorOptions {
  role: RendererRole
  scenario: HarnessScenarioName
  bridge: FakeBridge
  /** The dev store registry the renderer stores publish themselves into. */
  stores: Map<string, { getState(): unknown }>
}

export function createHarnessInspector(options: HarnessInspectorOptions): HarnessInspector {
  const { role, scenario, bridge, stores } = options
  return {
    marker: HARNESS_INSPECTOR_MARKER,
    role,
    scenario,
    scenarios: HARNESS_SCENARIO_NAMES,
    recipes: TURN_RECIPE_NAMES,
    bridge,
    get events() {
      return bridge.events
    },
    getState() {
      const snapshots: Record<string, StoreSnapshot> = {}
      for (const [name, store] of stores) snapshots[name] = snapshotStore(store.getState())
      return {
        role,
        scenario,
        stores: snapshots,
        bridge: bridge.state(),
        eventCount: bridge.events.length,
      }
    },
    help() {
      return HELP
    },
  }
}
