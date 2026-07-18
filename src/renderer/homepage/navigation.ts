import type { ComponentType } from 'react'
import { History, House, Settings, SlidersHorizontal } from 'lucide-react'

export type NavId = 'overview' | 'history' | 'personalization' | 'settings'

export type IconComponent = ComponentType<{ className?: string }>

export interface NavItem {
  id: NavId
  label: string
  icon: IconComponent
  group?: 'footer'
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'overview', label: 'Home', icon: House },
  { id: 'history', label: 'History', icon: History },
  { id: 'personalization', label: 'Personalization', icon: SlidersHorizontal },
  { id: 'settings', label: 'Settings', icon: Settings, group: 'footer' },
]

const NAV_IDS = new Set<string>(NAV_ITEMS.map((item) => item.id))

export function resolveNav(hash: string): NavId {
  const candidate = hash.replace(/^#/, '').split('?')[0]
  return NAV_IDS.has(candidate) ? (candidate as NavId) : 'overview'
}

export const NAV_TITLES: Record<NavId, string> = {
  overview: 'Home',
  history: 'History',
  personalization: 'Personalization',
  settings: 'Settings',
}
