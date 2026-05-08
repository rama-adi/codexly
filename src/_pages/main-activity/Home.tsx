import React from "react"
import { FolderOpen, PanelTopOpen } from "lucide-react"

import { Button } from "@/components/ui/button"

const Home: React.FC = () => {
  const [workingDirectory, setWorkingDirectory] = React.useState("")

  React.useEffect(() => {
    window.electronAPI.getAppSettings().then(settings => {
      setWorkingDirectory(settings.workingDirectory)
    })
    return window.electronAPI.onAppSettingsChanged(settings => {
      setWorkingDirectory(settings.workingDirectory)
    })
  }, [])

  const showToolbar = () => {
    window.electronAPI.showMainWindow()
  }

  const chooseDirectory = async () => {
    const selected = await window.electronAPI.pickWorkingDirectory({
      initialPath: workingDirectory
    })
    if (selected) setWorkingDirectory(selected)
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4 rounded-md border border-black/10 bg-white p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold leading-none">
            Launch Codexly
          </h2>
          <p className="text-sm text-muted-foreground">
            The toolbar will use the selected working directory as session context.
          </p>
          <p className="mt-2 max-w-[520px] truncate font-mono text-xs text-[#5f6368]">
            {workingDirectory || "No working directory selected"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={chooseDirectory}>
            <FolderOpen data-icon="inline-start" />
            Directory
          </Button>
          <Button onClick={showToolbar}>
            <PanelTopOpen data-icon="inline-start" />
            Show toolbar
          </Button>
        </div>
      </div>
    </div>
  )
}

export default Home
