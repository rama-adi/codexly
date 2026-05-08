import React from "react"
import { Check, FolderOpen, PanelTopOpen, Pencil } from "lucide-react"

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

  const showToolbar = () => {
    window.electronAPI.showMainWindow()
  }

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const next = await window.electronAPI.updateAppSettings(patch)
    setSettings(next)
  }

  const launchDirect = async () => {
    await updateSettings({ launchMode: "direct", selectedDirectoryId: null })
    showToolbar()
  }

  const chooseDirectory = async () => {
    const selectedProfile = settings?.directoryProfiles.find(
      profile => profile.id === settings.selectedDirectoryId
    )
    await window.electronAPI.pickWorkingDirectory({
      initialPath: selectedProfile?.path
    })
  }

  const selectDirectory = async (profile: DirectoryProfile) => {
    await updateSettings({
      launchMode: "directory",
      selectedDirectoryId: profile.id,
      workingDirectory: profile.path
    })
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

  const selectedProfile = settings?.directoryProfiles.find(
    profile => profile.id === settings.selectedDirectoryId
  )

  return (
    <div className="flex flex-1 flex-col gap-5 p-6">
      <div className="rounded-md border border-black/10 bg-white p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-none">
              Launch Codexly
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Start with Codex alone, or launch against an imported directory.
            </p>
          </div>
          <Button onClick={showToolbar}>
            <PanelTopOpen data-icon="inline-start" />
            Show toolbar
          </Button>
        </div>

        <div className="mt-4 grid gap-3">
          <button
            type="button"
            onClick={() => updateSettings({ launchMode: "direct", selectedDirectoryId: null })}
            className={`flex items-center justify-between rounded-md border px-3 py-3 text-left transition-colors ${
              settings?.launchMode !== "directory"
                ? "border-[#1f2328] bg-[#f7f7f5]"
                : "border-black/10 hover:bg-[#f7f7f5]"
            }`}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">Direct</div>
              <div className="mt-1 text-xs text-[#5f6368]">
                No directory context. Codex answers from the prompt and its own knowledge.
              </div>
            </div>
            {settings?.launchMode !== "directory" && <Check className="size-4" />}
          </button>

          <div className="rounded-md border border-black/10">
            <div className="flex items-center justify-between gap-3 border-b border-black/10 px-3 py-2">
              <div className="text-sm font-medium">Imported Directories</div>
              <Button size="sm" variant="outline" onClick={chooseDirectory}>
                <FolderOpen data-icon="inline-start" />
                Import
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
                      className={`flex items-center gap-3 px-3 py-3 ${
                        active ? "bg-[#f7f7f5]" : ""
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectDirectory(profile)}
                        className="min-w-0 flex-1 text-left"
                      >
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
                            className="h-8 w-full rounded-md border border-black/15 bg-white px-2 text-sm outline-none"
                            onClick={event => event.stopPropagation()}
                          />
                        ) : (
                          <div className="truncate text-sm font-medium">{profile.title}</div>
                        )}
                        <div className="mt-1 truncate font-mono text-xs text-[#5f6368]">
                          {profile.path}
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-label="Rename directory"
                        onClick={() => startEditing(profile)}
                        className="flex size-8 items-center justify-center rounded-md text-[#5f6368] hover:bg-black/5 hover:text-[#1f2328]"
                      >
                        <Pencil className="size-4" />
                      </button>
                      {active && <Check className="size-4 shrink-0" />}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="px-3 py-6 text-sm text-[#5f6368]">
                No imported directories yet.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-black/10 bg-white px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-[#5f6368]">
          Current Launch Context
        </div>
        <div className="mt-1 text-sm">
          {settings?.launchMode === "directory" && selectedProfile
            ? selectedProfile.title
            : "Direct"}
        </div>
        {settings?.launchMode === "directory" && selectedProfile && (
          <div className="mt-1 truncate font-mono text-xs text-[#5f6368]">
            {selectedProfile.path}
          </div>
        )}
        <div className="mt-3">
          {settings?.launchMode === "directory" && selectedProfile ? (
            <Button onClick={showToolbar}>
              <PanelTopOpen data-icon="inline-start" />
              Launch with directory
            </Button>
          ) : (
            <Button onClick={launchDirect}>
              <PanelTopOpen data-icon="inline-start" />
              Launch direct
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export default Home
