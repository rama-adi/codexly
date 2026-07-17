import { Circle, GripVertical, Minus, Sparkles } from "lucide-react"
import { hasCapability } from "./desktop"

export function OverlayApp() {
  const canControlWindow = hasCapability("window-controls")

  return (
    <main className="overlay-shell" aria-label="Codexly overlay">
      <section className="overlay-card" aria-labelledby="overlay-title">
        <header className="overlay-header draggable-area">
          <GripVertical aria-hidden="true" size={16} />
          <div>
            <p>CODEXLY</p>
            <h1 id="overlay-title">Listening for context</h1>
          </div>
          <button
            aria-label="Minimize overlay"
            className="overlay-control"
            disabled={!canControlWindow}
            title={canControlWindow ? "Minimize overlay" : "Window controls unavailable"}
            type="button"
          >
            <Minus aria-hidden="true" size={16} />
          </button>
        </header>

        <div className="overlay-body">
          <span className="live-indicator"><Circle aria-hidden="true" size={8} fill="currentColor" /> Ready</span>
          <p>Capture and assistant actions will appear here after the desktop bridge is connected.</p>
        </div>

        <footer className="overlay-footer">
          <Sparkles aria-hidden="true" size={15} />
          <span>Overlay shell · capabilities offline</span>
        </footer>
      </section>
    </main>
  )
}
