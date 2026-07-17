import { ToastProvider } from "./components/ui/toast"
import Queue from "./_pages/toolbar/Queue"
import { ToastViewport } from "@radix-ui/react-toast"
import { useEffect, useRef, useState } from "react"
import Solutions from "./_pages/toolbar/Solutions"
import Home from "./_pages/main-activity/Home"
import Settings from "./_pages/main-activity/Settings"
import Personalization from "./_pages/main-activity/Personalization"
import History from "./_pages/main-activity/History"
import MainActivityLayout from "./_pages/main-activity/MainActivityLayout"
import { historyService, layoutService, processingService, screenshotService } from "./services/desktop"
import { QueryClient, QueryClientProvider } from "react-query"
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate
} from "react-router-dom"
import { devLog, devMeasure } from "./utils/devLog"

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

const runBootWarmup = async () => {
  const done = devMeasure("boot", "runBootWarmup")
  try {
    await Promise.all([
      processingService.prepareCodex(),
      historyService.getIndex(),
    ])
    done()
  } catch (error) {
    done({ error: error instanceof Error ? error.message : String(error) })
    throw error
  }
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
  const [bootLoading, setBootLoading] = useState(() => !isSettingsWindow)
  const [bootError, setBootError] = useState("")

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
      layoutService.setIgnoreMouseEvents(ignore)
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
      layoutService.setIgnoreMouseEvents(false)
    }
  }, [isSettingsWindow])

  useEffect(() => {
    if (isSettingsWindow && !mainActivityViews.has(view)) {
      navigate(viewToPath.home, { replace: true })
    }
  }, [isSettingsWindow, navigate, view])

  useEffect(() => {
    if (isSettingsWindow) return

    let cancelled = false
    const boot = async () => {
      const done = devMeasure("boot", "App boot")
      setBootError("")
      setBootLoading(true)
      try {
        await runBootWarmup()
        done({ cancelled: false })
      } catch (error) {
        if (!cancelled) setBootError(error instanceof Error ? error.message : String(error))
        done({ error: error instanceof Error ? error.message : String(error), cancelled })
      } finally {
        if (!cancelled) setBootLoading(false)
      }
    }

    boot()
    return () => {
      cancelled = true
    }
  }, [isSettingsWindow])

  // Effect for height monitoring
  useEffect(() => {
    const cleanup = processingService.onResetView(() => {
      console.log("Received 'reset-view' message from main process.")
      queryClient.invalidateQueries(["screenshots"])
      queryClient.invalidateQueries(["problem_statement"])
      queryClient.invalidateQueries(["solution"])
      queryClient.invalidateQueries(["new_solution"])
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
      layoutService.updateContentDimensions({ width, height })
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
      processingService.onSolutionStreamStart(() => {
        navigate(viewToPath.solutions)
        devLog("renderer", "solution stream start")
      }),

      processingService.onUnauthorized(() => {
        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        processingService.clearChatHistory()
        navigate(viewToPath.queue)
        devLog("renderer", "unauthorized")
      }),
      // Update this reset handler
      processingService.onResetView(() => {
        console.log("Received 'reset-view' message from main process")

        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        navigate(viewToPath.queue)
        devLog("renderer", "view reset to queue")
      }),
      processingService.onShowAnswerPreview(() => {
        navigate(viewToPath.solutions)
      }),
      screenshotService.onBufferCleared(() => {
        queryClient.removeQueries(["screenshots"])
        navigate(viewToPath.queue)
      })
    ]
    return () => cleanupFunctions.forEach((cleanup) => cleanup())
  }, [navigate, view])

  const bootScreen = bootLoading ? (
    <div
      data-clickable-root
      className="flex min-h-[260px] w-[520px] max-w-[calc(100vw-24px)] flex-col items-center justify-center gap-5 rounded-xl border border-black/15 bg-white px-8 py-12 text-black shadow-[0_18px_70px_rgba(0,0,0,0.16)]"
    >
      <div className="h-16 w-16 animate-spin rounded-full border-[3px] border-black/15 border-t-black" />
      <div className="text-sm font-medium tracking-normal text-black/70">loading...</div>
    </div>
  ) : bootError ? (
    <div
      data-clickable-root
      className="flex min-h-[260px] w-[520px] max-w-[calc(100vw-24px)] flex-col items-center justify-center gap-4 rounded-xl border border-red-200 bg-white px-8 py-12 text-center text-black shadow-[0_18px_70px_rgba(0,0,0,0.16)]"
    >
      <div className="text-sm font-semibold text-red-700">Codex failed to warm up</div>
      <div className="max-w-sm text-xs leading-relaxed text-black/60">{bootError}</div>
      <button
        type="button"
        className="rounded-md border border-black/15 px-3 py-1.5 text-xs font-medium text-black/75 hover:bg-black/5"
        onClick={() => {
          const done = devMeasure("boot", "retry warmup")
          setBootError("")
          setBootLoading(true)
          runBootWarmup()
            .then(() => done())
            .catch(error => {
              const message = error instanceof Error ? error.message : String(error)
              setBootError(message)
              done({ error: message })
            })
            .finally(() => setBootLoading(false))
        }}
      >
        Retry
      </button>
    </div>
  ) : null

  return (
    <div ref={containerRef} className="min-h-0">
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          {bootScreen ?? (
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
          )}
          <ToastViewport />
        </ToastProvider>
      </QueryClientProvider>
    </div>
  )
}

export default App
