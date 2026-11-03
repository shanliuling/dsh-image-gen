import type { GalleryItem } from './gallery-store.js'
import type { DictKey } from './gallery-i18n.js'

export function formatRelativeTime(
  timestamp: number,
  t: (key: DictKey, params?: Record<string, string>) => string
): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) {
    return t('justNow')
  }
  if (diff < 3600_000) {
    const mins = Math.max(1, Math.floor(diff / 60_000))
    return t('minutesAgo', { n: String(mins) })
  }
  if (diff < 86400_000) {
    const hours = Math.floor(diff / 3600_000)
    return t('hoursAgo', { n: String(hours) })
  }
  if (diff < 30 * 86400_000) {
    const days = Math.floor(diff / 86400_000)
    return t('daysAgo', { n: String(days) })
  }
  const d = new Date(timestamp)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** Extract standard aspect ratio for precise filtering */
export function getItemRatio(item: GalleryItem): string {
  // Codex subscription may ignore its requested ratio. Filter these cards by
  // the saved image's dimensions instead of the Studio selection.
  if (item.provider === 'chatgpt-sub' && item.attachment.width && item.attachment.height) {
    const actual = item.attachment.width / item.attachment.height
    for (const [label, value] of [
      ['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16],
      ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3],
    ] as const) {
      if (Math.abs(actual / value - 1) < 0.08) return label
    }
    return 'custom'
  }
  if (item.aspectRatio && item.aspectRatio !== 'custom') {
    return item.aspectRatio
  }
  if (item.output) {
    const ratioMatch = item.output.match(/\b(1:1|16:9|9:16|4:3|3:4|3:2|2:3)\b/)
    if (ratioMatch?.[1]) return ratioMatch[1]

    const dimMatch = item.output.match(/(\d{3,4})\s*[×x*]\s*(\d{3,4})/)
    if (dimMatch?.[1] && dimMatch[2]) {
      const w = parseInt(dimMatch[1], 10)
      const h = parseInt(dimMatch[2], 10)
      if (w === h) return '1:1'
      const approx = w / h
      if (Math.abs(approx - 16 / 9) < 0.05) return '16:9'
      if (Math.abs(approx - 9 / 16) < 0.05) return '9:16'
      if (Math.abs(approx - 4 / 3) < 0.05) return '4:3'
      if (Math.abs(approx - 3 / 4) < 0.05) return '3:4'
      if (Math.abs(approx - 3 / 2) < 0.05) return '3:2'
      if (Math.abs(approx - 2 / 3) < 0.05) return '2:3'
    }
  }
  return '1:1'
}

/** Format aspect ratio or dimensions for card metadata (e.g., 1024×1024 or 16:9) */
export function formatCardMeta(item: GalleryItem): string {
  if (item.output) {
    const dimMatch = item.output.match(/(\d{3,4})\s*[×x*]\s*(\d{3,4})/)
    if (dimMatch?.[1] && dimMatch[2]) {
      return `${dimMatch[1]}×${dimMatch[2]}`
    }
  }
  if (item.aspectRatio && item.aspectRatio !== 'custom') {
    return item.aspectRatio
  }
  if (item.output) {
    const ratioMatch = item.output.match(/\b(1:1|16:9|9:16|4:3|3:4|3:2|2:3)\b/)
    if (ratioMatch?.[1]) return ratioMatch[1]
  }
  if (item.imageSize) {
    return item.imageSize
  }
  return '1:1'
}

