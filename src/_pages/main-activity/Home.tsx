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
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f7f5] p-6 text-[#1f2328]">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <section className="rounded-md border border-black/10 bg-white p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold">Direct</h2>
              <p className="mt-1 text-sm text-[#5f6368]">
                Start without a directory. Codexly uses your prompt, screenshots,
                and Codex knowledge.
              </p>
            </div>
            <Button onClick={launchDirect}>
              <ScreenShare data-icon="inline-start" />
              Launch direct
            </Button>
          </div>
        </section>

        <section className="rounded-md border border-black/10 bg-white">
          <div className="flex items-center justify-between gap-4 border-b border-black/10 px-4 py-3">
            <div>
              <h2 className="text-base font-semibold">Directories</h2>
              <p className="mt-1 text-sm text-[#5f6368]">
                Launch with a saved cwd, or open the folder.
              </p>
            </div>
            <Button variant="outline" onClick={importDirectory}>
              <Plus data-icon="inline-start" />
              Add directory
            </Button>
          </div>

          {settings?.directoryProfiles.length ? (
            <div className="divide-y divide-black/10">
              {settings.directoryProfiles.map(profile => {
                const active =
                  settings.launchMode === "directory" &&
                  settings.selectedDirectoryId === profile.id
                const editing = editingId === profile.id

                return (
                  <div
                    key={profile.id}
                    className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 ${
                      active ? "bg-[#f7f7f5]" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <FolderOpen className="size-4 shrink-0 text-[#5f6368]" />
                        {editing ? (
                          <input
                            value={titleDraft}
                            autoFocus
                            onChange={event => setTitleDraft(event.target.value)}
                            onBlur={() => saveTitle(profile)}
                            onKeyDown={event => {
                              if (event.key === "Enter") event.currentTarget.blur()
                              if (event.key === "Escape") setEditingId(null)
                            }}
                            className="h-8 min-w-0 flex-1 rounded-md border border-black/15 bg-white px-2 text-sm text-[#1f2328] outline-none"
                          />
                        ) : (
                          <div className="truncate text-sm font-semibold">
                            {profile.title}
                          </div>
                        )}
                        {active && <Check className="size-4 shrink-0 text-[#1f883d]" />}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-[#5f6368]">
                        {profile.path}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => launchDirectory(profile)}>
                        <Play data-icon="inline-start" />
                        Launch
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Open directory"
                        onClick={() => openDirectory(profile)}
                      >
                        <ExternalLink />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Rename directory"
                        onClick={() => startEditing(profile)}
                      >
                        <Pencil />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex min-h-40 items-center justify-center px-6 py-10 text-sm text-[#5f6368]">
              No directories yet. Add one to launch Codexly with project context.
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Home
