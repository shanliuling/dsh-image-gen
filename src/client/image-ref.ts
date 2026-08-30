/** Dual-path image attachment resolution for legacy rc.2 and modern DSH runtime blocks. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Extract the verified durable image attachment from a completed tool result block.
 * Supports legacy rc.2 `resultView.content` and modern DSH `block.content`.
 */
export function imageRef(block: ToolCallBlock): ImageAttachmentRef | undefined {
  if (!('kind' in block)) return undefined
  const fromResultView = block.resultView?.card === 'generic'
    ? block.resultView.content?.find(item => item.type === 'image')
    : undefined
  if (fromResultView?.type === 'image') return fromResultView.attachment

  const fromBlockContent = Array.isArray(block.content)
    ? block.content.find(item => item.type === 'image')
    : undefined
  if (fromBlockContent?.type === 'image') return fromBlockContent.attachment

  return undefined
}
