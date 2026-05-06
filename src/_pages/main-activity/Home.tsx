import React from "react"
import { PanelTopOpen } from "lucide-react"

import { Button } from "@/components/ui/button"

const Home: React.FC = () => {
  const showToolbar = () => {
    window.electronAPI.showMainWindow()
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold leading-none">
            Launch Codexly
          </h2>
          <p className="text-sm text-muted-foreground">
            Codexly is ready to help you answer questions!
          </p>
        </div>
        <Button onClick={showToolbar}>
          <PanelTopOpen data-icon="inline-start" />
          Show toolbar
        </Button>
      </div>
    </div>
  )
}

export default Home
