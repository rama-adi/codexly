import { ArrowUpRight, Command, FolderOpen, PanelsTopLeft, Settings2 } from "lucide-react"
import { useEffect, useState } from "react"
import { hasCapability } from "./desktop"
import {
  homepageSections,
  resolveHomepageSection,
  type HomepageSection,
} from "./roles"

const sectionCopy: Record<HomepageSection, { eyebrow: string; title: string; body: string }> = {
  workspace: {
    eyebrow: "Workspace / ready",
    title: "Start from the work in front of you.",
    body: "Codexly keeps the next useful action within reach without taking over your desktop.",
  },
  activity: {
    eyebrow: "Activity / quiet",
    title: "Nothing needs your attention yet.",
    body: "Future sessions and captured context will appear here as a focused timeline.",
  },
  preferences: {
    eyebrow: "Preferences / local",
    title: "Shape the shell around your workflow.",
    body: "Desktop controls and saved preferences will become available when the secure bridge is connected.",
  },
}

const sectionLabels: Record<HomepageSection, string> = {
  workspace: "Workspace",
  activity: "Activity",
  preferences: "Preferences",
}

const useHashSection = () => {
  const [section, setSection] = useState<HomepageSection>(() =>
    resolveHomepageSection(typeof window === "undefined" ? "" : window.location.hash),
  )

  useEffect(() => {
    const sync = () => setSection(resolveHomepageSection(window.location.hash))
    window.addEventListener("hashchange", sync)
    return () => window.removeEventListener("hashchange", sync)
  }, [])

  const navigate = (next: HomepageSection) => {
    if (window.location.hash !== `#${next}`) window.location.hash = next
    setSection(next)
  }

  return { section, navigate }
}

export function HomepageApp() {
  const { section, navigate } = useHashSection()
  const canCapture = hasCapability("capture")
  const copy = sectionCopy[section]

  return (
    <main className="homepage-shell" aria-labelledby="page-title">
      <header className="homepage-masthead">
        <a className="brand-mark" href="#workspace" aria-label="Codexly home">
          <Command aria-hidden="true" size={18} strokeWidth={2.5} />
          <span>CODEXLY</span>
        </a>
        <p className="shell-status" aria-live="polite">
          Shell mode <span>Local</span>
        </p>
      </header>

      <div className="homepage-layout">
        <nav className="section-nav" aria-label="Homepage sections">
          {homepageSections.map((item, index) => (
            <button
              aria-current={section === item ? "page" : undefined}
              className={section === item ? "section-link is-active" : "section-link"}
              key={item}
              onClick={() => navigate(item)}
              type="button"
            >
              <span>0{index + 1}</span>{sectionLabels[item]}
            </button>
          ))}
        </nav>

        <section className="homepage-stage" aria-live="polite">
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1 id="page-title">{copy.title}</h1>
          <p className="stage-description">{copy.body}</p>

          {section === "workspace" ? (
            <div className="launch-panel">
              <div className="launch-icon"><FolderOpen aria-hidden="true" size={20} /></div>
              <div>
                <h2>Bring in context</h2>
                <p>Capture tools are intentionally disabled until desktop integration is ready.</p>
              </div>
              <button
                className="action-button"
                disabled={!canCapture}
                title={canCapture ? "Capture current context" : "Capture will be enabled by desktop integration"}
                type="button"
              >
                Capture <ArrowUpRight aria-hidden="true" size={16} />
              </button>
            </div>
          ) : (
            <div className="empty-panel">
              {section === "activity" ? <PanelsTopLeft aria-hidden="true" size={22} /> : <Settings2 aria-hidden="true" size={22} />}
              <p>Capability unavailable in this renderer-only shell.</p>
            </div>
          )}
        </section>
      </div>

      <footer className="homepage-footer">
        <span>⌘ K to focus commands</span>
        <span>Secure desktop bridge: not connected</span>
      </footer>
    </main>
  )
}
