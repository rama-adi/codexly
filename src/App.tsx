import { ToastProvider } from "./components/ui/toast"
import Queue from "./_pages/toolbar/Queue"
import { ToastViewport } from "@radix-ui/react-toast"
import { useEffect, useRef } from "react"
import Solutions from "./_pages/toolbar/Solutions"
import Home from "./_pages/main-activity/Home"
import Settings from "./_pages/main-activity/Settings"
import Personalization from "./_pages/main-activity/Personalization"
import History from "./_pages/main-activity/History"
import MainActivityLayout from "./_pages/main-activity/MainActivityLayout"
import { QueryClient, QueryClientProvider } from "react-query"
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate
} from "react-router-dom"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      cacheTime: Infinity
    }
  }
})

type AppView =
  | "queue"
  | "solutions"
  | "home"
  | "personalization"
  | "history"
  | "settings"
type ToolbarView = "queue" | "solutions" | "home" | "settings"

const viewToPath: Record<AppView, string> = {
  queue: "/queue",
  solutions: "/solutions",
  home: "/home",
  personalization: "/personalization",
  history: "/history",
  settings: "/settings"
}

const mainActivityViews = new Set<AppView>([
  "home",
  "personalization",
  "history",
  "settings"
])

const getViewFromPath = (pathname: string): AppView => {
  if (pathname.startsWith("/solutions")) return "solutions"
  if (pathname.startsWith("/home")) return "home"
  if (pathname.startsWith("/personalization")) return "personalization"
  if (pathname.startsWith("/history")) return "history"
  if (pathname.startsWith("/settings")) return "settings"
  return "queue"
}

const App: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const windowParams = new URLSearchParams(window.location.search)
  const isSettingsWindow =
    windowParams.get("window") === "settings" ||
    windowParams.get("settings") === "1"
  const view = getViewFromPath(location.pathname)
  const containerRef = useRef<HTMLDivElement>(null)

  const setView: React.Dispatch<React.SetStateAction<AppView>> = (nextView) => {
    const resolvedView =
      typeof nextView === "function" ? nextView(view) : nextView
    navigate(viewToPath[resolvedView])
  }
  const setToolbarView: React.Dispatch<React.SetStateAction<ToolbarView>> = (
    nextView
  ) => {
    const toolbarView = view === "personalization" || view === "history" ? "home" : view
    const resolvedView =
      typeof nextView === "function" ? nextView(toolbarView) : nextView
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
    if (isSettingsWindow && !mainActivityViews.has(view)) {
      navigate(viewToPath.home, { replace: true })
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
      window.electronAPI.clearChatHistory()
      navigate(viewToPath.queue)
    })

    return () => {
      cleanup()
    }
  }, [navigate])

  useEffect(() => {
    if (isSettingsWindow) return
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
  }, [view, isSettingsWindow]) // Re-run when view changes

  useEffect(() => {
    const cleanupFunctions = [
      window.electronAPI.onSolutionStreamStart(() => {
        navigate(viewToPath.solutions)
        console.log("starting processing")
      }),

      window.electronAPI.onUnauthorized(() => {
        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
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
      window.electronAPI.onShowAnswerPreview(() => {
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
                <Navigate to={isSettingsWindow ? "/home" : "/queue"} replace />
              }
            />
            <Route path="/queue" element={<Queue setView={setToolbarView} />} />
            <Route path="/solutions" element={<Solutions setView={setToolbarView} />} />
            <Route element={<MainActivityLayout />}>
              <Route path="/home" element={<Home />} />
              <Route path="/personalization" element={<Personalization />} />
              <Route path="/history" element={<History />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
            <Route
              path="*"
              element={
                <Navigate to={isSettingsWindow ? "/home" : "/queue"} replace />
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
