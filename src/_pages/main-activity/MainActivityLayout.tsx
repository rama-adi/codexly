import React from "react"
import { Link, Outlet, useLocation } from "react-router-dom"
import {
  History as HistoryIcon,
  Home as HomeIcon,
  SlidersHorizontal,
  Settings as SettingsIcon,
  Sparkles
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from "@/components/ui/sidebar"
import { PageActionsProvider } from "@/components/ui/page-header"

type NavItem = {
  title: string
  to: string
  icon: React.ComponentType<{ className?: string }>
}

const primaryNav: NavItem[] = [
  { title: "Home", to: "/home", icon: HomeIcon },
  { title: "Personalization", to: "/personalization", icon: SlidersHorizontal },
  { title: "History", to: "/history", icon: HistoryIcon }
]

const footerNav: NavItem[] = [
  { title: "Settings", to: "/settings", icon: SettingsIcon }
]

const titleByPath: Record<string, string> = {
  "/home": "Home",
  "/personalization": "Personalization",
  "/history": "History",
  "/settings": "Settings"
}

const InactiveMacTrafficLights: React.FC = () => (
  <div
    className="pointer-events-none absolute left-4 top-1/2 flex -translate-y-1/2 items-center gap-2"
    aria-hidden="true"
  >
    <span className="size-3 rounded-full border border-border bg-muted" />
    <span className="size-3 rounded-full border border-border bg-muted" />
    <span className="size-3 rounded-full border border-border bg-muted" />
  </div>
)

const renderNavItem = (item: NavItem, activePath: string) => {
  const Icon = item.icon
  const active = activePath === item.to
  return (
    <SidebarMenuItem key={item.to}>
      <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
        <Link to={item.to}>
          <Icon />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

const MainActivityLayout: React.FC = () => {
  const isMac = window.electronAPI.platform === "darwin"
  const [isWindowFocused, setIsWindowFocused] = React.useState(
    document.hasFocus()
  )
  const [actions, setActions] = React.useState<React.ReactNode>(null)
  const location = useLocation()
  const title = titleByPath[location.pathname] ?? "Home"
  const toggleWindowMaximize = () => {
    window.electronAPI.toggleCurrentWindowMaximize?.()
  }

  React.useEffect(() => {
    const handleFocus = () => setIsWindowFocused(true)
    const handleBlur = () => setIsWindowFocused(false)

    window.addEventListener("focus", handleFocus)
    window.addEventListener("blur", handleBlur)

    return () => {
      window.removeEventListener("focus", handleFocus)
      window.removeEventListener("blur", handleBlur)
    }
  }, [])

  return (
    <SidebarProvider
      style={{ "--sidebar-width": "12rem" } as React.CSSProperties}
    >
      <div
        className="h-screen min-h-screen w-full overflow-hidden bg-background text-foreground"
        data-clickable-root
      >
        <div className="flex h-full min-h-0 w-full">
          <Sidebar
            collapsible="none"
            className="h-full min-h-screen shrink-0 border-r border-sidebar-border bg-sidebar"
          >
            <SidebarHeader
              onDoubleClick={toggleWindowMaximize}
              className={`draggable-area relative h-12 shrink-0 flex-row items-center gap-2 border-b border-sidebar-border px-4 py-0 wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)] ${
                isMac ? "pl-[90px]" : ""
              }`}
            >
              {isMac && !isWindowFocused && <InactiveMacTrafficLights />}
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Sparkles className="size-3.5" />
                </span>
                <span className="truncate text-sm font-semibold tracking-normal">
                  Codexly
                </span>
              </div>
            </SidebarHeader>
            <SidebarContent className="min-h-0">
              <SidebarGroup>
                <SidebarGroupLabel>Navigation</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {primaryNav.map(item => renderNavItem(item, location.pathname))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter className="shrink-0 border-t border-sidebar-border">
              <SidebarMenu>
                {footerNav.map(item => renderNavItem(item, location.pathname))}
              </SidebarMenu>
            </SidebarFooter>
          </Sidebar>
          <SidebarInset className="flex min-h-0 flex-col bg-background">
            <header
              onDoubleClick={toggleWindowMaximize}
              className="draggable-area sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
            >
              <h1 className="truncate text-sm font-semibold tracking-normal">
                {title}
              </h1>
              {actions && (
                <div className="flex shrink-0 items-center gap-2">
                  {actions}
                </div>
              )}
            </header>
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <PageActionsProvider setActions={setActions}>
                <Outlet />
              </PageActionsProvider>
            </main>
          </SidebarInset>
        </div>
      </div>
    </SidebarProvider>
  )
}

export default MainActivityLayout
