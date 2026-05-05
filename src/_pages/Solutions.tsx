// Solutions.tsx
import React, { useState, useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "react-query"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism"
import { Check, Copy, X } from "lucide-react"

import ScreenshotQueue from "../components/Queue/ScreenshotQueue"
import ChatHistoryButton from "../components/ChatHistoryButton"
import QueueCommands from "../components/Queue/QueueCommands"
import {
  Toast,
  ToastDescription,
  ToastMessage,
  ToastTitle,
  ToastVariant
} from "../components/ui/toast"
import { ProblemStatementData } from "../types/solutions"
import Debug from "./Debug"

// (Using global ElectronAPI type from src/types/electron.d.ts)

type ScreenshotPreview = {
  path: string
  preview: string
}

export const ContentSection = ({
  title,
  content,
  isLoading
}: {
  title: string
  content: React.ReactNode
  isLoading: boolean
}) => (
  <div className="space-y-2">
    <h2 className="text-[13px] font-medium text-white tracking-wide">
      {title}
    </h2>
    {isLoading ? (
      <div className="mt-4 flex">
        <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
          Extracting problem statement...
        </p>
      </div>
    ) : (
      <div className="text-[13px] leading-[1.4] text-gray-100 max-w-[600px]">
        {content}
      </div>
    )}
  </div>
)
const SolutionSection = ({
  title,
  content,
  isLoading,
  showLineNumbers = true
}: {
  title: string
  content: React.ReactNode
  isLoading: boolean
  showLineNumbers?: boolean
}) => {
  const [copied, setCopied] = useState(false)

  const copyCode = async () => {
    if (typeof content !== "string") return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error("Copy failed:", error)
    }
  }

  return (
    <div className="space-y-2">
      <h2 className="text-[13px] font-medium text-white tracking-wide">
        {title}
      </h2>
      {isLoading ? (
        <div className="space-y-1.5">
          <div className="mt-4 flex">
            <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
              Loading solutions...
            </p>
          </div>
        </div>
      ) : (
        <div className="relative w-full">
          <button
            type="button"
            aria-label={copied ? "Copied" : "Copy code"}
            onClick={copyCode}
            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" strokeWidth={2} />
            ) : (
              <Copy className="h-3.5 w-3.5" strokeWidth={2} />
            )}
          </button>
          <SyntaxHighlighter
            showLineNumbers={showLineNumbers}
            language="python"
            style={dracula}
            customStyle={{
              maxWidth: "100%",
              margin: 0,
              padding: "1rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all"
            }}
            wrapLongLines={true}
          >
            {content as string}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  )
}

export const ComplexitySection = ({
  timeComplexity,
  spaceComplexity,
  isLoading
}: {
  timeComplexity: string | null
  spaceComplexity: string | null
  isLoading: boolean
}) => (
  <div className="space-y-2">
    <h2 className="text-[13px] font-medium text-white tracking-wide">
      Complexity (Updated)
    </h2>
    {isLoading ? (
      <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
        Calculating complexity...
      </p>
    ) : (
      <div className="space-y-1">
        <div className="flex items-start gap-2 text-[13px] leading-[1.4] text-gray-100">
          <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-2 shrink-0" />
          <div>
            <strong>Time:</strong> {timeComplexity}
          </div>
        </div>
        <div className="flex items-start gap-2 text-[13px] leading-[1.4] text-gray-100">
          <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-2 shrink-0" />
          <div>
            <strong>Space:</strong> {spaceComplexity}
          </div>
        </div>
      </div>
    )}
  </div>
)

const ScreenshotGallery = ({
  screenshots
}: {
  screenshots: ScreenshotPreview[]
}) => {
  if (screenshots.length === 0) return null

  return (
    <div className="space-y-1.5">
      <h2 className="text-[13px] font-medium text-white tracking-wide">
        Screenshots
      </h2>
      <div className="flex max-w-[600px] gap-1.5 overflow-x-auto rounded-md border border-white/10 bg-black/30 p-1.5">
        {screenshots.slice(0, 5).map((screenshot, index) => (
          <div
            key={screenshot.path}
            className="relative h-14 w-20 shrink-0 overflow-hidden rounded border border-white/10 bg-white/5"
            title={`Screenshot ${index + 1}`}
          >
            <img
              src={screenshot.preview}
              alt={`Screenshot ${index + 1}`}
              className="h-full w-full object-cover"
            />
          </div>
        ))}
      </div>
    </div>
  )
}

