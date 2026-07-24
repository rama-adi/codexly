import { useCallback, useEffect, useRef, useState } from 'react'

import { desktopClient, type RuntimeStatus, type SessionSummary, type Workspace } from '../desktop'
import { PageHeader } from './components/PageHeader'
import { Sidebar } from './components/Sidebar'
import { useSettings } from './hooks/useSettings'
import { useTheme } from './hooks/useTheme'
import { isMacPlatform } from './lib/platform'
import { NAV_ITEMS, NAV_TITLES, resolveNav, type NavId } from './navigation'
import { HistoryPage } from './pages/HistoryPage'
import { OverviewPage } from './pages/OverviewPage'
import { PersonalizationPage } from './pages/PersonalizationPage'
import { SettingsPage } from './pages/SettingsPage'
import './homepage.css'

const PAGE_DESCRIPTIONS: Record<NavId, string> = {
  overview: 'Launch the overlay and manage local workspaces.',
  history: 'Browse, continue, and remove saved conversations.',
  personalization: 'Tune how Codexly answers.',
  settings: 'Model, connection, appearance, and credentials.',
}

export function Homepage() {
  const [isMac] = useState(() => isMacPlatform())
  const [nav, setNav] = useState<NavId>(() =>
    resolveNav(typeof window === 'undefined' ? '' : window.location.hash),
  )
  const [runtime, setRuntime] = useState<RuntimeStatus>({
    state: 'offline',
    authMode: 'chatgpt-local',
    detail: 'Connecting to the desktop runtime…',
  })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { settings, saving, update } = useSettings()
  useTheme(
    settings?.appearance.theme ?? 'system',
    settings?.appearance.reducedMotion ?? false,
  )

  const available = desktopClient.available

  const notify = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }, [])

  const refresh = useCallback(async () => {
    if (!desktopClient.available) return
    const [nextRuntime, nextSessions, nextWorkspaces] = await Promise.all([
      desktopClient.runtimeStatus(),
      desktopClient.listSessions(),
      desktopClient.listWorkspaces(),
    ])
    setRuntime(nextRuntime)
    setSessions(nextSessions)
    setWorkspaces(nextWorkspaces)
  }, [])

  useEffect(() => {
    const sync = () => setNav(resolveNav(window.location.hash))
    window.addEventListener('hashchange', sync)
    void refresh()
    const unsubscribe = desktopClient.available
      ? desktopClient.onProductEvent((event) => {
          if (event.type === 'sessions.changed' || event.type === 'runtime.status') {
            void refresh()
          }
        })
      : () => undefined
    return () => {
      window.removeEventListener('hashchange', sync)
      unsubscribe()
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [refresh])

  const go = useCallback((next: NavId) => {
    window.location.hash = next
    setNav(next)
  }, [])

  const run = useCallback(
    async (operation: () => Promise<void>, success?: string) => {
      setBusy(true)
      try {
        await operation()
        if (success) notify(success)
      } catch (cause) {
        notify(cause instanceof Error ? cause.message : 'The operation failed.')
      } finally {
        setBusy(false)
      }
    },
    [notify],
  )

  const setApiKey = useCallback(
    async (apiKey: string) => {
      await run(async () => {
        setRuntime(await desktopClient.setApiKey(apiKey, true))
      }, 'API key encrypted with system storage.')
    },
    [run],
  )

  return (
    <div className="hp-root flex h-screen w-full overflow-hidden bg-background text-foreground">
      <span className="sr-only" aria-live="polite">
        {toast ?? runtime.detail}
      </span>

      <Sidebar
        items={NAV_ITEMS}
        active={nav}
        onNavigate={go}
        runtime={runtime}
        isMac={isMac}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          title={NAV_TITLES[nav]}
          description={PAGE_DESCRIPTIONS[nav]}
          controlsInset={isMac ? 0 : 140}
        />

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {nav === 'history' ? (
            <HistoryPage
              sessions={sessions}
              available={available}
              onReactivate={(id) =>
                void run(async () => {
                  await desktopClient.reactivateSession(id)
                  await desktopClient.toggleOverlay(true)
                }, 'Session reactivated in the overlay.')
              }
              onDelete={(id) =>
                run(async () => {
                  await desktopClient.deleteSession(id)
                  await refresh()
                }, 'Session deleted.')
              }
            />
          ) : (
            <div className="h-full overflow-y-auto">
              {nav === 'overview' && (
                <OverviewPage
                  runtime={runtime}
                  workspaces={workspaces}
                  busy={busy}
                  available={available}
                  shortcuts={settings?.shortcuts ?? null}
                  onLaunchOverlay={() => void desktopClient.toggleOverlay()}
                  onUseLocalLogin={() =>
                    void run(async () => {
                      setRuntime(await desktopClient.useChatGpt())
                    }, 'Using the local Codex login.')
                  }
                  onPickWorkspace={() =>
                    void run(async () => {
                      const workspace = await desktopClient.pickWorkspace()
                      if (workspace) await refresh()
                    })
                  }
                  onSelectWorkspace={(id) =>
                    void run(async () => {
                      await desktopClient.selectWorkspace(id)
                    }, 'Workspace selected.')
                  }
                  onRemoveWorkspace={(id) =>
                    void run(async () => {
                      await desktopClient.removeWorkspace(id)
                      await refresh()
                    }, 'Workspace removed.')
                  }
                />
              )}
              {nav === 'personalization' && (
                <PersonalizationPage
                  settings={settings}
                  update={update}
                  saving={saving}
                  available={available}
                />
              )}
              {nav === 'settings' && (
                <SettingsPage
                  settings={settings}
                  update={update}
                  available={available}
                  onSetApiKey={setApiKey}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div
          role="status"
          className="hp-toast fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  )
}
