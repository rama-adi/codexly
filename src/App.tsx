import { ToastProvider } from "./components/ui/toast"
import Queue from "./_pages/Queue"
import { ToastViewport } from "@radix-ui/react-toast"
import { useEffect, useRef, useState } from "react"
import Solutions from "./_pages/Solutions"
import Settings from "./_pages/Settings"
import { QueryClient, QueryClientProvider } from "react-query"

declare global {
  interface Window {
    electronAPI: {
      //RANDOM GETTER/SETTERS
      updateContentDimensions: (dimensions: {
        width: number
        height: number
      }) => Promise<void>
      getScreenshots: () => Promise<Array<{ path: string; preview: string }>>

      //GLOBAL EVENTS
      //TODO: CHECK THAT PROCESSING NO SCREENSHOTS AND TAKE SCREENSHOTS ARE BOTH CONDITIONAL
      onUnauthorized: (callback: () => void) => () => void
      onScreenshotTaken: (
        callback: (data: { path: string; preview: string }) => void
      ) => () => void
      onProcessingNoScreenshots: (callback: () => void) => () => void
      onResetView: (callback: () => void) => () => void
      takeScreenshot: () => Promise<void>

      //INITIAL SOLUTION EVENTS
      deleteScreenshot: (
        path: string
      ) => Promise<{ success: boolean; error?: string }>
      onSolutionStart: (callback: () => void) => () => void
      onSolutionError: (callback: (error: string) => void) => () => void
      onSolutionSuccess: (callback: (data: any) => void) => () => void
      onProblemExtracted: (callback: (data: any) => void) => () => void

      onDebugSuccess: (callback: (data: any) => void) => () => void

      onDebugStart: (callback: () => void) => () => void
      onDebugError: (callback: (error: string) => void) => () => void

      moveWindowLeft: () => Promise<void>
      moveWindowRight: () => Promise<void>
      moveWindowUp: () => Promise<void>
      moveWindowDown: () => Promise<void>
      quitApp: () => Promise<void>
      openSettingsWindow: () => Promise<void>
      closeSettingsWindow: () => Promise<void>
      setIgnoreMouseEvents: (ignore: boolean) => Promise<void>
      getStealthEnabled: () => Promise<{ stealthEnabled: boolean }>
      setStealthEnabled: (enabled: boolean) => Promise<{ stealthEnabled: boolean }>
      onStealthChanged: (callback: (config: { stealthEnabled: boolean }) => void) => () => void
      
      // LLM Model Management
      getCurrentLlmConfig: () => Promise<{ provider: string; model: string }>
      getAvailableLlmModels: () => Promise<Array<{ id: string; name: string }>>
      setCurrentLlmModel: (model: string) => Promise<{ provider: string; model: string }>
      testLlmConnection: () => Promise<{ success: boolean; error?: string }>
      onLlmConfigChanged: (callback: (config: { provider: string; model: string }) => void) => () => void
      
      invoke: (channel: string, ...args: any[]) => Promise<any>
    }
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      cacheTime: Infinity
    }
  }
})

const App: React.FC = () => {
  const isSettingsWindow =
    new URLSearchParams(window.location.search).get("settings") === "1"
  const [view, setView] = useState<"queue" | "solutions" | "debug" | "settings">(
    isSettingsWindow ? "settings" : "queue"
  )
  const containerRef = useRef<HTMLDivElement>(null)

  // Toggle OS-level click-through based on whether cursor is over real content.
  // Transparent regions of the window otherwise swallow clicks meant for apps below.
  useEffect(() => {
    if (isSettingsWindow) return

    let ignoring = false
    const apply = (ignore: boolean) => {
      if (ignore === ignoring) return
      ignoring = ignore
      window.electronAPI.setIgnoreMouseEvents?.(ignore)
    }
    apply(true)
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const overContent = !!el && !!(el as Element).closest("[data-clickable-root]")
      apply(!overContent)
    }
    window.addEventListener("mousemove", onMove)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.electronAPI.setIgnoreMouseEvents?.(false)
    }
  }, [])

  // Effect for height monitoring
  useEffect(() => {
    const cleanup = window.electronAPI.onResetView(() => {
      console.log("Received 'reset-view' message from main process.")
      queryClient.invalidateQueries(["screenshots"])
      queryClient.invalidateQueries(["problem_statement"])
      queryClient.invalidateQueries(["solution"])
      queryClient.invalidateQueries(["new_solution"])
      setView("queue")
    })

    return () => {
      cleanup()
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const updateHeight = () => {
      if (!containerRef.current) return
      const height = containerRef.current.scrollHeight
      const width = containerRef.current.scrollWidth
      window.electronAPI?.updateContentDimensions({ width, height })
    }

    const resizeObserver = new ResizeObserver(() => {
      updateHeight()
    })

    // Initial height update
    updateHeight()

    // Observe for changes
    resizeObserver.observe(containerRef.current)

    // Also update height when view changes
    const mutationObserver = new MutationObserver(() => {
      updateHeight()
    })

    mutationObserver.observe(containerRef.current, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    })

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [view]) // Re-run when view changes

  useEffect(() => {
    const cleanupFunctions = [
      window.electronAPI.onSolutionStart(() => {
        setView("solutions")
        console.log("starting processing")
      }),

      window.electronAPI.onUnauthorized(() => {
        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        setView("queue")
        console.log("Unauthorized")
      }),
      // Update this reset handler
      window.electronAPI.onResetView(() => {
        console.log("Received 'reset-view' message from main process")

        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        setView("queue")
        console.log("View reset to 'queue' via Command+R shortcut")
      }),
      window.electronAPI.onProblemExtracted((data: any) => {
        if (view === "queue") {
          console.log("Problem extracted successfully")
          queryClient.invalidateQueries(["problem_statement"])
          queryClient.setQueryData(["problem_statement"], data)
        }
      })
    ]
    return () => cleanupFunctions.forEach((cleanup) => cleanup())
  }, [])

  return (
    <div ref={containerRef} className="min-h-0">
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          {view === "queue" ? (
            <Queue setView={setView} />
          ) : view === "solutions" ? (
            <Solutions setView={setView} />
          ) : view === "settings" ? (
            <Settings />
          ) : (
            <></>
          )}
          <ToastViewport />
        </ToastProvider>
      </QueryClientProvider>
    </div>
  )
}

export default App
