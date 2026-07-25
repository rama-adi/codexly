import { Homepage } from './homepage/Homepage'
import { SettingsProvider } from './homepage/hooks/SettingsProvider'

export function HomepageApp() {
  return (
    <SettingsProvider>
      <Homepage />
    </SettingsProvider>
  )
}
