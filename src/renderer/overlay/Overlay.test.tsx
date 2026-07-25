// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listener: undefined as ((event: Record<string, unknown>) => void) | undefined,
  solvePending: vi.fn(),
  clearAttachments: vi.fn(async () => undefined),
  createSession: vi.fn(async () => ({ id: 'session-reset' })),
  sendMessage: vi.fn(),
  stopTurn: vi.fn(async () => true),
  transcriptSnapshot: vi.fn(),
  discardAttachment: vi.fn(async () => undefined),
  listAttachments: vi.fn(async () => [
    { id: 'shot-1', name: 'Screenshot.png', preview: 'data:image/png;base64,eA==' },
  ]),
}))

vi.mock('../desktop', () => ({
  desktopClient: {
    available: true,
    getSettings: vi.fn(async () => ({
      appearance: { answerHeight: 340 },
      assistant: { model: 'gpt-5.5' },
    })),
    listModels: vi.fn(async () => []),
    listAttachments: mocks.listAttachments,
    onProductEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
      mocks.listener = listener
      return () => {
        if (mocks.listener === listener) mocks.listener = undefined
      }
    }),
    solvePending: mocks.solvePending,
    clearAttachments: mocks.clearAttachments,
    createSession: mocks.createSession,
    resizeOverlay: vi.fn(async () => undefined),
    setOverlayFocusable: vi.fn(async () => undefined),
    capture: vi.fn(),
    captureSelection: vi.fn(),
    discardAttachment: mocks.discardAttachment,
    sendMessage: mocks.sendMessage,
    stopTurn: mocks.stopTurn,
    transcriptSnapshot: mocks.transcriptSnapshot,
    openHome: vi.fn(),
    toggleOverlay: vi.fn(),
  },
}))

import { Overlay } from './Overlay'

class TestResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function emit(event: Record<string, unknown>) {
  act(() => mocks.listener?.(event))
}

