import { getSettings, setSetting, getSettingSync } from './settings'
import { broadcast } from './broadcast'
import { appendActivity } from './activity-manager'

export async function isCronsPaused(): Promise<boolean> {
  const s = await getSettings()
  return s.cronsPaused === 'true'
}

/** Sync read from cached settings — use in setInterval callbacks where await isn't practical */
export function isCronsPausedSync(): boolean {
  return getSettingSync('cronsPaused') === 'true'
}

export async function setCronsPaused(paused: boolean): Promise<void> {
  await setSetting('cronsPaused', paused ? 'true' : 'false')
  broadcast('colony:cronsPauseChange', paused)
  appendActivity({
    source: 'pipeline',
    name: 'Cron Pause',
    summary: paused ? 'All cron jobs paused manually' : 'All cron jobs resumed manually',
    level: 'info',
  }).catch(() => {})
}
