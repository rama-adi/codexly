import React from "react"
import ReactDOM from "react-dom/client"
import { HashRouter } from "react-router-dom"
import App from "./App"
import "streamdown/styles.css"
import "./index.css"
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay"

syncDocumentWindowControlsOverlayClass()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
)
