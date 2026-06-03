import React from "react"
import {
  Check,
  ExternalLink,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  ScreenShare,
  Server,
  Sparkles
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { processingService, settingsService, shellService } from "@/services/desktop"
import type { AppSettings, CodexReadyStatus, DirectoryProfile } from "@/types/electron"

const accentTiles = [
  { bg: "bg-[#2f965b]", fg: "text-white" },
  { bg: "bg-[#e35a22]", fg: "text-white" },
  { bg: "bg-[#4e63b5]", fg: "text-white" },
  { bg: "bg-[#eef8ee]", fg: "text-[#2f965b]" },
  { bg: "bg-[#9b2bb5]", fg: "text-white" },
  { bg: "bg-[#a72a36]", fg: "text-white" }
]

const formatUpdatedAt = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Saved workspace"
  return `Updated ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  })}`
}

const Home: React.FC = () => {
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [readyStatus, setReadyStatus] = React.useState<CodexReadyStatus | null>(null)
  const [launchingKey, setLaunchingKey] = React.useState<string | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [titleDraft, setTitleDraft] = React.useState("")

  React.useEffect(() => {
    settingsService.getAppSettings().then(setSettings)
    processingService.getCodexReadyStatus().then(setReadyStatus)
    processingService.prepareCodex().then(setReadyStatus).catch(error => {
      setReadyStatus({
        state: "error",
        key: "__direct__",
        model: "gpt-5.4",
        threadId: null,
        error: error?.message ?? String(error),
      })
    })
    const cleanupSettings = settingsService.onAppSettingsChanged(setSettings)
    const cleanupReady = processingService.onReadyStatusChanged(setReadyStatus)
    return () => {
      cleanupSettings()
      cleanupReady()
    }
  }, [])

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const next = await settingsService.updateAppSettings(patch)
    setSettings(next)
    return next
  }

  const launchDirect = async () => {
    setLaunchingKey("__direct__")
    try {
      await updateSettings({ launchMode: "direct", selectedDirectoryId: null })
      setReadyStatus(await processingService.startToolbarSession())
    } finally {
      setLaunchingKey(null)
    }
  }

  const importDirectory = async () => {
    const selectedProfile = settings?.directoryProfiles.find(
      profile => profile.id === settings.selectedDirectoryId
    )
    await shellService.pickWorkingDirectory({
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
      setReadyStatus(await processingService.startToolbarSession())
    } finally {
      setLaunchingKey(null)
    }
  }

  const openDirectory = async (profile: DirectoryProfile) => {
    await shellService.openDirectory(profile.path)
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
  const profiles = settings?.directoryProfiles ?? []
  const selectedProfile = profiles.find(
    profile => profile.id === settings?.selectedDirectoryId
  )
  const directCardBusy = directBusy || directLaunching
  const groupCards = [
    {
      title: "Direct",
      count: readyStatus?.state === "ready" ? "Ready" : "Prompt only",
      icon: Sparkles,
      onClick: launchDirect
    },
    {
      title: "Directory Context",
      count: `${profiles.length} saved`,
      icon: FolderOpen,
      onClick: importDirectory
    },
    {
      title: "Selected Directory",
      count: selectedProfile ? selectedProfile.title : "No directory",
      icon: Server,
      onClick: selectedProfile ? () => launchDirectory(selectedProfile) : launchDirect
    }
  ]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#f3f5f6] text-[#222530]">
      <div className="m-2 min-h-[calc(100vh-1rem)] rounded-xl border border-[#dfe3e6] bg-white px-5 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.08),0_16px_42px_rgba(15,23,42,0.05)]">
        <div className="flex items-center gap-3 overflow-x-auto">
          <Button
            className="h-11 shrink-0 rounded-lg bg-[#f2f3f4] px-4 text-sm text-[#252935] shadow-none hover:bg-[#e9ecef]"
            variant="secondary"
            onClick={launchDirect}
            disabled={directCardBusy}
          >
            {directCardBusy ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <ScreenShare data-icon="inline-start" />
            )}
            Connect
          </Button>
          <Button
            className="h-11 shrink-0 rounded-lg bg-[#2f9a47] px-4 text-sm text-white shadow-none hover:bg-[#28883f]"
            onClick={importDirectory}
          >
            <Plus data-icon="inline-start" />
            Add Directory
          </Button>
        </div>

        <div className="mt-5 flex items-center gap-2 text-sm font-semibold">
          <span className="text-[#2f9a47]">Codexly</span>
          <span className="text-[#8a8f99]">›</span>
          <span className="text-[#252935]">Launch</span>
        </div>

        {readyStatus?.state === "error" && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {readyStatus.error || "Codex app-server is not ready."}
          </div>
        )}

        <section className="mt-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#6a6f7c]">Launch Modes</h2>
            <span className="text-sm text-[#717783]">{groupCards.length} options</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {groupCards.map(group => {
              const Icon = group.icon
              return (
                <button
                  key={group.title}
                  type="button"
                  onClick={group.onClick}
                  className="flex min-w-0 items-center gap-3 rounded-lg border border-[#dfe3e6] bg-white p-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.05),0_8px_18px_rgba(15,23,42,0.05)] transition hover:-translate-y-0.5 hover:border-[#cfd5da] hover:shadow-[0_8px_22px_rgba(15,23,42,0.08)]"
                >
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#eaf6ed] text-[#2f9a47]">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-[#252935]">
                      {group.title}
                    </span>
                    <span className="block truncate text-xs font-medium text-[#777b86]">
                      {group.count}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#6a6f7c]">Workspaces</h2>
            <div className="flex items-center gap-2 text-sm text-[#717783]">
              <span>{profiles.length} entries</span>
              <span className="rounded-lg border border-[#dfe3e6] bg-[#f4f6f7] px-3 py-1 text-xs font-semibold text-[#6a6f7c]">
                {statusCopy}
              </span>
            </div>
          </div>

          {profiles.length ? (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3 2xl:grid-cols-4">
              {profiles.map((profile, index) => {
                const active =
                  settings?.launchMode === "directory" &&
                  settings.selectedDirectoryId === profile.id
                const editing = editingId === profile.id
                const profileBusy =
                  launchingKey === profile.id ||
                  (active && readyStatus?.state === "warming")

                return (
                  <div
                    key={profile.id}
                    className={`group grid min-h-[70px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_8px_18px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 ${
                      active ? "border-[#2f9a47]" : "border-[#dfe3e6] hover:border-[#cfd5da]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => launchDirectory(profile)}
                      disabled={profileBusy}
                      aria-label={`Launch ${profile.title}`}
                      className={`flex size-11 shrink-0 items-center justify-center rounded-lg ${
                        accentTiles[index % accentTiles.length].bg
                      } ${accentTiles[index % accentTiles.length].fg}`}
                    >
                      {profileBusy ? (
                        <Loader2 className="size-5 animate-spin" />
                      ) : (
                        <FolderOpen className="size-5" />
                      )}
                    </button>
                    <div className="min-w-0 overflow-hidden">
                      <div className="flex min-w-0 items-center gap-2">
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
                            className="h-7 min-w-0 flex-1 rounded-md border border-[#cfd5da] bg-white px-2 text-sm text-[#252935] outline-none focus-visible:border-[#2f9a47] focus-visible:ring-[3px] focus-visible:ring-[#2f9a47]/20"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => launchDirectory(profile)}
                            className="truncate text-left text-sm font-bold text-[#252935]"
                          >
                            {profile.title}
                          </button>
                        )}
                        {active && (
                          <Check className="size-4 shrink-0 text-[#2f9a47]" />
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-[#777b86]">
                        {profile.path}
                      </div>
                      <div className="mt-0.5 text-[11px] font-medium text-[#9aa0a8]">
                        {formatUpdatedAt(profile.updatedAt)}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[#cfd5da] bg-[#fafbfb] px-6 py-12 text-center">
              <div className="flex size-12 items-center justify-center rounded-lg bg-[#eaf6ed] text-[#2f9a47]">
                <FolderOpen className="size-6" />
              </div>
              <div className="space-y-1">
                <div className="text-sm font-bold text-[#252935]">No directories yet</div>
                <div className="max-w-72 text-xs text-[#777b86]">
                  Add one to launch Codexly with project context.
                </div>
              </div>
              <Button size="sm" onClick={importDirectory} className="bg-[#2f9a47] text-white hover:bg-[#28883f]">
                <Plus data-icon="inline-start" />
                Add directory
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Home
