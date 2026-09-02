import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CloudImageProvider } from '../shared.js'

/** One regenerated version displayed in place of an original conversation image. */
export interface ConversationImageRevision {
  attachment: ImageAttachmentRef
  prompt: string
  provider: CloudImageProvider
  model: string
  output: string
  createdAt: number
  ratio: string
  quality: string
}

export interface ConversationImageRevisionChain {
  originId: string
  /** Zero selects the immutable conversation image; revisions use one-based positions. */
  currentIndex: number
  revisions: ConversationImageRevision[]
}

const STORAGE_PREFIX = 'dsh_image_gen_conversation_revisions:'
const MAX_REVISIONS = 20

/** Read the locally persisted replacement history for one immutable conversation image. */
export function loadConversationImageRevisionChain(originId: string): ConversationImageRevisionChain {
  const empty = (): ConversationImageRevisionChain => ({ originId, currentIndex: 0, revisions: [] })
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(originId))
    if (!raw) return empty()
    const value = JSON.parse(raw) as unknown
    if (!isChain(value, originId)) return empty()
    const currentIndex = Math.min(value.currentIndex, value.revisions.length)
    return { originId, currentIndex, revisions: value.revisions }
  } catch {
    return empty()
  }
}

/** Append a generated version and make it the version shown by the conversation card. */
export function appendConversationImageRevision(
  originId: string,
  revision: ConversationImageRevision,
): ConversationImageRevisionChain {
  const current = loadConversationImageRevisionChain(originId)
  const withoutDuplicate = current.revisions.filter(item => item.attachment.attachmentId !== revision.attachment.attachmentId)
  const revisions = [...withoutDuplicate, revision].slice(-MAX_REVISIONS)
  const next = { originId, currentIndex: revisions.length, revisions }
  persist(next)
  return next
}

/** Select an earlier or later version without altering the underlying conversation event. */
export function selectConversationImageRevision(originId: string, requestedIndex: number): ConversationImageRevisionChain {
  const current = loadConversationImageRevisionChain(originId)
  const currentIndex = Math.max(0, Math.min(Math.trunc(requestedIndex), current.revisions.length))
  const next = { ...current, currentIndex }
  persist(next)
  return next
}

function persist(chain: ConversationImageRevisionChain): void {
  try {
    globalThis.localStorage?.setItem(storageKey(chain.originId), JSON.stringify(chain))
  } catch {
    // The generated attachment is still available for this mount when browser storage is unavailable.
  }
}

function storageKey(originId: string): string {
  return `${STORAGE_PREFIX}${originId}`
}

function isChain(value: unknown, originId: string): value is ConversationImageRevisionChain {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<ConversationImageRevisionChain>
  return candidate.originId === originId
    && typeof candidate.currentIndex === 'number'
    && Number.isSafeInteger(candidate.currentIndex)
    && candidate.currentIndex >= 0
    && Array.isArray(candidate.revisions)
    && candidate.revisions.every(isRevision)
}

function isRevision(value: unknown): value is ConversationImageRevision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<ConversationImageRevision>
  return isAttachment(candidate.attachment)
    && (candidate.provider === 'google' || candidate.provider === 'openai' || candidate.provider === 'seedream' || candidate.provider === 'dashscope')
    && typeof candidate.prompt === 'string'
    && typeof candidate.model === 'string'
    && typeof candidate.output === 'string'
    && typeof candidate.createdAt === 'number'
    && Number.isFinite(candidate.createdAt)
    && typeof candidate.ratio === 'string'
    && typeof candidate.quality === 'string'
}

function isAttachment(value: unknown): value is ImageAttachmentRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<ImageAttachmentRef>
  return typeof candidate.attachmentId === 'string'
    && (candidate.mediaType === 'image/png' || candidate.mediaType === 'image/jpeg' || candidate.mediaType === 'image/webp' || candidate.mediaType === 'image/gif')
    && typeof candidate.bytes === 'number'
    && typeof candidate.width === 'number'
    && typeof candidate.height === 'number'
}
