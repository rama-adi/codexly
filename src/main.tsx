import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

function mount() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

// The browser harness (src/harness) installs an in-memory bridge for
// `?harness` / `?scenario` pages, and must do so before React mounts. The
// guarded dynamic import keeps every harness module out of production builds,
// and the installer is a no-op when a real desktop bridge is present.
if (import.meta.env.DEV) {
  void import("./harness/install")
    .then((harness) => harness.installHarnessIfRequested())
    .catch((error) => console.error("[harness] install failed", error))
    .finally(mount)
} else {
  mount()
}
