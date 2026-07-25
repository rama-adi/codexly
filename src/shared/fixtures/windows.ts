import { CONTRACT_VERSION, type JsonObject } from '../schemas/common'
import {
  type WindowBounds,
  type WindowRole,
  type WindowState,
  WindowStateSchema,
  WindowStatesSchema,
} from '../schemas/windows'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'

export type WindowStateOverrides = Partial<{
  version: typeof CONTRACT_VERSION
  role: WindowRole
  displayId: string
  bounds: WindowBounds
  visible: boolean
  focused: boolean
  minimized: boolean
  maximized: boolean
  fullScreen: boolean
  alwaysOnTop: boolean
  updatedAt: string
  extensions: JsonObject
}>

const BOUNDS_BY_ROLE: Readonly<Record<WindowRole, WindowBounds>> = {
  main: { x: 0, y: 0, width: 1280, height: 800 },
  toolbar: { x: 240, y: 60, width: 720, height: 120 },
}

export function makeWindowState(
  overrides: WindowStateOverrides = {},
  context: FixtureContext = createFixtureContext(),
): WindowState {
  const role = overrides.role ?? 'main'
  const base: WindowState = {
    version: CONTRACT_VERSION,
    role,
    displayId: 'display-1',
    bounds: BOUNDS_BY_ROLE[role],
    visible: true,
    focused: role === 'main',
    minimized: false,
    maximized: false,
    fullScreen: false,
    alwaysOnTop: role === 'toolbar',
    updatedAt: context.nextTimestamp(),
  }
  return WindowStateSchema.parse(mergeDefined(base, overrides))
}

/** Both roles, in the order the main process reports them. */
export function makeWindowStates(
  overrides: readonly WindowStateOverrides[] = [{ role: 'main' }, { role: 'toolbar' }],
  context: FixtureContext = createFixtureContext(),
): WindowState[] {
  return WindowStatesSchema.parse(overrides.map((entry) => makeWindowState(entry, context)))
}
