import { HomepageApp } from "./renderer/HomepageApp"
import { OverlayApp } from "./renderer/OverlayApp"
import { resolveRendererRole } from "./renderer/roles"

export function App({ search = typeof window === "undefined" ? "" : window.location.search }: { search?: string }) {
  const role = resolveRendererRole(search)

  return (
    <div className={`renderer-root renderer-root--${role}`} data-renderer-role={role}>
      {role === "overlay" ? <OverlayApp /> : <HomepageApp />}
    </div>
  )
}

export default App
