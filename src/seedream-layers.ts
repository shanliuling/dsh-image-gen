import { randomUUID } from 'node:crypto'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { guardedFetch } from './fetch-diagnostics.js'
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
  workspaceRoot: string
  folder?: string | undefined
  maxBytes: number
  signal: AbortSignal
}

export interface LayerResult {
  directory: string
  manifest: string
  imageCount: number
}

interface Layer {
  url: string
  z_index: number
  name?: string
  size?: string
  description?: string
  bounding_box?: { absolute?: number[]; normalized?: number[] }
}

function parseLayers(text: string, limit: number): Layer[] {
  const { data } = JSON.parse(text) as { data?: Layer[] }
  if (!Array.isArray(data) || !data.length || data.length > limit) throw new Error('Seedream returned an invalid layer count')
  const indices = new Set<number>()
  for (const layer of data) {
    if (!layer || typeof layer.url !== 'string' || !Number.isSafeInteger(layer.z_index) || layer.z_index < 0 || indices.has(layer.z_index)) {
      throw new Error('Seedream returned an incomplete or duplicate layer')
    }
    indices.add(layer.z_index)
  }
  if (!indices.has(0)) throw new Error('Seedream returned no base layer')
  return data.sort((a, b) => a.z_index - b.z_index)
}

/** Publish a complete layer set together so an interrupted download never looks complete. */
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
  const response = await guardedFetch('Seedream layer decomposition', signal, () => fetch(imageEndpoint(input.baseURL), {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, image: toDataUrl(source), prompt: input.prompt?.trim() || '将图中的独立元素拆成透明图层，并补全底图。',
      layer_decomposition: true, response_format: 'url', output_format: 'png', size: input.size ?? 'auto',
      ...(maxImages === undefined ? {} : { layer_decomposition_options: { max_images: maxImages } }),
    }),
  }), input.apiKey)
  const text = await readBoundedText(response, 1024 * 1024)
  if (!response.ok) throw new Error(`Seedream layer decomposition failed (${response.status}): ${redactSecrets(text, input.apiKey).slice(0, 4096)}`)
  const layers = parseLayers(text, maxImages ?? (newer || model.startsWith('ep-') ? 100 : 17))
  const staging = await mkdtemp(join(parent, '.seedream-layers-'))
  const directory = join(parent, `seedream-layers-${randomUUID()}`)
  try {
    let remaining = 512 * 1024 * 1024
    const files = []
    for (const { url, z_index, name, description, bounding_box, size } of layers) {
      signal.throwIfAborted()
      if (remaining <= 0) throw new Error('Seedream layer files exceeded 512 MiB')
      const { data } = await downloadPublicImage(url, { maxBytes: Math.min(input.maxBytes, remaining), signal })
      if (detectImageMediaType(data) !== 'image/png') throw new Error(`Seedream layer ${z_index} is not PNG`)
      remaining -= data.length
      const file = z_index === 0 ? 'base.png' : `layer-${z_index}.png`
      await writeFile(join(staging, file), data, { signal, flag: 'wx' })
      files.push({ file, z_index, name, description, bounding_box, size })
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ model, layers: files }, null, 2), { signal })
    signal.throwIfAborted()
    await rename(staging, directory)
    if (signal.aborted) {
      await rm(directory, { recursive: true, force: true })
      signal.throwIfAborted()
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return { directory, manifest: join(directory, 'manifest.json'), imageCount: layers.length }
}
