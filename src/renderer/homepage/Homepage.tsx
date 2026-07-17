import {
  CheckCircle2,
  CircleAlert,
  FolderOpen,
  History,
  KeyRound,
  Moon,
  Plus,
  Settings,
  SlidersHorizontal,
  Sun,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  desktopClient,
  type RuntimeStatus,
  type SessionDetail,
  type SessionSummary,
  type Workspace,
} from '../desktop'

type Page = 'overview' | 'workspaces' | 'history' | 'personalization' | 'settings'
const pages: Page[] = ['overview', 'workspaces', 'history', 'personalization', 'settings']
const navigation = [
  ['overview', 'Overview', SlidersHorizontal],
  ['workspaces', 'Workspaces', FolderOpen],
  ['history', 'History', History],
  ['personalization', 'Personalize', Sun],
  ['settings', 'Settings', Settings],
] as const

export function Homepage() {
  const [page, setPage] = useState<Page>(() =>
    resolvePage(typeof window === 'undefined' ? '' : window.location.hash),
  )
  const [runtime, setRuntime] = useState<RuntimeStatus>({
    state: 'offline',
    authMode: 'chatgpt-local',
    detail: 'Connecting to the desktop runtime…',
  })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [apiKey, setApiKey] = useState('')
  const [dark, setDark] = useState(false)
  const [announcement, setAnnouncement] = useState('Loading Codexly.')
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)

  const refresh = async () => {
    if (!desktopClient.available) return
    const [nextRuntime, nextSessions, nextWorkspaces] = await Promise.all([
      desktopClient.runtimeStatus(),
      desktopClient.listSessions(),
      desktopClient.listWorkspaces(),
    ])
    setRuntime(nextRuntime)
    setSessions(nextSessions)
    setWorkspaces(nextWorkspaces)
    setAnnouncement(nextRuntime.detail)
  }

  useEffect(() => {
    const sync = () => setPage(resolvePage(location.hash))
    addEventListener('hashchange', sync)
    void refresh()
    const unsubscribe = desktopClient.available
      ? desktopClient.onProductEvent((event) => {
          if (event.type === 'sessions.changed' || event.type === 'runtime.status') {
            void refresh()
          }
        })
      : () => undefined
    return () => {
      removeEventListener('hashchange', sync)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => selectedSession?.workspaceId === workspace.id),
    [selectedSession, workspaces],
  )

  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    try {
      await operation()
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : 'The operation failed.')
    } finally {
      setBusy(false)
    }
  }

  const go = (next: Page) => {
    location.hash = next
    setPage(next)
  }

  return (
    <main className="product-shell" aria-labelledby="product-title">
      <span className="sr-only" aria-live="polite">{announcement}</span>
      <aside className="product-nav" aria-label="Codexly navigation">
        <div className="brand"><span>⌘</span> Codexly</div>
        <nav>
          {navigation.map(([id, label, Icon]) => (
            <button
              key={id}
              className={page === id ? 'active' : ''}
              onClick={() => go(id)}
              aria-current={page === id ? 'page' : undefined}
            >
              <Icon aria-hidden="true" />{label}
            </button>
          ))}
        </nav>
        <Button variant="ghost" size="sm" onClick={() => setDark(!dark)}>
          {dark ? <Sun /> : <Moon />}{dark ? 'Light' : 'Dark'}
        </Button>
      </aside>

      <section className="product-content">
        <header className="product-header">
          <div>
            <p className="eyebrow">LOCAL DESKTOP ASSISTANT</p>
            <h1 id="product-title">{page === 'overview' ? 'Good to see you.' : title(page)}</h1>
          </div>
          <div className={`runtime runtime-${runtime.state}`} role="status">
            {runtime.state === 'ready' ? <CheckCircle2 /> : <CircleAlert />}
            {runtime.state === 'ready' ? 'Runtime ready' : 'Runtime unavailable'}
          </div>
        </header>

        {page === 'overview' && (
          <div className="overview-grid">
            <article className="hero-card">
              <p className="eyebrow">YOUR WORKSPACE</p>
              <h2>Ask about the work in front of you.</h2>
              <p>Summon the overlay, capture context, stream a response, and return here to manage local history.</p>
              <Button disabled={!desktopClient.available} onClick={() => void desktopClient.toggleOverlay()}>
                Open composer
              </Button>
              <small>⌘⇧Space toggles the composer · ⌘⇧4 captures the display</small>
            </article>
            <article className="status-card">
              <p className="eyebrow">AUTHENTICATION</p>
              <h2>{runtime.authMode === 'api-key' ? 'OpenAI API key' : 'Local Codex login'}</h2>
              <p>{runtime.detail}</p>
              <Button variant="outline" size="sm" onClick={() => void run(async () => {
                setRuntime(await desktopClient.useChatGpt())
                setAnnouncement('Using the local Codex login.')
              })}>Use local login</Button>
            </article>
          </div>
        )}

        {page === 'workspaces' && (
          <section className="panel">
            <div className="panel-head">
              <div><h2>Local workspaces</h2><p>Only folders approved through the native picker are available to Codex.</p></div>
              <Button disabled={busy} onClick={() => void run(async () => {
                const workspace = await desktopClient.pickWorkspace()
                if (workspace) await refresh()
              })}><Plus />Add folder</Button>
            </div>
            {workspaces.length ? (
              <ul className="rows">
                {workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <FolderOpen />
                    <span><b>{workspace.title}</b><small>{workspace.canonicalPath}</small></span>
                    <Button size="sm" variant="outline" onClick={() => void run(async () => {
                      await desktopClient.selectWorkspace(workspace.id)
                      setAnnouncement(`${workspace.title} selected.`)
                    })}>Select</Button>
                    <Button size="icon-xs" variant="ghost" aria-label={`Remove ${workspace.title}`} onClick={() => void run(async () => {
                      await desktopClient.removeWorkspace(workspace.id)
                      await refresh()
                    })}><Trash2 /></Button>
                  </li>
                ))}
              </ul>
            ) : <div className="empty"><FolderOpen /><p>No workspace selected yet.</p></div>}
          </section>
        )}

        {page === 'history' && (
          <section className="history-layout">
            <div className="panel">
              <div className="panel-head"><div><h2>Sessions</h2><p>App-owned history; Codex rollout files remain untouched.</p></div></div>
              <ul className="session-list">
                {sessions.map((session) => (
                  <li key={session.id}>
                    <button onClick={() => void run(async () => setSelectedSession(await desktopClient.getSession(session.id)))}>
                      <b>{session.title}</b><span>{new Date(session.updatedAt).toLocaleString()}</span>
                      <small>{session.messageCount} messages · {session.terminalState}</small>
                    </button>
                    <Button size="icon-xs" variant="ghost" aria-label={`Delete ${session.title}`} onClick={() => setDeleteTarget(session)}><Trash2 /></Button>
                  </li>
                ))}
              </ul>
            </div>
            <article className="detail-card">
              {selectedSession ? <>
                <p className="eyebrow">SESSION DETAIL</p><h2>{selectedSession.title}</h2>
                <p>{selectedSession.messages[selectedSession.messages.length - 1]?.content ?? 'No messages yet.'}</p>
                <small>{selectedWorkspace?.title ?? 'Workspace unavailable'}</small>
                <Button onClick={() => void run(async () => {
                  await desktopClient.reactivateSession(selectedSession.id)
                  await desktopClient.toggleOverlay()
                })}>Reactivate session</Button>
              </> : <p>Select a session to inspect or reactivate it.</p>}
            </article>
          </section>
        )}

        {page === 'personalization' && (
          <section className="panel settings">
            <h2>How Codexly should help</h2>
            <label><span>Response style</span><select defaultValue="direct"><option value="direct">Direct and decisive</option><option value="detailed">Detailed walkthrough</option></select></label>
            <label><span>Custom instructions</span><textarea placeholder="For example: prefer TypeScript and explain tradeoffs." /></label>
          </section>
        )}

        {page === 'settings' && (
          <section className="panel settings">
            <h2>Authentication and application</h2>
            <label><span>OpenAI API key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" /></label>
            <Button disabled={!apiKey.trim() || busy} onClick={() => void run(async () => {
              setRuntime(await desktopClient.setApiKey(apiKey, true))
              setApiKey('')
              setAnnouncement('API key encrypted with system storage.')
            })}><KeyRound />Save API key securely</Button>
            <label><span>Reduced interface motion</span><input type="checkbox" onChange={(event) => document.documentElement.classList.toggle('reduce-motion', event.target.checked)} /></label>
          </section>
        )}
      </section>

      {deleteTarget && (
        <div className="confirm-backdrop" role="presentation">
          <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 id="confirm-title">Delete this session?</h2><p>This removes its app-owned local history.</p>
            <div><Button variant="outline" autoFocus onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" onClick={() => void run(async () => {
              await desktopClient.deleteSession(deleteTarget.id)
              setDeleteTarget(null); setSelectedSession(null); await refresh()
            })}>Delete session</Button></div>
          </section>
        </div>
      )}
    </main>
  )
}

function resolvePage(hash: string): Page {
  const candidate = hash.replace(/^#/, '') as Page
  return pages.includes(candidate) ? candidate : 'overview'
}

function title(page: Page): string {
  return page[0].toUpperCase() + page.slice(1)
}
