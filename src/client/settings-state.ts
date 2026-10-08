/** Preserve modern form states while accepting legacy scopes without status/mode. */
import { SETTINGS_HEALTH_ROUTE, type SettingsHealth } from '../shared.js'

export interface SettingsScopeSnapshot<T> {
  value: T | undefined
  writable: boolean
  status?: 'loading' | 'ready' | 'unavailable'
  mode?: 'host' | 'memory'
}

export type SettingsState = 'ready' | 'loading' | 'remote' | 'unavailable' | 'readOnly' | 'incompatible'

export function settingsState(snapshot: SettingsScopeSnapshot<unknown>, health?: SettingsHealth): SettingsState {
  if (snapshot.mode === 'memory') return 'remote'
  if (health?.settings === 'live' && !health.liveSchema) return 'incompatible'
  if (snapshot.status === 'loading') return 'loading'
  if (snapshot.status === 'unavailable') return 'unavailable'
  return snapshot.writable ? 'ready' : 'readOnly'
}

/** A failed probe cannot identify the cause; keep the host's own form state. */
export async function fetchSettingsHealth(signal: AbortSignal): Promise<SettingsHealth | undefined> {
  try {
    const response = await fetch(SETTINGS_HEALTH_ROUTE, { cache: 'no-store', signal })
    if (!response.ok) return undefined
    const health = await response.json() as Partial<SettingsHealth> | null
    if (health === null || typeof health.liveSchema !== 'boolean'
      || !['live', 'legacy', 'unavailable'].includes(health.settings ?? '')) return undefined
    return { settings: health.settings as SettingsHealth['settings'], liveSchema: health.liveSchema }
  } catch { return undefined }
}
