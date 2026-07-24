import { type FormEvent, useCallback, useMemo, useRef } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { StoreApi } from 'zustand/vanilla'

import { formatAccelerator } from '../../shared/shortcuts/accelerator'
import { desktopClient } from '../desktop'
import { createOverlayActions } from './actions/overlay-actions'
import { ChatPanel } from './components/ChatPanel'
import { CommandBar } from './components/CommandBar'
import { ScreenshotQueue } from './components/ScreenshotQueue'
import { SolutionPanel } from './components/SolutionPanel'
import { useOverlayFocus } from './hooks/useOverlayFocus'
import { useOverlayModels } from './hooks/useOverlayModels'
import { useOverlayResize } from './hooks/useOverlayResize'
import { useOverlaySettings } from './hooks/useOverlaySettings'
import { useProductEventBridge } from './hooks/useProductEventBridge'
import { activeTurnId, isBusy, isStreaming } from './machine/turn-machine'
import { createOverlayStore } from './store/overlay-store'
import type { OverlayStoreState } from './store/contract'
import './overlay.css'

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function Overlay() {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  // One store per overlay mount. Fresh reconciliation buffers per mount keep
  // test runs isolated; production mounts the overlay exactly once.
  const storeRef = useRef<StoreApi<OverlayStoreState>>()
  if (!storeRef.current) {
    storeRef.current = createOverlayStore({
      transport: { stopTurn: (id) => desktopClient.stopTurn(id) },
    })
  }
  const store = storeRef.current

  const reportError = useCallback(
    (error: unknown, fallback: string) => store.getState().reportError(errorText(error, fallback)),
    [store],
  )

  const actions = useMemo(
    () =>
      createOverlayActions(store, {
        capture: () => desktopClient.capture(),
        captureSelection: () => desktopClient.captureSelection(),
        solvePending: (modelId) => desktopClient.solvePending(modelId),
        sendMessage: (payload) => desktopClient.sendMessage(payload),
        clearAttachments: () => desktopClient.clearAttachments(),
        discardAttachment: (id) => desktopClient.discardAttachment(id),
        createSession: () => desktopClient.createSession(),
        openHome: () => desktopClient.openHome(),
        toggleOverlay: (preserveSession) => desktopClient.toggleOverlay(preserveSession),
      }),
    [store],
  )

  const s = useStore(
    store,
    useShallow((state) => ({
      view: state.view,
      attachments: state.attachments,
      answer: state.answer,
      reasoning: state.reasoning,
      streamError: state.streamError,
      activities: state.activities,
      messages: state.messages,
      models: state.models,
      modelId: state.modelId,
      answerHeight: state.answerHeight,
      shortcuts: state.shortcuts,
      notice: state.notice,
      visibleError: state.visibleError,
      sessionId: state.sessionId,
      chatInput: state.chatInput,
      turn: state.turn,
    })),
  )

  useOverlaySettings({
    onAnswerHeight: (height) => store.getState().set({ answerHeight: height }),
    onShortcuts: (shortcuts) => store.getState().set({ shortcuts }),
    onModelId: (updater) => store.getState().set({ modelId: updater(store.getState().modelId) }),
    onError: reportError,
  })
  useOverlayModels({
    onModels: (models) => store.getState().set({ models }),
    onModelId: (updater) => store.getState().set({ modelId: updater(store.getState().modelId) }),
    onError: reportError,
  })
  useOverlayResize(root)
  useOverlayFocus({ view: s.view, inputRef: input, onError: reportError })
  useProductEventBridge(store)

  const streaming = isStreaming(s.turn)
  const busy = isBusy(s.turn)
  const stopTurnId = activeTurnId(s.turn)
  const modelLabel = s.models.find((model) => model.id === s.modelId)?.displayName ?? s.modelId

  const sendChat = (event: FormEvent) => {
    event.preventDefault()
    void actions.sendChat(store.getState().chatInput.trim())
  }

  return (
    <div ref={root} className="ov-root" data-clickable-root>
      <span className="sr-only" aria-live="polite">
        {s.notice}
      </span>

      <CommandBar
        attachments={s.attachments.length}
        chatOpen={s.view === 'chat'}
        busy={busy}
        models={s.models}
        modelId={s.modelId}
        onModelChange={(id) => store.getState().set({ modelId: id })}
        onCapture={() => void actions.capture()}
        onCaptureSelection={() => void actions.captureSelection()}
        onSolve={() => void actions.solve()}
        onClear={() => void actions.clear()}
        onReset={() => void actions.reset()}
        onChat={() =>
          store.getState().set({ view: store.getState().view === 'chat' ? 'queue' : 'chat' })
        }
        onSettings={() => void actions.openSettings()}
        onClose={() => void actions.hideOverlay()}
        captureKey={formatAccelerator(s.shortcuts.captureDisplay)}
        captureSelectionKey={formatAccelerator(s.shortcuts.captureSelection)}
        solveKey={formatAccelerator(s.shortcuts.solve)}
      />

      {s.visibleError && (
        <div className="ov-visible-notice" role="alert">
          {s.visibleError}
        </div>
      )}

      {s.view === 'queue' && (
        <ScreenshotQueue attachments={s.attachments} onDiscard={(id) => void actions.discard(id)} />
      )}

      {s.view === 'solution' && (
        <SolutionPanel
          answer={s.answer}
          reasoning={s.reasoning}
          error={s.streamError}
          streaming={streaming}
          modelLabel={modelLabel}
          activities={s.activities}
          answerHeight={s.answerHeight}
          onClose={() => actions.dismissSolution()}
        />
      )}

      {s.view === 'chat' && (
        <ChatPanel
          sessionLabel={s.sessionId ? 'Current session' : 'New session'}
          modelLabel={modelLabel}
          messages={s.messages}
          answer={s.answer}
          reasoning={s.reasoning}
          error={s.streamError}
          streaming={streaming}
          activities={s.activities}
          answerHeight={s.answerHeight}
          chatInput={s.chatInput}
          canStop={Boolean(stopTurnId)}
          inputRef={input}
          onChatInputChange={(value) => store.getState().set({ chatInput: value })}
          onSend={sendChat}
          onStop={() => actions.stopActiveChat()}
          onClose={() => store.getState().set({ view: 'queue' })}
        />
      )}
    </div>
  )
}
