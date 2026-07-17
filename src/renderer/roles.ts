export const rendererRoles = ["homepage", "overlay"] as const

export type RendererRole = (typeof rendererRoles)[number]

const roleSet = new Set<string>(rendererRoles)

/** Resolves only supported renderer roles; malformed or unknown values are safe. */
export const resolveRendererRole = (search: string): RendererRole => {
  const role = new URLSearchParams(search).get("role")
  return role !== null && roleSet.has(role) ? (role as RendererRole) : "homepage"
}

export type HomepageSection = "workspace" | "activity" | "preferences"

export const homepageSections: HomepageSection[] = [
  "workspace",
  "activity",
  "preferences",
]

const sectionSet = new Set<string>(homepageSections)

export const resolveHomepageSection = (hash: string): HomepageSection => {
  const section = hash.replace(/^#/, "").split("?")[0]
  return sectionSet.has(section) ? (section as HomepageSection) : "workspace"
}
