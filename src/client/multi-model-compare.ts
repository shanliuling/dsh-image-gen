import type { CloudImageProvider, StudioProviderProfile } from '../shared.js'

export interface ComparisonTarget {
  profile: StudioProviderProfile
  ratio: string
  quality: string
  adjusted: boolean
}

/** Map one shared output intent to settings accepted by every target model. */
export function buildComparisonTargets(
  profiles: readonly StudioProviderProfile[],
  selectedProviders: readonly CloudImageProvider[],
  ratio: string,
  quality: string,
): ComparisonTarget[] {
  const selected = new Set(selectedProviders)
  return profiles
    .filter(profile => profile.configured && selected.has(profile.provider))
    .map(profile => {
      const targetRatio = profile.ratioOptions.some(option => option.value === ratio) ? ratio : profile.defaultRatio
      const targetQuality = profile.qualityOptions.some(option => option.value === quality) ? quality : profile.defaultQuality
      return {
        profile,
        ratio: targetRatio,
        quality: targetQuality,
        adjusted: targetRatio !== ratio || targetQuality !== quality,
      }
    })
}

/** Start with two models, not every configured API, to avoid surprise spend. */
export function initialComparisonProviders(
  profiles: readonly StudioProviderProfile[],
  activeProvider: CloudImageProvider,
): CloudImageProvider[] {
  const configured = profiles.filter(profile => profile.configured)
  const active = configured.find(profile => profile.provider === activeProvider)
  const ordered = active === undefined
    ? configured
    : [active, ...configured.filter(profile => profile.provider !== activeProvider)]
  return ordered.slice(0, 2).map(profile => profile.provider)
}
