import { ToastProvider } from "./components/ui/toast"
import Queue from "./_pages/Queue"
import { ToastViewport } from "@radix-ui/react-toast"
import { useEffect, useRef, useState } from "react"
import Solutions from "./_pages/Solutions"
import Settings from "./_pages/Settings"
import { QueryClient, QueryClientProvider } from "react-query"
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate
} from "react-router-dom"

declare global {
  interface Window {
    electronAPI: {
      platform: NodeJS.Platform
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
      analyzeImageFile: (path: string) => Promise<{ text: string; timestamp: number }>
      clearChatHistory: () => Promise<{ success: boolean }>
      quitApp: () => Promise<void>
      openSettingsWindow: () => Promise<void>
      closeSettingsWindow: () => Promise<void>
      minimizeSettingsWindow: () => Promise<void>
      setIgnoreMouseEvents: (ignore: boolean) => Promise<void>
      getStealthEnabled: () => Promise<{ stealthEnabled: boolean }>
      setStealthEnabled: (enabled: boolean) => Promise<{ stealthEnabled: boolean }>
      onStealthChanged: (callback: (config: { stealthEnabled: boolean }) => void) => () => void
      getAppSettings: () => Promise<{
        model: string
        stealthEnabled: boolean
        mode: "simpleQA" | "coding"
        responseType: "concise" | "thorough"
        codingLanguage: string
        responseLanguage: string
        answerHeight: number
}>
      updateAppSettings: (patch: Partial<{
        model: string
        stealthEnabled: boolean
        mode: "simpleQA" | "coding"
        responseType: "concise" | "thorough"
        codingLanguage: string
        responseLanguage: string
        answerHeight: number
}>) => Promise<{
        model: string
        stealthEnabled: boolean
        mode: "simpleQA" | "coding"
        responseType: "concise" | "thorough"
        codingLanguage: string
        responseLanguage: string
        answerHeight: number
}>
      onAppSettingsChanged: (callback: (settings: {
        model: string
        stealthEnabled: boolean
        mode: "simpleQA" | "coding"
        responseType: "concise" | "thorough"
        codingLanguage: string
        responseLanguage: string
        answerHeight: number
}) => void) => () => void
      
      showAnswerPreview: () => Promise<void>
      onShowAnswerPreview: (callback: () => void) => () => void

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

type AppView = "queue" | "solutions" | "debug" | "settings"

const viewToPath: Record<AppView, string> = {
  queue: "/queue",
  solutions: "/solutions",
  debug: "/debug",
  settings: "/settings"
}

const getViewFromPath = (pathname: string): AppView => {
  if (pathname.startsWith("/solutions")) return "solutions"
  if (pathname.startsWith("/debug")) return "debug"
  if (pathname.startsWith("/settings")) return "settings"
  return "queue"
}

const App: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const isSettingsWindow =
    new URLSearchParams(window.location.search).get("settings") === "1"
  const view = getViewFromPath(location.pathname)
  const containerRef = useRef<HTMLDivElement>(null)

  const setView: React.Dispatch<React.SetStateAction<AppView>> = (nextView) => {
    const resolvedView =
      typeof nextView === "function" ? nextView(view) : nextView
    navigate(viewToPath[resolvedView])
  }

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
  }, [isSettingsWindow])

  useEffect(() => {
    if (isSettingsWindow && view !== "settings") {
      navigate(viewToPath.settings, { replace: true })
    }
  }, [isSettingsWindow, navigate, view])

  // Effect for height monitoring
  useEffect(() => {
    const cleanup = window.electronAPI.onResetView(() => {
      console.log("Received 'reset-view' message from main process.")
      queryClient.invalidateQueries(["screenshots"])
      queryClient.invalidateQueries(["problem_statement"])
      queryClient.invalidateQueries(["solution"])
      queryClient.invalidateQueries(["new_solution"])
      window.localStorage.removeItem("wingman-chat-history")
      window.electronAPI.clearChatHistory()
      navigate(viewToPath.queue)
    })

    return () => {
      cleanup()
    }
  }, [navigate])

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
        navigate(viewToPath.solutions)
        console.log("starting processing")
      }),

      window.electronAPI.onUnauthorized(() => {
        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        window.localStorage.removeItem("wingman-chat-history")
        window.electronAPI.clearChatHistory()
        navigate(viewToPath.queue)
        console.log("Unauthorized")
      }),
      // Update this reset handler
      window.electronAPI.onResetView(() => {
        console.log("Received 'reset-view' message from main process")

        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        navigate(viewToPath.queue)
        console.log("View reset to 'queue' via Command+R shortcut")
      }),
      window.electronAPI.onProblemExtracted((data: any) => {
        console.log("Problem extracted successfully")
        queryClient.invalidateQueries(["problem_statement"])
        queryClient.setQueryData(["problem_statement"], data)
      }),
      window.electronAPI.onShowAnswerPreview(() => {
        const existingSolution = queryClient.getQueryData(["solution"])
        if (!existingSolution) {
          queryClient.setQueryData(["solution"], {
            answer:
              "This is a preview of how your answer will appear. Adjust the answer view height in settings to find a size that works for you. The panel scrolls when content exceeds the configured height, so longer responses stay readable without resizing the overlay window.",
            code: "function preview() {\n  const items = [1, 2, 3, 4, 5]\n  return items.reduce((sum, n) => sum + n, 0)\n}\n\npreview()",
            thoughts: [
              "Identify the input shape and constraints.",
              "Pick a straightforward approach first, then optimize.",
              "Verify edge cases before finalizing the answer."
            ],
            time_complexity: "O(n)",
            space_complexity: "O(1)"
          })
          queryClient.setQueryData(["problem_statement"], {
            problem_statement:
              "Sample problem statement shown for preview purposes."
          })
        }
        navigate(viewToPath.solutions)
      })
    ]
    return () => cleanupFunctions.forEach((cleanup) => cleanup())
  }, [navigate, view])

  return (
    <div ref={containerRef} className="min-h-0">
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Routes>
            <Route
              path="/"
              element={
                <Navigate to={isSettingsWindow ? "/settings" : "/queue"} replace />
              }
            />
            <Route path="/queue" element={<Queue setView={setView} />} />
            <Route path="/solutions" element={<Solutions setView={setView} />} />
            <Route path="/debug" element={<Solutions setView={setView} />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <Navigate to={isSettingsWindow ? "/settings" : "/queue"} replace />
              }
            />
          </Routes>
          <ToastViewport />
        </ToastProvider>
      </QueryClientProvider>
    </div>
  )
}

export default App