async function startSolve() {
  render(<Overlay />)
  await screen.findByAltText('Screenshot 1')
  fireEvent.click(screen.getByRole('button', { name: /solve/i }))
  expect(screen.getByRole('status')).toHaveTextContent('thinking')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.clearAttachments.mockResolvedValue(undefined)
  mocks.createSession.mockResolvedValue({ id: 'session-reset' })
  mocks.stopTurn.mockResolvedValue(true)
  mocks.transcriptSnapshot.mockResolvedValue(null)
  mocks.discardAttachment.mockResolvedValue(undefined)
  mocks.listAttachments.mockResolvedValue([
    { id: 'shot-1', name: 'Screenshot.png', preview: 'data:image/png;base64,eA==' },
  ])
  mocks.listener = undefined
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('screenshot solve stream races', () => {
  it('accepts the owned answer before the command response and rejects event storms', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    await startSolve()

    // The first owned event latches the IDs even though IPC has not returned.
    emit({
      type: 'tool.status',
      origin: 'overlay',
      sessionId: 'session-1',
      turnId: 'turn-1',
      activityId: 'activity-1',
      name: 'Inspect screenshot',
      state: 'running',
    })
    const storm = [
      { sessionId: 'wrong-session', turnId: 'turn-1' },
      { sessionId: 'session-1', turnId: 'wrong-turn' },
      { sessionId: 'wrong-session', turnId: 'wrong-turn' },
    ]
    for (const scope of storm) {
      emit({ type: 'transcript.delta', origin: 'overlay', ...scope, text: 'poison' })
      emit({ type: 'transcript.complete', origin: 'overlay', ...scope })
    }
    expect(screen.getByRole('status')).toHaveTextContent('thinking')

    emit({
      type: 'transcript.delta',
      origin: 'overlay',
      sessionId: 'session-1',
      turnId: 'turn-1',
      text: 'The screenshot answer.',
    })
    emit({
      type: 'transcript.complete',
      origin: 'overlay',
      sessionId: 'session-1',
      turnId: 'turn-1',
    })
    expect(await screen.findByText('The screenshot answer.')).toBeVisible()

    // Terminal ownership is released; late deltas cannot mutate the answer.
    emit({
      type: 'transcript.delta',
      origin: 'overlay',
      sessionId: 'session-1',
      turnId: 'turn-1',
      text: ' late poison',
    })
    expect(screen.queryByText(/late poison/)).not.toBeInTheDocument()

    await act(async () => command.resolve({ sessionId: 'session-1', turnId: 'turn-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close answer' }))
    expect(screen.queryByRole('button', { name: /solve/i })).not.toBeInTheDocument()
  })

  it('shows a useful empty-result failure and ignores late text and terminal reordering', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    await startSolve()

    emit({
      type: 'transcript.complete',
      origin: 'overlay',
      sessionId: 'session-empty',
      turnId: 'turn-empty',
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Codex completed without returning an answer',
    )
    emit({
      type: 'transcript.delta',
      origin: 'overlay',
      sessionId: 'session-empty',
      turnId: 'turn-empty',
      text: 'too late',
    })
    emit({
      type: 'transcript.failed',
      origin: 'overlay',
      sessionId: 'session-empty',
      turnId: 'turn-empty',
      message: 'reordered failure',
    })
    expect(screen.queryByText(/too late|reordered failure/)).not.toBeInTheDocument()
    await act(async () => command.resolve({ sessionId: 'session-empty', turnId: 'turn-empty' }))
  })

  it('quarantines a pending solve when its panel is closed', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    await startSolve()

    fireEvent.click(screen.getByRole('button', { name: 'Close answer' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /solve/i })).toBeDisabled()

    emit({
      type: 'conversation.started',
      origin: 'overlay',
      sessionId: 'session-late',
      turnId: 'turn-late',
      consumedAttachmentIds: ['shot-1'],
    })
    expect(screen.queryByAltText('Screenshot 1')).not.toBeInTheDocument()

    emit({
      type: 'transcript.delta',
      origin: 'overlay',
      sessionId: 'session-late',
      turnId: 'turn-late',
      text: 'stale answer',
    })
    await act(async () => command.resolve({ sessionId: 'session-late', turnId: 'turn-late' }))
    await waitFor(() => expect(mocks.stopTurn).toHaveBeenCalledWith('turn-late'))
    expect(screen.queryByText('stale answer')).not.toBeInTheDocument()
  })

  it('keeps screenshots captured concurrently with solve completion', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    await startSolve()

    emit({
      type: 'attachment.captured',
      attachment: { id: 'shot-2', name: 'Later.png', preview: 'data:image/png;base64,eQ==' },
    })
    await act(async () => command.resolve({ sessionId: 'session-1', turnId: 'turn-1' }))
    emit({
      type: 'transcript.complete',
      origin: 'overlay',
      sessionId: 'session-1',
      turnId: 'turn-1',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close answer' }))

    expect(screen.getByAltText('Screenshot 1')).toHaveAttribute(
      'src',
      'data:image/png;base64,eQ==',
    )
  })

  it('latches the first event turn so close can stop before the command resolves', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    await startSolve()

    emit({
      type: 'transcript.reasoning',
      origin: 'overlay',
      sessionId: 'session-1',
      turnId: 'turn-early',
      text: 'working',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close answer' }))
    expect(mocks.stopTurn).toHaveBeenCalledWith('turn-early')

    emit({
      type: 'transcript.delta',
      origin: 'overlay',
      sessionId: 'session-1',
      turnId: 'turn-early',
      text: 'must remain hidden',
    })
    expect(screen.queryByText('must remain hidden')).not.toBeInTheDocument()
    await act(async () => command.resolve({ sessionId: 'session-1', turnId: 'turn-early' }))
  })

  it.each(['false', 'reject'] as const)(
    'restores the live solution when stop returns %s and accepts later output',
    async (failureMode) => {
      const command = deferred<{ sessionId: string; turnId: string }>()
      mocks.solvePending.mockReturnValue(command.promise)
      if (failureMode === 'false') mocks.stopTurn.mockResolvedValueOnce(false)
      else mocks.stopTurn.mockRejectedValueOnce(new Error('Stop transport failed'))
      await startSolve()
      const scope = { sessionId: 'session-stop', turnId: 'turn-stop' }
      emit({ type: 'transcript.reasoning', origin: 'overlay', ...scope, text: 'working' })
      emit({ type: 'transcript.delta', origin: 'overlay', ...scope, text: 'Before close. ' })
      await act(async () => command.resolve(scope))

      fireEvent.click(screen.getByRole('button', { name: 'Close answer' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        failureMode === 'false' ? 'still running' : 'Stop transport failed',
      )
      emit({ type: 'transcript.delta', origin: 'overlay', ...scope, text: 'Recovered output' })
      expect(await screen.findByText('Before close. Recovered output')).toBeVisible()
      emit({ type: 'transcript.complete', origin: 'overlay', ...scope })
    },
  )
})

describe('overlay failure recovery and external commands', () => {
  it('renders a failed chat turn with its partial answer and an inline error', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.sendMessage.mockReturnValue(command.promise)
    render(<Overlay />)
    await screen.findByAltText('Screenshot 1')
    fireEvent.click(screen.getByTitle('Toggle chat'))
    const input = screen.getByPlaceholderText('Type your message…')
    fireEvent.change(input, { target: { value: 'Explain this' } })
    fireEvent.submit(input.closest('form')!)

    emit({
      type: 'transcript.delta',
      origin: 'overlay',
      sessionId: 'session-chat',
      turnId: 'turn-chat',
      text: 'A useful partial answer',
    })
    emit({
      type: 'transcript.failed',
      origin: 'overlay',
      sessionId: 'session-chat',
      turnId: 'turn-chat',
      message: 'Network interrupted',
    })

    expect(await screen.findByText('A useful partial answer')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Network interrupted')
    await act(async () => command.resolve({ sessionId: 'session-chat', turnId: 'turn-chat' }))
  })

  it('rolls back a rejected optimistic message, restores input, and explains the failure', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('Server unavailable'))
    render(<Overlay />)
    await screen.findByAltText('Screenshot 1')
    fireEvent.click(screen.getByTitle('Toggle chat'))
    const input = screen.getByPlaceholderText('Type your message…')
    fireEvent.change(input, { target: { value: 'Do not lose me' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(input).toHaveValue('Do not lose me'))
    expect(screen.queryByText('Do not lose me')).not.toBeInTheDocument()
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Server unavailable')))
      .toBe(true)
  })

  it('does not hide a screenshot when discard fails', async () => {
    mocks.discardAttachment.mockRejectedValue(new Error('Disk is busy'))
    render(<Overlay />)
    await screen.findByAltText('Screenshot 1')
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot 1' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk is busy')
    expect(screen.getByAltText('Screenshot 1')).toBeVisible()
  })

  it('arms a shortcut-started solve, consumes only declared screenshots, and streams it', async () => {
    render(<Overlay />)
    await screen.findByAltText('Screenshot 1')
    emit({
      type: 'attachment.captured',
      attachment: { id: 'shot-2', name: 'Later.png', preview: 'data:image/png;base64,eQ==' },
    })
    emit({
      type: 'conversation.started',
      origin: 'overlay',
      sessionId: 'session-global',
      turnId: 'turn-global',
      consumedAttachmentIds: ['shot-1'],
    })
    emit({
      type: 'transcript.delta',
      origin: 'overlay',
      sessionId: 'session-global',
      turnId: 'turn-global',
      text: 'Global answer',
    })
    emit({
      type: 'transcript.complete',
      origin: 'overlay',
      sessionId: 'session-global',
      turnId: 'turn-global',
    })

    expect(await screen.findByText('Global answer')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close answer' }))
    expect(screen.getByAltText('Screenshot 1')).toHaveAttribute(
      'src',
      'data:image/png;base64,eQ==',
    )
  })

  it('preserves tool output that races ahead of its status event', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    await startSolve()
    const scope = { sessionId: 'session-tools', turnId: 'turn-tools' }
    emit({
      type: 'tool.output',
      origin: 'overlay',
      ...scope,
      activityId: 'tool-1',
      text: 'result ',
      preliminary: true,
    })
    emit({
      type: 'tool.output',
      origin: 'overlay',
      ...scope,
      activityId: 'tool-1',
      text: 'from ',
      preliminary: false,
    })
    emit({
      type: 'tool.status',
      origin: 'overlay',
      ...scope,
      activityId: 'tool-1',
      name: 'Fast tool',
      state: 'complete',
    })
    emit({
      type: 'tool.output',
      origin: 'overlay',
      ...scope,
      activityId: 'tool-1',
      text: 'the fast tool',
      preliminary: false,
    })

    const tool = screen.getByRole('button', { name: /Fast tool/i })
    fireEvent.click(tool)
    expect(screen.getByText('result from the fast tool')).toBeVisible()
    await act(async () => command.resolve(scope))
  })

  it('caps accumulated tool output under a hostile chunk flood', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    await startSolve()
    const scope = { sessionId: 'session-cap', turnId: 'turn-cap' }
    emit({
      type: 'tool.status',
      origin: 'overlay',
      ...scope,
      activityId: 'tool-cap',
      name: 'Noisy tool',
      state: 'complete',
    })
    for (let index = 0; index < 5; index += 1) {
      emit({
        type: 'tool.output',
        origin: 'overlay',
        ...scope,
        activityId: 'tool-cap',
        text: String(index).repeat(20_000),
        preliminary: false,
      })
    }
    fireEvent.click(screen.getByRole('button', { name: /Noisy tool/i }))
    const output = document.querySelector('pre')
    expect(output?.textContent).toHaveLength(64 * 1024)
    expect(output?.textContent?.startsWith('0'.repeat(100))).toBe(true)
    await act(async () => command.resolve(scope))
  })

  it('reports clipboard rejection without claiming the answer was copied', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Clipboard denied')) },
    })
    await startSolve()
    const scope = { sessionId: 'session-copy', turnId: 'turn-copy' }
    emit({ type: 'transcript.delta', origin: 'overlay', ...scope, text: 'Copy me' })
    emit({ type: 'transcript.complete', origin: 'overlay', ...scope })
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Clipboard denied')
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
    await act(async () => command.resolve(scope))
  })

  it('does not resurrect a consumed screenshot when initial queue loading resolves late', async () => {
    const load = deferred<Array<{ id: string; name: string; preview: string }>>()
    mocks.listAttachments.mockReturnValue(load.promise)
    render(<Overlay />)
    emit({
      type: 'conversation.started',
      origin: 'overlay',
      sessionId: 'session-race',
      turnId: 'turn-race',
      consumedAttachmentIds: ['shot-1'],
    })
    await act(async () =>
      load.resolve([
        { id: 'shot-1', name: 'Screenshot.png', preview: 'data:image/png;base64,eA==' },
      ]),
    )

    expect(screen.queryByAltText('Screenshot 1')).not.toBeInTheDocument()
  })
})

