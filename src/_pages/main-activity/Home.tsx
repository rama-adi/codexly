import React from "react"
import {
  Check,
  ExternalLink,
  FolderOpen,
  Loader2,
  Pencil,
  Play,
  Plus,
  ScreenShare
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardActions,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import type { AppSettings, CodexReadyStatus, DirectoryProfile } from "@/types/electron"

const Home: React.FC = () => {
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [readyStatus, setReadyStatus] = React.useState<CodexReadyStatus | null>(null)
  const [launchingKey, setLaunchingKey] = React.useState<string | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [titleDraft, setTitleDraft] = React.useState("")

  React.useEffect(() => {
    window.electronAPI.getAppSettings().then(setSettings)
    window.electronAPI.getCodexReadyStatus().then(setReadyStatus)
    window.electronAPI.prepareCodex().then(setReadyStatus).catch(error => {
      setReadyStatus({
        state: "error",
        key: "__direct__",
        model: "gpt-5.4",
        threadId: null,
        error: error?.message ?? String(error),
      })
    })
    const cleanupSettings = window.electronAPI.onAppSettingsChanged(setSettings)
    const cleanupReady = window.electronAPI.onCodexReadyStatusChanged(setReadyStatus)
    return () => {
      cleanupSettings()
      cleanupReady()
    }
  }, [])

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const next = await window.electronAPI.updateAppSettings(patch)
    setSettings(next)
    return next
  }

  const launchDirect = async () => {
    setLaunchingKey("__direct__")
    try {
      await updateSettings({ launchMode: "direct", selectedDirectoryId: null })
      await window.electronAPI.prepareCodex()
      await window.electronAPI.showMainWindow()
    } finally {
      setLaunchingKey(null)
    }
  }

  const importDirectory = async () => {
    const selectedProfile = settings?.directoryProfiles.find(
      profile => profile.id === settings.selectedDirectoryId
    )
    await window.electronAPI.pickWorkingDirectory({
      initialPath: selectedProfile?.path
    })
  }

  const launchDirectory = async (profile: DirectoryProfile) => {
    setLaunchingKey(profile.id)
    try {
      await updateSettings({
        launchMode: "directory",
        selectedDirectoryId: profile.id,
        workingDirectory: profile.path
      })
      await window.electronAPI.prepareCodex()
      await window.electronAPI.showMainWindow()
    } finally {
      setLaunchingKey(null)
    }
  }

  const openDirectory = async (profile: DirectoryProfile) => {
    await window.electronAPI.openDirectory(profile.path)
  }

  const startEditing = (profile: DirectoryProfile) => {
    setEditingId(profile.id)
    setTitleDraft(profile.title)
  }

  const saveTitle = async (profile: DirectoryProfile) => {
    if (!settings) return
    const title = titleDraft.trim() || profile.title
    await updateSettings({
      directoryProfiles: settings.directoryProfiles.map(item =>
        item.id === profile.id
          ? { ...item, title, updatedAt: new Date().toISOString() }
          : item
      )
    })
    setEditingId(null)
  }

  const statusCopy =
    readyStatus?.state === "ready"
      ? "Codex ready"
      : readyStatus?.state === "warming"
        ? "Preparing Codex..."
        : readyStatus?.state === "error"
          ? "Codex failed to prepare"
          : "Codex not ready"
  const directBusy = readyStatus?.key === "__direct__" && readyStatus.state === "warming"
  const directLaunching = launchingKey === "__direct__"

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-5">
        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Direct</CardTitle>
              <CardDescription>
                Start without a directory. Codexly uses your prompt,
                screenshots, and Codex knowledge.
              </CardDescription>
            </div>
            <CardActions>
              <div className="flex items-center gap-3">
                <div
                  className={`text-xs ${
                    readyStatus?.state === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                  title={readyStatus?.error}
                >
                  {statusCopy}
                </div>
                <Button onClick={launchDirect} disabled={directBusy || directLaunching}>
                  {directBusy || directLaunching ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <ScreenShare data-icon="inline-start" />
                  )}
                  {directBusy || directLaunching ? "Preparing" : "Launch"}
                </Button>
              </div>
            </CardActions>
          </CardHeader>
        </Card>

        {readyStatus?.state === "error" && (
          <div className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {readyStatus.error || "Codex app-server is not ready."}
          </div>
        )}

        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Directories</CardTitle>
              <CardDescription>
                Launch with a saved working directory.
              </CardDescription>
            </div>
            <CardActions>
              <Button variant="outline" size="sm" onClick={importDirectory}>
                <Plus data-icon="inline-start" />
                Add
              </Button>
            </CardActions>
          </CardHeader>

          {settings?.directoryProfiles.length ? (
            <div className="divide-y divide-border">
              {settings.directoryProfiles.map(profile => {
                const active =
                  settings.launchMode === "directory" &&
                  settings.selectedDirectoryId === profile.id
                const editing = editingId === profile.id
                const profileBusy =
                  launchingKey === profile.id ||
                  (active && readyStatus?.state === "warming")

                return (
                  <div
                    key={profile.id}
                    className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-2.5 transition-colors ${
                      active ? "bg-muted" : "hover:bg-muted/60"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                        {editing ? (
                          <input
                            value={titleDraft}
                            autoFocus
                            onChange={event =>
                              setTitleDraft(event.target.value)
                            }
                            onBlur={() => saveTitle(profile)}
                            onKeyDown={event => {
                              if (event.key === "Enter")
                                event.currentTarget.blur()
                              if (event.key === "Escape") setEditingId(null)
                            }}
                            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          />
                        ) : (
                          <div className="truncate text-sm font-medium">
                            {profile.title}
                          </div>
                        )}
                        {active && (
                          <Check className="size-4 shrink-0 text-primary" />
                        )}
                      </div>
                      <div className="mt-0.5 truncate pl-6 font-mono text-[11px] text-muted-foreground">
                        {profile.path}
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Rename"
                        onClick={() => startEditing(profile)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Open in Finder"
                        onClick={() => openDirectory(profile)}
                      >
                        <ExternalLink />
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => launchDirectory(profile)}
                        disabled={profileBusy}
                      >
                        {profileBusy ? (
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                          <Play data-icon="inline-start" />
                        )}
                        {profileBusy ? "Preparing" : "Launch"}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <FolderOpen className="size-5" />
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium">No directories yet</div>
                <div className="max-w-72 text-xs text-muted-foreground">
                  Add one to launch Codexly with project context.
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={importDirectory}>
                <Plus data-icon="inline-start" />
                Add directory
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

export default Home
