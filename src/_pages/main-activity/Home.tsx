import React from "react"
import {
  Check,
  ExternalLink,
  FolderOpen,
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
import type { AppSettings, DirectoryProfile } from "@/types/electron"

const Home: React.FC = () => {
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [titleDraft, setTitleDraft] = React.useState("")

  React.useEffect(() => {
    window.electronAPI.getAppSettings().then(setSettings)
    return window.electronAPI.onAppSettingsChanged(setSettings)
  }, [])

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const next = await window.electronAPI.updateAppSettings(patch)
    setSettings(next)
    return next
  }

  const launchDirect = async () => {
    await updateSettings({ launchMode: "direct", selectedDirectoryId: null })
    window.electronAPI.showMainWindow()
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
    await updateSettings({
      launchMode: "directory",
      selectedDirectoryId: profile.id,
      workingDirectory: profile.path
    })
    window.electronAPI.showMainWindow()
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
              <Button onClick={launchDirect}>
                <ScreenShare data-icon="inline-start" />
                Launch
              </Button>
            </CardActions>
          </CardHeader>
        </Card>

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
                      >
                        <Play data-icon="inline-start" />
                        Launch
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