describe('overlay transcript gap recovery', () => {
  it('replaces a transcript with a dropped middle by the authoritative snapshot', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    mocks.transcriptSnapshot.mockResolvedValue({
      turnId: 'turn-gap',
      sessionId: 'session-gap',
      origin: 'overlay',
      sequence: 4,
      answer: 'The whole answer, middle included.',
      reasoning: 'full reasoning',
      toolOutputs: [{ activityId: 'tool-1', text: 'authoritative output' }],
      live: true,
    })
    await startSolve()
    const scope = { sessionId: 'session-gap', turnId: 'turn-gap' }

    emit({
      type: 'tool.status',
      origin: 'overlay',
      ...scope,
      sequence: 1,
      activityId: 'tool-1',
      name: 'Inspect screenshot',
      state: 'running',
    })
    emit({ type: 'transcript.delta', origin: 'overlay', ...scope, sequence: 2, text: 'The ' })
    // Sequence 3 was dropped by the transport; 4 must not be appended onto it.
    emit({ type: 'transcript.delta', origin: 'overlay', ...scope, sequence: 4, text: 'included.' })

    expect(await screen.findByText('The whole answer, middle included.')).toBeVisible()
    expect(mocks.transcriptSnapshot).toHaveBeenCalledWith('turn-gap')

    // The recovered text survives the terminal event and the tool output pane
    // shows the authoritative copy rather than the partial one.
    emit({ type: 'transcript.complete', origin: 'overlay', ...scope, sequence: 5 })
    expect(screen.getByText('The whole answer, middle included.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Inspect screenshot/i }))
    expect(screen.getByText('authoritative output')).toBeVisible()
  })

  it('recovers on a transport gap marker before settling the turn', async () => {
    const command = deferred<{ sessionId: string; turnId: string }>()
    mocks.solvePending.mockReturnValue(command.promise)
    mocks.transcriptSnapshot.mockResolvedValue({
      turnId: 'turn-marker',
      sessionId: 'session-marker',
      origin: 'overlay',
      sequence: 6,
      answer: 'Restored from the snapshot.',
      reasoning: '',
      toolOutputs: [],
      live: false,
    })
    await startSolve()
    const scope = { sessionId: 'session-marker', turnId: 'turn-marker' }

    emit({ type: 'transcript.delta', origin: 'overlay', ...scope, sequence: 1, text: 'partial' })
    emit({
      type: 'transcript.gap',
      origin: 'overlay',
      ...scope,
      evictedThrough: 5,
      droppedCount: 3,
    })
    emit({ type: 'transcript.complete', origin: 'overlay', ...scope, sequence: 6 })

    expect(await screen.findByText('Restored from the snapshot.')).toBeVisible()
  })
})
