import { randomUUID } from 'node:crypto'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { guardedFetch } from './fetch-diagnostics.js'
import { withGenerationTimeout } from './generation-timeout.js'
import { downloadPublicImage } from './public-image-download.js'
import { redactSecrets } from './redact.js'
import { detectImageMediaType, type ResolvedReferenceImage } from './reference-image.js'
import { imageEndpoint, readBoundedText, toDataUrl } from './seedream.js'
import { seedreamGeneratesTransparent } from './shared.js'
import { prepareWorkspaceImageDir } from './workspace-save.js'

interface LayerInput {
  source: ResolvedReferenceImage
  model: string
  apiKey: string
  baseURL: string
  prompt?: string | undefined
  size?: string | undefined
  maxImages?: number | undefined
  /** Ark adds its "AI generated" mark unless told otherwise, so the user's setting is always sent. */
  watermark: boolean
  /** Bounds the upstream decomposition call only; each layer download keeps its own timeout. */
  requestTimeoutMs: number
  workspaceRoot: string
  folder?: string | undefined
  maxBytes: number
  signal: AbortSignal
}

export interface LayerResult {
  directory: string
  manifest: string
  imageCount: number
  /** Layers Ark billed but that could not be saved; listed in the manifest with their URLs. */
  missingCount: number
}

interface Layer {
  url: string
  z_index: number
  name?: string
  size?: string
  description?: string
  bounding_box?: { absolute?: number[]; normalized?: number[] }
}

interface MissingLayer {
  z_index?: number
  name?: string
  url?: string
  error: string
}

/**
 * Split the response into downloadable layers and entries that cannot be saved.
 * Ark bills every output image, so one bad entry must not discard the others.
 */
function parseLayers(text: string, limit: number): { layers: Layer[]; missing: MissingLayer[] } {
  const { data } = JSON.parse(text) as { data?: unknown[] }
  if (!Array.isArray(data) || !data.length || data.length > limit) throw new Error('Seedream returned an invalid layer count')
  const indices = new Set<number>()
  const layers: Layer[] = []
  const missing: MissingLayer[] = []
  for (const entry of data) {
    const layer = (entry ?? {}) as Partial<Layer> & { error?: { message?: unknown } }
    const zIndex = Number.isSafeInteger(layer.z_index) && layer.z_index! >= 0 ? layer.z_index! : undefined
    if (zIndex !== undefined && indices.has(zIndex)) throw new Error('Seedream returned a duplicate layer')
    if (zIndex !== undefined) indices.add(zIndex)
    if (zIndex === undefined || typeof layer.url !== 'string') {
      const reason = typeof layer.error?.message === 'string' ? layer.error.message : 'Seedream returned an incomplete layer'
      missing.push({ ...(zIndex === undefined ? {} : { z_index: zIndex }), ...(typeof layer.name === 'string' ? { name: layer.name } : {}), error: reason })
      continue
    }
    layers.push(layer as Layer)
  }
  if (!indices.has(0)) missing.push({ z_index: 0, error: 'Seedream returned no base layer' })
  if (!layers.length) throw new Error(`Seedream returned no downloadable layer: ${missing[0]?.error ?? 'unknown'}`)
  return { layers: layers.sort((a, b) => a.z_index - b.z_index), missing }
}

/**
 * Save every layer that downloads and record the rest in the manifest. The set is
 * staged and published with one rename, so a cancelled run leaves nothing behind.
 */
export async function decomposeSeedreamLayers(input: LayerInput): Promise<LayerResult> {
  const { model, source, signal, maxImages } = input
  const newer = seedreamGeneratesTransparent(model)
  if (!newer && !/seedream-5-0-(?:pro|flash)(?:-\d+)?$/.test(model) && !model.startsWith('ep-')) {
    throw new Error('图层拆分需要 Seedream 5.0 pro、5.0 flash 或 5.5。')
  }
  if (maxImages !== undefined && (!newer || !Number.isInteger(maxImages) || maxImages < 2 || maxImages > 100)) {
    throw new Error('max_images 仅支持 Seedream 5.5，范围为 2–100（含底图）。')
  }
  if (!['image/png', 'image/jpeg'].includes(source.mediaType) || source.data.length > Math.min(input.maxBytes, 30 * 1024 * 1024)) {
    throw new Error('图层拆分需要一张不超过上传大小限制的 PNG 或 JPEG。')
  }
  signal.throwIfAborted()
  const parent = await prepareWorkspaceImageDir(input.workspaceRoot, input.folder)
  const text = await withGenerationTimeout(input.requestTimeoutMs, signal, async requestSignal => {
    const response = await guardedFetch('Seedream layer decomposition', requestSignal, () => fetch(imageEndpoint(input.baseURL), {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, image: toDataUrl(source), prompt: input.prompt?.trim() || '将图中的独立元素拆成透明图层，并补全底图。',
        layer_decomposition: true, response_format: 'url', output_format: 'png', size: input.size ?? 'auto', watermark: input.watermark,
        ...(maxImages === undefined ? {} : { layer_decomposition_options: { max_images: maxImages } }),
      }),
    }), input.apiKey)
    const body = await readBoundedText(response, 1024 * 1024)
    if (!response.ok) throw new Error(`Seedream layer decomposition failed (${response.status}): ${redactSecrets(body, input.apiKey).slice(0, 4096)}`)
    return body
  })
  const { layers, missing } = parseLayers(text, maxImages ?? (newer || model.startsWith('ep-') ? 100 : 17))
  const staging = await mkdtemp(join(parent, '.seedream-layers-'))
  const directory = join(parent, `seedream-layers-${randomUUID()}`)
  const files = []
  try {
    let remaining = 512 * 1024 * 1024
    for (const { url, z_index, name, description, bounding_box, size } of layers) {
      signal.throwIfAborted()
      try {
        if (remaining <= 0) throw new Error('Seedream layer files exceeded 512 MiB')
        const { data } = await downloadPublicImage(url, { maxBytes: Math.min(input.maxBytes, remaining), signal })
        if (detectImageMediaType(data) !== 'image/png') throw new Error(`Seedream layer ${z_index} is not PNG`)
        remaining -= data.length
        const file = z_index === 0 ? 'base.png' : `layer-${z_index}.png`
        await writeFile(join(staging, file), data, { signal, flag: 'wx' })
        files.push({ file, z_index, name, description, bounding_box, size })
      } catch (error) {
        // A cancel stops the whole run; any other failure costs only this layer.
        if (signal.aborted) throw error
        missing.push({ z_index, ...(name === undefined ? {} : { name }), url, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (!files.length) throw new Error(`Seedream layers could not be downloaded: ${missing[0]?.error ?? 'unknown'}`)
    missing.sort((a, b) => (a.z_index ?? Infinity) - (b.z_index ?? Infinity))
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ model, layers: files, ...(missing.length ? { missing } : {}) }, null, 2), { signal })
    signal.throwIfAborted()
    await rename(staging, directory)
    if (signal.aborted) {
      await rm(directory, { recursive: true, force: true })
      signal.throwIfAborted()
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return { directory, manifest: join(directory, 'manifest.json'), imageCount: files.length, missingCount: missing.length }
}
