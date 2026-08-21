/** Persist one generated image as a file under the session workspace. */
import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** File extension for each supported image media type. */
const EXTENSION: Record<ImageAttachmentRef['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * Build one human-readable, collision-resistant file name for a generated
 * image: `image-YYYYMMDD-HHMMSS-<digest-prefix>.<ext>` using UTC. The digest
 * prefix is the content-addressed attachment id, so the same image bytes
 * always map to the same file name.
 * @param attachmentId - durable attachment id (`sha256:<hex>`).
 * @param mediaType - verified image media type.
 * @param now - clock for the stamp; injectable for tests.
 * @returns the file name (no directory).
 */
export function workspaceImageName(
  attachmentId: string,
  mediaType: ImageAttachmentRef['mediaType'],
  now: Date = new Date(),
): string {
  const digest = attachmentId.startsWith('sha256:') ? attachmentId.slice('sha256:'.length) : attachmentId
  const prefix = digest.slice(0, 8).padEnd(8, '0')
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `image-${stamp}-${prefix}.${EXTENSION[mediaType]}`
}

/**
 * Resolve the configured image folder inside the session workspace. The
 * folder may nest, but must stay inside the workspace: absolute paths and
 * parent-traversal segments are rejected for both separator styles.
 * @param workspaceRoot - the session workspace directory.
 * @param folder - configured subfolder; empty/blank means the workspace root.
 * @returns the absolute image directory.
 * @throws when the folder would escape the workspace root.
 */
export function workspaceImageDir(workspaceRoot: string, folder: string | undefined): string {
  const trimmed = (folder ?? '').trim()
  const root = resolve(workspaceRoot)
  // An absolute folder resolves to itself and is rejected by the containment check below.
  const dir = trimmed === '' ? root : resolve(root, trimmed)
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`image workspace folder '${folder}' must stay inside the session workspace`)
  }
  return dir
}

/**
 * Write one generated image durably under the session workspace.
 *
 * The bytes are written to a same-directory staging file and renamed onto the
 * target, so a crash never leaves a half-written image under its final name.
 * Re-saving identical bytes rewrites the same file (the name is content-
 * addressed), which keeps repeated generations idempotent.
 * @param options - workspace root, configured folder, attachment identity, and image bytes.
 * @returns the absolute path of the written file.
 */
export async function saveImageToWorkspace(options: {
  workspaceRoot: string
  folder?: string | undefined
  attachmentId: string
  mediaType: ImageAttachmentRef['mediaType']
  data: Uint8Array
  signal?: AbortSignal
}): Promise<string> {
  const dir = workspaceImageDir(options.workspaceRoot, options.folder)
  const name = workspaceImageName(options.attachmentId, options.mediaType)
  const target = join(dir, name)
  const staging = join(dir, `.${name}.${process.pid}-${randomUUID()}.tmp`)
  await mkdir(dir, { recursive: true })
  options.signal?.throwIfAborted()
  try {
    await writeFile(staging, options.data, { flag: 'wx' })
    options.signal?.throwIfAborted()
    await rename(staging, target)
  } catch (error) {
    await unlink(staging).catch(() => {})
    throw error
  }
  return target
}
