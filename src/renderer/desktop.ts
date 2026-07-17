export type RendererCapability = "capture" | "window-controls"

export interface RendererDesktop {
  readonly capabilities: ReadonlySet<RendererCapability>
  capture(): Promise<void>
  minimize(): Promise<void>
}

/**
 * Renderer-only seam for the future typed preload bridge. It deliberately
 * exposes no ambient Electron globals, so the web shell remains runnable.
 */
export const desktop: RendererDesktop = {
  capabilities: new Set(),
  capture: async () => undefined,
  minimize: async () => undefined,
}

export const hasCapability = (capability: RendererCapability): boolean =>
  desktop.capabilities.has(capability)