interface SolutionsProps {
  setView: React.Dispatch<
    React.SetStateAction<"queue" | "solutions" | "debug" | "settings">
  >
}
const Solutions: React.FC<SolutionsProps> = ({ setView }) => {
  const queryClient = useQueryClient()
  const contentRef = useRef<HTMLDivElement>(null)

  const [debugProcessing, setDebugProcessing] = useState(false)
  const [problemStatementData, setProblemStatementData] =
    useState<ProblemStatementData | null>(null)
  const [solutionData, setSolutionData] = useState<string | null>(null)
  const [answerData, setAnswerData] = useState<string | null>(null)
  const [thoughtsData, setThoughtsData] = useState<string[] | null>(null)
  const [timeComplexityData, setTimeComplexityData] = useState<string | null>(
    null
  )
  const [spaceComplexityData, setSpaceComplexityData] = useState<string | null>(
    null
  )
  const [customContent, setCustomContent] = useState<string | null>(null)
  const [mode, setMode] = useState<"simpleQA" | "coding">("simpleQA")
  const [responseType, setResponseType] = useState<"concise" | "thorough">("concise")
  const [answerHeight, setAnswerHeight] = useState<number>(600)
  const [isPreview, setIsPreview] = useState(false)

  useEffect(() => {
    if (!isPreview || !contentRef.current) return
    const push = () => {
      if (!contentRef.current) return
      window.electronAPI.updateContentDimensions({
        width: contentRef.current.scrollWidth,
        height: contentRef.current.scrollHeight
      })
    }
    push()
    const id = requestAnimationFrame(push)
    return () => cancelAnimationFrame(id)
  }, [isPreview, answerHeight, answerData, mode])

  const [toastOpen, setToastOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<ToastMessage>({
    title: "",
    description: "",
    variant: "neutral"
  })

  const [isResetting, setIsResetting] = useState(false)

  const { data: extraScreenshots = [], refetch } = useQuery<Array<{ path: string; preview: string }>, Error>(
    ["extras"],
    async () => {
      try {
        const existing = await window.electronAPI.getScreenshots()
        return existing
      } catch (error) {
        console.error("Error loading extra screenshots:", error)
        return []
      }
    },
    {
      staleTime: Infinity,
      cacheTime: Infinity
    }
  )

  const { data: initialScreenshots = [], refetch: refetchInitialScreenshots } =
    useQuery<Array<{ path: string; preview: string }>, Error>(
      ["screenshots"],
      async () => {
        try {
          return await window.electronAPI.getScreenshots()
        } catch (error) {
          console.error("Error loading screenshots:", error)
          return []
        }
      },
      {
        staleTime: Infinity,
        cacheTime: Infinity
      }
    )

  const showToast = (
    title: string,
    description: string,
    variant: ToastVariant
  ) => {
    setToastMessage({ title, description, variant })
    setToastOpen(true)
  }

  const handleDeleteExtraScreenshot = async (index: number) => {
    const screenshotToDelete = extraScreenshots[index]

    try {
      const response = await window.electronAPI.deleteScreenshot(
        screenshotToDelete.path
      )

      if (response.success) {
        refetch() // Refetch screenshots instead of managing state directly
      } else {
        console.error("Failed to delete extra screenshot:", response.error)
      }
    } catch (error) {
      console.error("Error deleting extra screenshot:", error)
    }
  }

  useEffect(() => {
    // Height update logic
    const updateDimensions = () => {
      if (contentRef.current) {
        const contentHeight = contentRef.current.scrollHeight
        const contentWidth = contentRef.current.scrollWidth
        window.electronAPI.updateContentDimensions({
          width: contentWidth,
          height: contentHeight
        })
      }
    }

    // Initialize resize observer
    const resizeObserver = new ResizeObserver(updateDimensions)
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current)
    }
    updateDimensions()

    // Set up event listeners
    const cleanupFunctions = [
      window.electronAPI.onScreenshotTaken(() => {
        refetch()
        refetchInitialScreenshots()
      }),
      window.electronAPI.onShowAnswerPreview(() => {
        setIsPreview(true)
      }),
      window.electronAPI.onResetView(() => {
        setIsPreview(false)
        // Set resetting state first
        setIsResetting(true)

        // Clear the queries
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["new_solution"])

        // Reset other states
        refetch()
        refetchInitialScreenshots()

        // After a small delay, clear the resetting state
        setTimeout(() => {
          setIsResetting(false)
        }, 0)
      }),
      window.electronAPI.onSolutionStart(() => {
        setIsPreview(false)
        setSolutionData(null)
        setAnswerData(null)
        setThoughtsData(null)
        setTimeComplexityData(null)
        setSpaceComplexityData(null)
        setCustomContent(null)
      }),
      //if there was an error processing the initial solution
      window.electronAPI.onSolutionError((error: string) => {
        showToast(
          "Processing Failed",
          "There was an error processing your extra screenshots.",
          "error"
        )
        // Reset solutions in the cache (even though this shouldn't ever happen) and complexities to previous states
        const solution = queryClient.getQueryData(["solution"]) as {
          answer?: string
          code?: string
          thoughts: string[]
          time_complexity: string
          space_complexity: string
        } | null
        if (!solution) {
          setView("queue") //make sure that this is correct. or like make sure there's a toast or something
        }
        setAnswerData(solution?.answer || null)
        setSolutionData(solution?.code || null)
        setThoughtsData(solution?.thoughts || null)
        setTimeComplexityData(solution?.time_complexity || null)
        setSpaceComplexityData(solution?.space_complexity || null)
        console.error("Processing error:", error)
      }),
      //when the initial solution is generated, we'll set the solution data to that
      window.electronAPI.onSolutionSuccess((data) => {
        if (!data?.solution) {
          console.warn("Received empty or invalid solution data")
          return
        }

        console.log({ solution: data.solution })

        const solutionData = {
          answer: data.solution.answer,
          code: data.solution.code,
          thoughts: data.solution.thoughts,
          why: data.solution.why,
          time_complexity: data.solution.time_complexity,
          space_complexity: data.solution.space_complexity
        }

        queryClient.setQueryData(["solution"], solutionData)
        setAnswerData(solutionData.answer || null)
        setSolutionData(solutionData.code || null)
        setThoughtsData(solutionData.thoughts || null)
        setTimeComplexityData(solutionData.time_complexity || null)
        setSpaceComplexityData(solutionData.space_complexity || null)
      }),

      //########################################################
      //DEBUG EVENTS
      //########################################################
      window.electronAPI.onDebugStart(() => {
        //we'll set the debug processing state to true and use that to render a little loader
        setDebugProcessing(true)
      }),
      //the first time debugging works, we'll set the view to debug and populate the cache with the data
      window.electronAPI.onDebugSuccess((data) => {
        console.log({ debug_data: data })

        const previousSolution = queryClient.getQueryData(["solution"]) as {
          code?: string
        } | null
        queryClient.setQueryData(["new_solution"], {
          ...data.solution,
          old_code: previousSolution?.code ?? "",
          new_code: data.solution.code ?? ""
        })
        setDebugProcessing(false)
      }),
      //when there was an error in the initial debugging, we'll show a toast and stop the little generating pulsing thing.
      window.electronAPI.onDebugError(() => {
        showToast(
          "Processing Failed",
          "There was an error debugging your code.",
          "error"
        )
        setDebugProcessing(false)
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast(
          "No Screenshots",
          "There are no extra screenshots to process.",
          "neutral"
        )
      })
    ]

    return () => {
      resizeObserver.disconnect()
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [])

  useEffect(() => {
    window.electronAPI.getAppSettings().then(settings => {
      setMode(settings.mode)
      setResponseType(settings.responseType)
      setAnswerHeight(settings.answerHeight)
    })
    const unsubscribeSettings = window.electronAPI.onAppSettingsChanged(settings => {
      setMode(settings.mode)
      setResponseType(settings.responseType)
      setAnswerHeight(settings.answerHeight)
    })

    setProblemStatementData(
      queryClient.getQueryData(["problem_statement"]) || null
    )
    const cachedSolution = queryClient.getQueryData(["solution"]) as {
      answer?: string
      code?: string
      thoughts?: string[]
      time_complexity?: string
      space_complexity?: string
    } | null
    setAnswerData(cachedSolution?.answer ?? null)
    setSolutionData(cachedSolution?.code ?? null)

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event?.query.queryKey[0] === "problem_statement") {
        setProblemStatementData(
          queryClient.getQueryData(["problem_statement"]) || null
        )
      }
      if (event?.query.queryKey[0] === "solution") {
        const solution = queryClient.getQueryData(["solution"]) as {
          answer?: string
          code?: string
          thoughts: string[]
          time_complexity: string
          space_complexity: string
        } | null

        setAnswerData(solution?.answer ?? null)
        setSolutionData(solution?.code ?? null)
        setThoughtsData(solution?.thoughts ?? null)
        setTimeComplexityData(solution?.time_complexity ?? null)
        setSpaceComplexityData(solution?.space_complexity ?? null)
      }
    })
    return () => {
      unsubscribeSettings()
      unsubscribe()
    }
  }, [queryClient])

  return (
    <>
      {!isResetting && mode === "coding" && queryClient.getQueryData(["new_solution"]) ? (
        <>
          <Debug
            isProcessing={debugProcessing}
            setIsProcessing={setDebugProcessing}
          />
        </>
      ) : (
        <div
          ref={contentRef}
          className="relative space-y-2 px-3 py-2"
          data-clickable-root
        >
          <Toast
            open={toastOpen}
            onOpenChange={setToastOpen}
            variant={toastMessage.variant}
            duration={3000}
          >
            <ToastTitle>{toastMessage.title}</ToastTitle>
            <ToastDescription>{toastMessage.description}</ToastDescription>
          </Toast>

          <QueueCommands
            screenshots={[]}
            onTooltipVisibilityChange={() => undefined}
            onSettingsOpen={() => window.electronAPI.openSettingsWindow()}
            chatControl={<ChatHistoryButton />}
          />

          {/* Conditionally render the screenshot queue when coding can use extra debug screenshots */}
          {mode === "coding" && solutionData && extraScreenshots.length > 0 && (
            <div className="w-fit rounded-lg border border-white/10 bg-black/60 p-1.5">
              <ScreenshotQueue
                isLoading={debugProcessing}
                screenshots={extraScreenshots}
                onDeleteScreenshot={handleDeleteExtraScreenshot}
              />
            </div>
          )}

          {/* Main Content - Modified width constraints */}
          <div className="relative w-full">
            <button
              type="button"
              aria-label="Close answer"
              onClick={() => {
                queryClient.removeQueries(["solution"])
                queryClient.removeQueries(["problem_statement"])
                queryClient.removeQueries(["new_solution"])
                setIsPreview(false)
                setAnswerData(null)
                setSolutionData(null)
                setProblemStatementData(null)
                setThoughtsData(null)
                setTimeComplexityData(null)
                setSpaceComplexityData(null)
                setView("queue")
              }}
              className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-black/40 text-white/80 transition-colors hover:bg-black/60 hover:text-white"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          <div
            className="w-full text-sm text-black bg-black/60 rounded-md overflow-y-auto"
            style={
              isPreview
                ? { height: `${answerHeight}px` }
                : { maxHeight: `${answerHeight}px` }
            }
          >
            <div className="rounded-lg overflow-hidden">
              <div className="px-3 py-2.5 space-y-3 max-w-full">
                {mode === "simpleQA" ? (
                  <>
                    <ContentSection
                      title="Response"
                      content={answerData || problemStatementData?.problem_statement}
                      isLoading={!answerData && !problemStatementData}
                    />
                    {!answerData && (
                      <ScreenshotGallery screenshots={initialScreenshots} />
                    )}
                  </>
                ) : (
                  <>
                    {problemStatementData && (
                      <ContentSection
                        title="Problem Statement"
                        content={problemStatementData.problem_statement}
                        isLoading={false}
                      />
                    )}
                    {!answerData && !solutionData && (
                      <>
                        <div className="mt-4 flex">
                          <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
                            Generating solutions...
                          </p>
                        </div>
                        <ScreenshotGallery screenshots={initialScreenshots} />
                      </>
                    )}
                    {(answerData || solutionData) && (
                      <>
                        {responseType === "thorough" && thoughtsData && thoughtsData.length > 0 && (
                          <ContentSection
                            title="Analysis"
                            content={
                              <div className="space-y-3">
                                <div className="space-y-1">
                                  {thoughtsData.map((thought, index) => (
                                    <div
                                      key={index}
                                      className="flex items-start gap-2"
                                    >
                                      <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-2 shrink-0" />
                                      <div>{thought}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            }
                            isLoading={!thoughtsData}
                          />
                        )}
                        <ContentSection
                          title={mode === "coding" ? "Answer" : "Response"}
                          content={answerData || solutionData}
                          isLoading={!answerData && !solutionData}
                        />
                        {mode === "coding" && solutionData && (
                          <SolutionSection
                            title="Code"
                            content={solutionData}
                            isLoading={!solutionData}
                          />
                        )}
                        {mode === "coding" && responseType === "thorough" && (
                          <ComplexitySection
                            timeComplexity={timeComplexityData}
                            spaceComplexity={spaceComplexityData}
                            isLoading={!timeComplexityData || !spaceComplexityData}
                          />
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          </div>
        </div>
      )}
    </>
  )
}

export default Solutions
