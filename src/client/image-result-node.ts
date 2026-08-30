/** Modern DSH conversation node that keeps completed image artifacts outside Compact process folding. */
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

export const IMAGE_RESULT_NODE_KIND = 'dsh-image-result'

export interface ImageResultPresentation {
  readonly attachment: ImageAttachmentRef
  readonly prompt: string
  readonly provider: string
  readonly model: string
  readonly output: string
  readonly savedTo?: string
}

interface ImageResultState {
  readonly turn: number
  readonly results: readonly (ImageResultPresentation & { readonly seq: number })[]
  readonly answerSeq?: number
  readonly endSeq?: number
}

interface EventLike {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

interface MatchLike {
  readonly event: EventLike
  readonly location: unknown
}

interface ContextLike<State> {
  readonly key: string
  readonly id: string
  readonly matches: readonly MatchLike[]
  readonly start?: MatchLike
  readonly state?: State
}

interface ConversationNodeDefinitionLike<State> {
  readonly kind: string
  readonly target: 'chat'
  match(event: EventLike): { id: string; role: 'start' | 'update' } | null
  start(context: ContextLike<State>, match: MatchLike, reader: unknown): State
  update(context: ContextLike<State> & { readonly state: State }, match: MatchLike): State
  buildViewNode(context: ContextLike<State>): Record<string, unknown> | null
}

/** One image result row per Turn, re-anchored to Turn end after the final answer settles. */
export const imageResultDefinition: ConversationNodeDefinitionLike<ImageResultState> = {
  kind: IMAGE_RESULT_NODE_KIND,
  target: 'chat',
  match: (event) => {
    const turn = eventTurn(event)
    if (turn === undefined) return null
    if (event.type === 'turn/start') return { id: String(turn), role: 'start' }
    if (event.type === 'turn/end') return { id: String(turn), role: 'update' }
    if (event.type === 'assistant/message') return { id: String(turn), role: 'update' }
    if (event.type === 'tool/result' && imageResultFromMeta(event.data.meta) !== undefined) {
      return { id: String(turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    const turn = eventTurn(match.event)
    if (match.event.type !== 'turn/start' || turn === undefined) {
      throw new Error('dsh-image-result start requires turn/start')
    }
    return { turn, results: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'turn/end') return { ...context.state, endSeq: match.event.seq }
    if (match.event.type === 'assistant/message') return { ...context.state, answerSeq: match.event.seq }
    if (match.event.type !== 'tool/result') return context.state
    const result = imageResultFromMeta(match.event.data.meta)
    if (result === undefined) return context.state
    if (context.state.results.some(candidate => candidate.attachment.attachmentId === result.attachment.attachmentId)) {
      return context.state
    }
    return { ...context.state, results: [...context.state.results, { ...result, seq: match.event.seq }] }
  },
  buildViewNode: (context) => {
    const state = context.state
    const last = state?.results.at(-1)
    if (state === undefined || last === undefined) return null
    const location = context.matches.at(-1)?.location ?? context.start?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: IMAGE_RESULT_NODE_KIND,
      id: context.id,
      target: 'chat',
      // Compact folds only nodes before the finalized answer boundary. Sharing
      // that boundary keeps the artifact beside the answer and outside process.
      anchorSeq: state.answerSeq ?? state.endSeq ?? last.seq,
      location,
      visibility: 'visible',
      data: {
        turn: state.turn,
        results: state.results.map(({ seq: _seq, ...result }) => result),
      },
    }
  },
}

/** Parse the plugin-owned durable presentation metadata from a Tool result event. */
export function imageResultFromMeta(value: unknown): ImageResultPresentation | undefined {
  const meta = record(value)
  if (meta?.kind !== 'dsh-image-gen') return undefined
  const attachment = imageAttachment(meta.attachment)
  if (attachment === undefined) return undefined
  return {
    attachment,
    prompt: stringValue(meta.prompt, 'Generated Image'),
    provider: stringValue(meta.provider, 'google'),
    model: stringValue(meta.model, ''),
    output: stringValue(meta.output, ''),
    ...(typeof meta.savedTo === 'string' ? { savedTo: meta.savedTo } : {}),
  }
}

function eventTurn(event: EventLike): number | undefined {
  const turn = event.data.turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined
}

function imageAttachment(value: unknown): ImageAttachmentRef | undefined {
  const candidate = record(value)
  if (candidate === undefined
    || typeof candidate.attachmentId !== 'string'
    || !isImageMediaType(candidate.mediaType)
    || !positiveInteger(candidate.bytes)
    || !positiveInteger(candidate.width)
    || !positiveInteger(candidate.height)) return undefined
  const original = record(candidate.originalDimensions)
  if (candidate.originalDimensions !== undefined
    && (original === undefined || !positiveInteger(original.width) || !positiveInteger(original.height))) return undefined
  return {
    attachmentId: candidate.attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: candidate.mediaType,
    bytes: candidate.bytes,
    width: candidate.width,
    height: candidate.height,
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(original === undefined ? {} : { originalDimensions: { width: original.width as number, height: original.height as number } }),
  }
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
