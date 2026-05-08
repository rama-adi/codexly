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
    <div className="flex flex-1 flex-col bg-[#0b0b0d] text-[#f4f4f5]">
      <div className="flex items-center justify-between border-b border-white/10 bg-[#17181b] px-8 py-7">
        <div className="min-w-0">
          <div className="text-3xl font-semibold tracking-normal text-white">
            Codexly
          </div>
          <div className="mt-4 text-base text-[#a2a4ad]">
            Launch direct, or start from an imported project directory.
          </div>
        </div>
        <Button
          onClick={launchDirect}
          className="h-12 rounded-full bg-[#5aa1ff] px-7 text-base font-semibold text-white shadow-[0_16px_40px_rgba(70,140,255,0.35)] hover:bg-[#6caaff]"
        >
          <ScreenShare data-icon="inline-start" />
          Start direct
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-8 px-8 py-9">
        <section className="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-[#08090b] px-8 py-12 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-white/10 text-white">
            <ScreenShare className="size-8" />
          </div>
          <h2 className="mt-8 text-2xl font-semibold text-white">
            Start with Codex
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#a2a4ad]">
            Use Codexly without a working directory. The toolbar will answer from
            your prompt, screenshots, and Codex knowledge.
          </p>
          <Button
            onClick={launchDirect}
            variant="outline"
            className="mt-8 border-white/15 bg-white/5 px-5 text-white hover:bg-white/10 hover:text-white"
          >
            <Play data-icon="inline-start" />
            Start direct
          </Button>
        </section>

        <section className="rounded-xl border border-white/10 bg-[#101114]">
          <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Directories</h2>
              <p className="mt-1 text-sm text-[#8f929c]">
                Reuse saved project contexts, launch the toolbar, or open the folder.
              </p>
            </div>
            <Button
              onClick={importDirectory}
              variant="outline"
              className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
            >
              <Plus data-icon="inline-start" />
              Add directory
            </Button>
          </div>

          {settings?.directoryProfiles.length ? (
            <div className="divide-y divide-white/10">
              {settings.directoryProfiles.map(profile => {
                const active =
                  settings.launchMode === "directory" &&
                  settings.selectedDirectoryId === profile.id
                const editing = editingId === profile.id

                return (
                  <div
                    key={profile.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-4"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <FolderOpen className="size-4 shrink-0 text-[#8f929c]" />
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
                            className="h-8 min-w-0 flex-1 rounded-md border border-white/15 bg-black/30 px-2 text-sm text-white outline-none"
                          />
                        ) : (
                          <div className="truncate text-sm font-semibold text-white">
                            {profile.title}
                          </div>
                        )}
                        {active && <Check className="size-4 shrink-0 text-[#5aa1ff]" />}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-[#8f929c]">
                        {profile.path}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => launchDirectory(profile)}
                        className="bg-white text-[#101114] hover:bg-white/90"
                      >
                        <Play data-icon="inline-start" />
                        Launch
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Open directory"
                        onClick={() => openDirectory(profile)}
                        className="text-[#c9cbd3] hover:bg-white/10 hover:text-white"
                      >
                        <ExternalLink />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Rename directory"
                        onClick={() => startEditing(profile)}
                        className="text-[#c9cbd3] hover:bg-white/10 hover:text-white"
                      >
                        <Pencil />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex min-h-40 items-center justify-center px-6 py-10 text-sm text-[#8f929c]">
              No directories yet. Add one to launch Codexly with project context.
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Home
