/** Shared BYOK credential resolution for the Agent tools and the Studio route. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { CLOUD_CREDENTIAL_REFS, PROVIDER_DISPLAY_NAMES, type CloudImageProvider } from './shared.js'

/**
 * Resolve one provider's stored API key to a non-blank value. Blank values
 * never count as configured: the host treats an empty stored value as absent,
 * and a whitespace-only key is never sent to a provider.
 */
export async function resolveApiKey(ctx: Context, provider: CloudImageProvider, keyRef?: string): Promise<string | undefined> {
  const credential = await ctx.credentials.resolve(credentialRef(keyRef ?? CLOUD_CREDENTIAL_REFS[provider]))
  const value = credential?.value.trim() ?? ''
  return value.length > 0 ? value : undefined
}

/**
 * Resolve one provider's API key or fail with a user-facing message that says
 * where to configure it. Passing `tool` selects the Agent-facing English
 * wording; without it the message is the browser-facing Chinese one used by
 * the Studio route.
 */
export async function requireApiKey(ctx: Context, provider: CloudImageProvider, tool?: string, keyRef?: string): Promise<string> {
  const value = await resolveApiKey(ctx, provider, keyRef)
  if (value !== undefined) return value
  throw new Error(tool === undefined
    ? `${PROVIDER_DISPLAY_NAMES[provider]} 尚未配置 API Key，请先到 设置 > 插件 > 图像生成 配置`
    : `${tool} requires the ${PROVIDER_DISPLAY_NAMES[provider]} API key; configure it in Settings > Plugins > Image generation.`)
}
