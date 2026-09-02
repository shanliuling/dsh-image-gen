/** Same-origin HTTP bridge used by the browser image workbench. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { parseImageAttachmentRef } from './reference-image.js'
import {
  CLOUD_IMAGE_PROVIDERS,
  type CloudImageProvider,
  type StudioConfigResponse,
  type StudioGenerateRequest,
  type StudioGenerateResponse,
  type StudioReference,
} from './shared.js'

export interface StudioRouteDeps {
  describe(): Promise<StudioConfigResponse>
  generate(input: StudioGenerateRequest, signal: AbortSignal): Promise<StudioGenerateResponse>
  maxBodyBytes: number
}

/** Serve workbench capabilities and generation requests without exposing provider credentials. */
export async function serveStudio(req: IncomingMessage, res: ServerResponse, deps: StudioRouteDeps): Promise<void> {
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  if (req.method === 'GET') {
    try {
      return json(res, 200, await deps.describe())
    } catch (error) {
      return jsonError(res, 500, errorMessage(error, 'studio-unavailable'))
    }
  }
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return jsonError(res, 415, 'json-required')
  }

  const controller = new AbortController()
  const onConnectionClose = () => {
    if (!res.writableEnded) {
      controller.abort(new Error('The browser closed the image generation request.'))
    }
  }
  const onReqAborted = () => {
    controller.abort(new Error('The browser closed the image generation request.'))
  }

  res.once('close', onConnectionClose)
  req.once('aborted', onReqAborted)

  try {
    let input: StudioGenerateRequest
    try {
      input = parseStudioGenerateRequest(JSON.parse(await readBody(req, deps.maxBodyBytes)))
    } catch (error) {
      return jsonError(res, 400, errorMessage(error, 'invalid-request'))
    }
    const output = await deps.generate(input, controller.signal)
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      json(res, 200, output)
    }
  } catch (error) {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      // Client disconnected prematurely; do not write to closed/destroyed socket
      return
    }
    jsonError(res, controller.signal.aborted ? 499 : 502, errorMessage(error, 'generation-failed'))
  } finally {
    res.off('close', onConnectionClose)
    req.off('aborted', onReqAborted)
  }
}

/** Strictly validate the small untrusted workbench wire contract. */
export function parseStudioGenerateRequest(value: unknown): StudioGenerateRequest {
  const input = record(value)
  if (input === undefined) throw new Error('请求格式无效')
  if (input.mode !== 'generate' && input.mode !== 'edit') throw new Error('请选择生成类型')
  if (!cloudProvider(input.provider)) throw new Error('不支持该图像 Provider')
  const prompt = requiredText(input.prompt, '请输入提示词', 2_000)
  const model = requiredText(input.model, '请选择模型', 200)
  const ratio = requiredText(input.ratio, '请选择比例', 32)
  const quality = requiredText(input.quality, '请选择清晰度', 32)
  const rawReferences = Array.isArray(input.references)
    ? input.references
    : input.reference !== undefined
      ? [input.reference]
      : []
  const references = rawReferences.map(parseReference)
  if (input.mode === 'edit' && references.length === 0) throw new Error('图生图需要至少一张参考图')
  if (references.length > 5) throw new Error('最多支持上传 5 张参考图')
  const workspaceRoot = typeof input.workspaceRoot === 'string' && input.workspaceRoot.trim().length > 0
    ? input.workspaceRoot.trim()
    : undefined
  return {
    mode: input.mode,
    provider: input.provider,
    model,
    prompt,
    ratio,
    quality,
    ...(references.length > 0 ? { references, reference: references[0] } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  }
}

function parseReference(value: unknown): StudioReference {
  const reference = record(value)
  if (reference === undefined) throw new Error('参考图格式无效')
  if ('attachment' in reference) {
    const attachment = parseImageAttachmentRef(reference.attachment)
    if (attachment === undefined) throw new Error('参考图附件无效')
    return { attachment }
  }
  if (!imageMediaType(reference.mediaType) || typeof reference.data !== 'string') {
    throw new Error('参考图格式无效')
  }
  if (reference.data.length === 0) throw new Error('参考图内容为空')
  if (reference.name !== undefined && typeof reference.name !== 'string') throw new Error('参考图名称无效')
  return {
    mediaType: reference.mediaType,
    data: reference.data,
    ...(typeof reference.name === 'string' ? { name: reference.name.slice(0, 240) } : {}),
  }
}

function requiredText(value: unknown, message: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message)
  const text = value.trim()
  if (text.length > maxLength) throw new Error(`${message}（最多 ${String(maxLength)} 个字符）`)
  return text
}

function cloudProvider(value: unknown): value is CloudImageProvider {
  return typeof value === 'string' && (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(value)
}

function imageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  return origin === undefined || host === undefined || origin === `http://${host}` || origin === `https://${host}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new Error('参考图过大，请压缩后重试')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  json(res, status, { error: message })
}
