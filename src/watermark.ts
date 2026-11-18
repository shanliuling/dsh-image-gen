/** Visible-watermark contracts, resolved separately for generation and editing. */
import type { Config } from './config.js'
import type { CompatEditFormat } from './openai-compatible.js'
import type { StudioOption, StudioProvider, StudioWatermark, StudioWatermarkCapability } from './shared.js'

type Mode = 'generate' | 'edit'
type WatermarkField = 'watermark' | 'watermark_enabled' | 'parameters.watermark'

export const WATERMARK_OPTIONS: StudioOption[] = [
  { value: 'default', label: '渠道默认' },
  { value: 'off', label: '关闭' },
  { value: 'on', label: '开启' },
]

function configuredField(extra: Record<string, unknown> | undefined): WatermarkField | undefined {
  if (typeof extra?.watermark === 'boolean') return 'watermark'
  if (typeof extra?.watermark_enabled === 'boolean') return 'watermark_enabled'
  const parameters = extra?.parameters
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    && typeof (parameters as Record<string, unknown>).watermark === 'boolean') return 'parameters.watermark'
  return undefined
}

/** Model names alone do not establish the protocol of an unknown relay. */
function officialContract(config: Config, mode: Mode): 'sensenova' | 'qwen' | undefined {
  const extra = mode === 'generate' ? config.openaiCompatExtraBody : config.openaiCompatEditExtra
  const model = extra?.model ?? (mode === 'edit' ? config.openaiCompatEditModel?.trim() || config.openaiCompatModel : config.openaiCompatModel)
  if (typeof model !== 'string') return undefined
  try {
    const url = new URL(config.openaiCompatBaseURL ?? '')
    if (url.protocol !== 'https:' || url.port || url.search || url.hash) return undefined
    const path = url.pathname.replace(/\/+$/, '')
    if (url.hostname === 'token.sensenova.cn' && path === '/v1' && model === 'sensenova-u1.5-lite') return 'sensenova'
    // Official workspace endpoints documented by Model Studio; anchor the entire hostname.
    const qwenHost = /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(url.hostname)
    if (qwenHost && path === '/compatible-mode/v1'
      && /^qwen-image-(?:3\.0(?:-pro)?|2\.1-(?:pro|turbo))$/.test(model)) return 'qwen'
  } catch { /* An incomplete channel cannot establish an official contract. */ }
  return undefined
}

/** Known official edit contracts take precedence over relay-specific format settings. */
export function compatEditFormat(config: Config): CompatEditFormat {
  try {
    const url = new URL(config.openaiCompatBaseURL ?? '')
    const official = url.protocol === 'https:' && !url.port && !url.search && !url.hash && url.pathname.replace(/\/+$/, '') === '/v1'
    if (official && (url.hostname === 'api.siliconflow.cn' || url.hostname === 'api.siliconflow.com')) return 'siliconflowJson'
    // ModelScope API-Inference only runs image jobs as async tasks (#140), so
    // its official address selects the task flow without a settings choice.
    if (official && url.hostname === 'api-inference.modelscope.cn') return 'modelscopeAsync'
  } catch { /* Custom relays can select the protocol explicitly. */ }
  const contract = officialContract(config, 'edit')
  if (contract === 'sensenova') return 'jsonImageUrlArray'
  if (contract === 'qwen') return 'qwenJson'
  return config.openaiCompatEditFormat ?? 'multipart'
}

export function compatWatermarkField(config: Config, mode: Mode = 'generate'): WatermarkField | undefined {
  if (officialContract(config, mode) !== undefined) return 'watermark'
  if (mode === 'generate') return configuredField(config.openaiCompatExtraBody)
  // EditExtra is only forwarded by JSON edits; generation extras cannot establish edit support.
  return compatEditFormat(config) === 'jsonImageUrlArray' ? configuredField(config.openaiCompatEditExtra) : undefined
}

export function compatWatermarkOptions(config: Config, mode: Mode = 'generate'): StudioOption[] | undefined {
  return compatWatermarkField(config, mode) === undefined ? undefined : WATERMARK_OPTIONS
}

function overrideField(extra: Record<string, unknown> | undefined, field: WatermarkField, selected: StudioWatermark): Record<string, unknown> {
  const watermark = selected === 'on'
  return field === 'parameters.watermark'
    ? { ...extra, parameters: { ...(extra?.parameters as Record<string, unknown>), watermark } }
    : { ...extra, [field]: watermark }
}

/** Preserve all advanced fields; only an explicit workbench choice overrides its own watermark. */
export function compatGenerationExtraBody(config: Config, selected?: StudioWatermark): Record<string, unknown> | undefined {
  const extra = config.openaiCompatExtraBody
  if (selected === undefined || selected === 'default') return extra
  const field = compatWatermarkField(config)
  if (field === undefined) throw new Error('该渠道尚未确认文生图水印支持，请刷新工作台')
  return overrideField(extra, field, selected)
}

export function compatEditExtraBody(config: Config, selected?: StudioWatermark): Record<string, unknown> | undefined {
  if (selected === undefined || selected === 'default') return undefined
  const field = compatWatermarkField(config, 'edit')
  if (field === undefined) throw new Error('该渠道尚未确认图生图水印支持，请刷新工作台')
  return overrideField(config.openaiCompatEditExtra, field, selected)
}

export function selectedWatermark(selected: StudioWatermark | undefined, channelDefault?: boolean): boolean | undefined {
  return selected === 'off' ? false : selected === 'on' ? true : channelDefault
}

export function watermarkProfile(config: Config, provider: StudioProvider, model: string): {
  watermarkCapabilities: Record<Mode, StudioWatermarkCapability>
  watermarkOptions?: StudioOption[]
} {
  const capability = (mode: Mode): StudioWatermarkCapability => {
    if (provider === 'seedream' || (provider === 'dashscope' && /^qwen-image(?:$|-)/.test(model))) return { status: 'supported' }
    if (provider === 'openai-compat') return compatWatermarkField(config, mode) === undefined
      ? { status: 'unknown', reason: mode === 'edit' && configuredField(config.openaiCompatEditExtra) !== undefined ? 'edit-format' : 'channel-unconfirmed' }
      : { status: 'supported' }
    if (provider === 'zhipu') return { status: 'unknown', reason: 'account-unconfirmed' }
    if (provider === 'dashscope') return { status: 'unknown', reason: 'model-unconfirmed' }
    return { status: 'unavailable', reason: 'no-api-control' }
  }
  const generate = capability('generate')
  return {
    watermarkCapabilities: { generate, edit: capability('edit') },
    ...(generate.status === 'supported' ? { watermarkOptions: WATERMARK_OPTIONS } : {}),
  }
}
