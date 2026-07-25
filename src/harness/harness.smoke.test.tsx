// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'
import { installHarness, type HarnessHandle, type HarnessRequest } from './install'
import { HARNESS_SESSION_TITLES } from './scenarios'

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let harness: HarnessHandle | undefined

function install(request: Partial<HarnessRequest> = {}): HarnessHandle {
  harness = installHarness({
    role: 'overlay',
    scenario: 'streaming',
    delayMs: 0,
    pauseAfter: undefined,
    ...request,
  })
  return harness
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle))
  // jsdom has no matchMedia; the homepage theme effect needs one.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
})

afterEach(() => {
  harness?.dispose()
  harness = undefined
  window.location.hash = ''
  vi.unstubAllGlobals()
})

describe('overlay role in the harness', () => {
  it('streams the scripted answer to completion and records it in the inspector', async () => {
    const handle = install({ scenario: 'streaming', delayMs: 0 })
    render(<App search="?role=overlay&scenario=streaming" />)

    expect(await screen.findByText('Yes — that compiles cleanly.')).toBeVisible()

    const state = handle.inspector.getState()
    expect(state.role).toBe('overlay')
    expect(state.scenario).toBe('streaming')
    expect(state.stores.overlay?.['turn']).toMatchObject({ phase: 'idle' })
    expect(state.stores.overlay?.['answer']).toBe('Yes — that compiles cleanly.')
    expect(handle.inspector.events.map((event) => event.type)).toContain('transcript.complete')
  })

  it('shows the queued screenshots the attachments scenario seeds', async () => {
    install({ scenario: 'attachments', delayMs: 0 })
    render(<App search="?role=overlay&scenario=attachments" />)

    expect(await screen.findByAltText('Screenshot 1')).toBeVisible()
    expect(screen.getByAltText('Screenshot 3')).toBeVisible()
  })

  it('releases the composer when a mid-stream turn is stopped', async () => {
    const handle = install({ scenario: 'longAnswer', delayMs: 10_000 })
    render(<App search="?role=overlay&scenario=longAnswer" />)

    const stop = await screen.findByRole('button', { name: 'Stop generating' })
    const composer = screen.getByPlaceholderText('Type your message…')
    expect(composer).toBeDisabled()

    fireEvent.click(stop)

    await waitFor(() => expect(composer).toBeEnabled())
    expect(handle.bridge.state().turns[0]).toMatchObject({ live: false })
    expect(handle.inspector.getState().stores.overlay?.['turn']).toMatchObject({ phase: 'idle' })
  })
})

describe('homepage role in the harness', () => {
  it('lists the fixture sessions on the History page', async () => {
    window.location.hash = '#history'
    const handle = install({ role: 'homepage', scenario: 'sessions', delayMs: 0 })
    render(<App search="?role=homepage&scenario=sessions" />)

    expect(await screen.findByText('4 sessions')).toBeVisible()
    for (const title of HARNESS_SESSION_TITLES.slice(0, 4)) {
      // The selected session's title also appears in the detail header.
      expect(screen.getAllByText(title).length).toBeGreaterThan(0)
    }
    await waitFor(() =>
      expect(handle.inspector.getState().stores.conversation?.['sessionId']).not.toBeNull(),
    )
  })
})

describe('installation guards', () => {
  it('exposes the bridge and the inspector on the window, and removes them on dispose', () => {
    const handle = install()

    expect(window.codexly?.v1).toBe(handle.bridge)
    expect(globalThis.__codexly).toBe(handle.inspector)
    expect(document.body.dataset['codexlyRole']).toBe('overlay')
    expect(document.getElementById('codexly-harness-badge')).not.toBeNull()

    handle.dispose()
    harness = undefined

    expect(window.codexly).toBeUndefined()
    expect(globalThis.__codexly).toBeUndefined()
    expect(document.getElementById('codexly-harness-badge')).toBeNull()
  })
})
