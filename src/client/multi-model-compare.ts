import { studioTargetKey, type StudioOption, type StudioProvider, type StudioProviderProfile } from '../shared.js'
import { PROVIDER_DEFAULT_QUALITY } from '../openai-output.js'

export interface ComparisonTarget {
  profile: StudioProviderProfile
  ratio: string
  quality: string
  adjusted: boolean
  resolution?: string
  generationQuality?: string
}

/** Map one shared output intent to settings accepted by every target model. */
export function buildComparisonTargets(
  profiles: readonly StudioProviderProfile[],
  selectedTargets: readonly string[],
  ratio: string,
  quality: string,
  output?: { resolution: string; generationQuality: string },
): ComparisonTarget[] {
  const selected = new Set(selectedTargets)
  return profiles
    .filter(profile => profile.configured && selected.has(studioTargetKey(profile.provider, profile.channel)))
    .map(profile => {
      const targetRatio = profile.ratioOptions.some(option => option.value === ratio) ? ratio : profile.defaultRatio
      const generationOptions = generationQualityOptions(profile)
      const qualityIntent = output === undefined ? quality
        : profile.provider === 'openai' || profile.provider === 'chatgpt-sub' || profile.provider === 'zhipu' ? output.generationQuality : output.resolution
      const targetQuality = profile.qualityOptions.some(option => option.value === qualityIntent) ? qualityIntent : profile.defaultQuality
      const resolutions = profile.resolutionOptions?.[targetRatio]
      const targetResolution = output && resolutions ? (resolutions.some(option => option.value === output.resolution) ? output.resolution : resolutions[0]?.value) : undefined
      const targetGenerationQuality = output && profile.provider === 'openai-compat'
        ? (generationOptions.some(option => option.value === output.generationQuality) ? output.generationQuality : profile.defaultGenerationQuality ?? PROVIDER_DEFAULT_QUALITY) : undefined
      return {
        profile,
        ratio: targetRatio,
        quality: profile.provider === 'openai-compat' ? targetResolution ?? targetQuality : targetQuality,
        adjusted: targetRatio !== ratio || targetQuality !== qualityIntent
          || (targetResolution !== undefined && targetResolution !== output?.resolution)
          || (targetGenerationQuality !== undefined && targetGenerationQuality !== output?.generationQuality),
        ...(targetResolution === undefined ? {} : { resolution: targetResolution }),
        ...(targetGenerationQuality === undefined ? {} : { generationQuality: targetGenerationQuality }),
      }
    })
}

function generationQualityOptions(profile: StudioProviderProfile): StudioOption[] {
  return profile.generationQualityOptions ?? (['openai', 'chatgpt-sub', 'zhipu'].includes(profile.provider) ? profile.qualityOptions : [])
}

/** Keep pixel tiers separate from upstream quality values in comparison mode. */
export function comparisonOutputOptions(profiles: readonly StudioProviderProfile[], ratio: string, kind: 'resolution' | 'generationQuality'): StudioOption[] {
  const options = new Map<string, StudioOption>()
  for (const profile of profiles) {
    if (!profile.configured) continue
    const entries = kind === 'generationQuality' ? generationQualityOptions(profile)
      : profile.resolutionOptions ? profile.resolutionOptions[ratio] ?? profile.resolutionOptions[profile.defaultRatio] ?? []
      : ['chatgpt-sub', 'zhipu'].includes(profile.provider) ? [] : profile.qualityOptions
    for (const entry of entries) if (!options.has(entry.value)) options.set(entry.value, { value: entry.value, label: entry.value === PROVIDER_DEFAULT_QUALITY ? entry.label : entry.value })
  }
  return [...options.values()]
}

/** Start with two models, not every configured API, to avoid surprise spend. */
export function initialComparisonProviders(
  profiles: readonly StudioProviderProfile[],
  activeProvider: StudioProvider,
  activeChannel?: string,
): string[] {
  const configured = profiles.filter(profile => profile.configured)
  const active = configured.find(profile => studioTargetKey(profile.provider, profile.channel) === studioTargetKey(activeProvider, activeChannel))
    ?? configured.find(profile => profile.provider === activeProvider)
  const activeKey = active === undefined ? undefined : studioTargetKey(active.provider, active.channel)
  const ordered = active === undefined
    ? configured
    : [active, ...configured.filter(profile => studioTargetKey(profile.provider, profile.channel) !== activeKey)]
  return ordered.slice(0, 2).map(profile => studioTargetKey(profile.provider, profile.channel))
}

const RATIO_SORT_ORDER = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9']
const QUALITY_SORT_ORDER = ['auto', 'standard', '1k', '1K', '2k', '2K', '3K', '4K', 'low', 'medium', 'high', 'xhigh', 'max', 'hd']

/** Union of every configured profile's options, for the shared comparison pickers. */
export function comparisonOptionUnion(
  profiles: readonly StudioProviderProfile[],
  key: 'ratioOptions' | 'qualityOptions',
): StudioOption[] {
  const sortOrder = key === 'ratioOptions' ? RATIO_SORT_ORDER : QUALITY_SORT_ORDER
  const seen = new Map<string, StudioOption>()
  for (const profile of profiles) {
    if (!profile.configured) continue
    for (const option of profile[key]) if (!seen.has(option.value)) seen.set(option.value, option)
  }
  const rank = (value: string): number => {
    const index = sortOrder.indexOf(value)
    return index === -1 ? sortOrder.length : index
  }
  return [...seen.values()].sort((a, b) => rank(a.value) - rank(b.value))
}
