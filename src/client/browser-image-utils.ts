/**
 * Shared browser image and DOM helpers for client views.
 * Completely decoupled from gallery-view and studio-view to prevent circular dependencies.
 */

/** Copy an image Blob to the OS clipboard, converting to PNG if required by the browser. */
export async function copyImageBlob(blob: Blob): Promise<boolean> {
  try {
    if (blob.type === 'image/png') {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ])
      return true
    }

    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        ctx.drawImage(bitmap, 0, 0)
        const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!pngBlob) return false
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob }),
        ])
        return true
      } finally {
        bitmap.close()
      }
    }

    const img = new Image()
    const url = URL.createObjectURL(blob)
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Image decode failed'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      ctx.drawImage(img, 0, 0)
      const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!pngBlob) return false
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob }),
      ])
      return true
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    return false
  }
}

/** Safely trigger a browser file download by mounting an anchor element into the DOM. */
export function downloadBlobUrl(url: string, filename: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    document.body.removeChild(link)
  }
}

/** Human-readable relative time formatter supporting zh and en. */
export function formatRelativeTime(timestamp: number, lang: 'zh' | 'en'): string {
  const diff = Math.max(0, Date.now() - timestamp)
  if (lang === 'zh') {
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
    const d = new Date(timestamp)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  }
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const d = new Date(timestamp)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
