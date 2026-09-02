import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  deleteImageByAttachmentIdFromWorkspace,
  deleteImageFromWorkspace,
  saveImageToWorkspace,
  workspaceImageDir,
  workspaceImageName,
} from '../src/workspace-save.js'

const isWin = process.platform === 'win32'
const root = isWin ? 'H:\\ws' : '/ws'
const foreignAbs = isWin ? 'C:\\other' : '/etc'
const parentTraversal = isWin ? '..\\escape' : '../escape'

// Route every rename through a hook queue so tests can land an abort exactly
// during the final rename step of a save.
const renameHooks = vi.hoisted(() => ({ queue: [] as Array<() => void> }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: [oldPath: string, newPath: string]) => {
      for (const hook of renameHooks.queue.splice(0)) hook()
      return actual.rename(...args)
    },
  }
})

describe('workspaceImageName', () => {
  it('derives a stable digest-suffixed name per media type', () => {
    expect(workspaceImageName('sha256:0123456789abcdef', 'image/png')).toBe('image-01234567.png')
    expect(workspaceImageName('sha256:0123456789abcdef', 'image/jpeg')).toBe('image-01234567.jpg')
    expect(workspaceImageName('sha256:0123456789abcdef', 'image/webp')).toBe('image-01234567.webp')
    expect(workspaceImageName('sha256:0123456789abcdef', 'image/gif')).toBe('image-01234567.gif')
  })

  it('accepts bare digests and pads short digests to eight chars', () => {
    expect(workspaceImageName('abcdef', 'image/png')).toBe('image-abcdef00.png')
    expect(workspaceImageName('abc', 'image/png')).toBe('image-abc00000.png')
  })
})

describe('workspaceImageDir', () => {
  it('defaults to the workspace root and keeps nested folders inside it', () => {
    expect(workspaceImageDir(root, undefined)).toBe(root)
    expect(workspaceImageDir(root, '')).toBe(root)
    expect(workspaceImageDir(root, 'a/b')).toBe(resolve(root, 'a/b'))
    expect(workspaceImageDir(root, '  dsh-image-gen  ')).toBe(resolve(root, 'dsh-image-gen'))
  })

  it('rejects folders that escape the workspace', () => {
    expect(() => workspaceImageDir(root, parentTraversal)).toThrow(/must stay inside/)
    expect(() => workspaceImageDir(root, 'a/../../escape')).toThrow(/must stay inside/)
    expect(() => workspaceImageDir(root, foreignAbs)).toThrow(/must stay inside/)
  })
})

describe('saveImageToWorkspace', () => {
  it('writes the image bytes under the configured folder', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    try {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      const saved = await saveImageToWorkspace({ workspaceRoot: base, folder: 'nested/deep', attachmentId: 'sha256:0123456789abcdef', mediaType: 'image/png', data: bytes })
      expect(saved.startsWith(base)).toBe(true)
      expect(saved.endsWith('.png')).toBe(true)
      expect(new Uint8Array(await readFile(saved))).toEqual(bytes)
      expect((await stat(saved)).isFile()).toBe(true)
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('writes into the workspace root when the folder is empty', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    try {
      const saved = await saveImageToWorkspace({ workspaceRoot: base, folder: '', attachmentId: 'sha256:fedcba9876543210', mediaType: 'image/jpeg', data: new Uint8Array([1]) })
      expect(saved.startsWith(base)).toBe(true)
      expect(saved.endsWith('.jpg')).toBe(true)
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('overwrites the same content-addressed file instead of duplicating it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    try {
      const bytes = new Uint8Array([1, 2, 3])
      const first = await saveImageToWorkspace({ workspaceRoot: base, folder: undefined, attachmentId: 'sha256:aaaa1111', mediaType: 'image/webp', data: bytes, signal: new AbortController().signal })
      const second = await saveImageToWorkspace({ workspaceRoot: base, folder: undefined, attachmentId: 'sha256:aaaa1111', mediaType: 'image/webp', data: bytes, signal: new AbortController().signal })
      expect(second).toBe(first)
      expect(new Uint8Array(await readFile(first))).toEqual(bytes)
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('honours an already-aborted signal without touching the disk', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(saveImageToWorkspace({ workspaceRoot: base, folder: undefined, attachmentId: 'sha256:bbbb2222', mediaType: 'image/png', data: new Uint8Array([9]), signal: controller.signal })).rejects.toThrow()
      expect(await readdir(base)).toEqual([])
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('rejects a configured folder that symlinks outside the workspace', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-image-gen-out-'))
    try {
      await symlink(outside, join(base, 'escape'), isWin ? 'junction' : 'dir')
      await expect(saveImageToWorkspace({ workspaceRoot: base, folder: 'escape', attachmentId: 'sha256:cccc3333', mediaType: 'image/png', data: new Uint8Array([7]) })).rejects.toThrow(/must stay inside/)
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(base, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects an escaping symlink on an intermediate folder segment', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-image-gen-out-'))
    try {
      await mkdir(join(base, 'sub'))
      await symlink(outside, join(base, 'sub', 'escape'), isWin ? 'junction' : 'dir')
      await expect(saveImageToWorkspace({ workspaceRoot: base, folder: 'sub/escape', attachmentId: 'sha256:dddd4444', mediaType: 'image/png', data: new Uint8Array([7]) })).rejects.toThrow(/must stay inside/)
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(base, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('allows a folder symlink that resolves back inside the workspace', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    try {
      await mkdir(join(base, 'real'))
      await symlink(join(base, 'real'), join(base, 'link'), isWin ? 'junction' : 'dir')
      const saved = await saveImageToWorkspace({ workspaceRoot: base, folder: 'link', attachmentId: 'sha256:eeee5555', mediaType: 'image/png', data: new Uint8Array([5]) })
      expect(saved.startsWith(resolve(base, 'link'))).toBe(true)
      expect(new Uint8Array(await readFile(saved))).toEqual(new Uint8Array([5]))
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('does not report success when cancelled during the final rename', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    try {
      const controller = new AbortController()
      renameHooks.queue.push(() => controller.abort())
      await expect(saveImageToWorkspace({ workspaceRoot: base, folder: undefined, attachmentId: 'sha256:ffff6666', mediaType: 'image/png', data: new Uint8Array([3]), signal: controller.signal })).rejects.toThrow()
      // Neither the renamed image nor staging leftovers survive the cancel.
      expect(await readdir(base)).toEqual([])
    } finally { await rm(base, { recursive: true, force: true }) }
  })
})

describe('deleteImageFromWorkspace', () => {
  it('deletes an existing generated image file', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-del-'))
    try {
      const saved = await saveImageToWorkspace({
        workspaceRoot: base,
        folder: 'test-folder',
        attachmentId: 'sha256:1122334455667788',
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
      })
      expect((await stat(saved)).isFile()).toBe(true)

      const ok = await deleteImageFromWorkspace(saved, [base])
      expect(ok).toBe(true)
      await expect(stat(saved)).rejects.toThrow()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('rejects deleting files that do not conform to generated image name pattern', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-del-'))
    try {
      const customFile = join(base, 'important-document.txt')
      const ok = await deleteImageFromWorkspace(customFile, [base])
      expect(ok).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('rejects deleting files outside allowed workspace roots', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-del-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-image-gen-other-'))
    try {
      const saved = await saveImageToWorkspace({
        workspaceRoot: outside,
        folder: '',
        attachmentId: 'sha256:aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011',
        mediaType: 'image/png',
        data: new Uint8Array([1]),
      })
      const ok = await deleteImageFromWorkspace(saved, [base])
      expect(ok).toBe(false)
      expect((await stat(saved)).isFile()).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects deleting a file if it is a symbolic link', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-sym-'))
    try {
      const target = join(base, 'secret.txt')
      await writeFile(target, 'important')
      const symlinkPath = join(base, 'image-12345678.png')
      try {
        await symlink(target, symlinkPath, 'file')
      } catch {
        return // Skip in environments lacking symlink creation permission
      }
      const ok = await deleteImageFromWorkspace(symlinkPath, [base])
      expect(ok).toBe(false)
      expect(await readFile(target, 'utf8')).toBe('important')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('rejects short or invalid sha256 attachment ids in fallback deletion', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-del-'))
    try {
      expect(await deleteImageByAttachmentIdFromWorkspace('a', { allowedWorkspaceRoots: [base] })).toBe(false)
      expect(await deleteImageByAttachmentIdFromWorkspace('sha256:123', { allowedWorkspaceRoots: [base] })).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('finds and deletes a file by attachmentId across candidate directories', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-del-'))
    try {
      const saved = await saveImageToWorkspace({
        workspaceRoot: base,
        folder: 'dsh-image-gen',
        attachmentId: 'sha256:12345678abcdef0112345678abcdef0112345678abcdef0112345678abcdef01',
        mediaType: 'image/png',
        data: new Uint8Array([9, 8, 7]),
      })
      expect((await stat(saved)).isFile()).toBe(true)

      const ok = await deleteImageByAttachmentIdFromWorkspace('sha256:12345678abcdef0112345678abcdef0112345678abcdef0112345678abcdef01', {
        folder: 'dsh-image-gen',
        allowedWorkspaceRoots: [base],
      })
      expect(ok).toBe(true)
      await expect(stat(saved)).rejects.toThrow()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('returns false when no matching file exists on disk in fallback deletion', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-del-'))
    try {
      const ok = await deleteImageByAttachmentIdFromWorkspace('sha256:00000000abcdef0112345678abcdef0112345678abcdef0112345678abcdef01', {
        folder: 'dsh-image-gen',
        allowedWorkspaceRoots: [base],
      })
      expect(ok).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('workspace scoping and isolation for gallery items', () => {
  const dummyAttachment = {
    attachmentId: 'sha256:12345678abcdef01',
    mediaType: 'image/png' as const,
    bytes: 100,
    width: 512,
    height: 512,
  }

  it('matches item by exact workspaceId', async () => {
    const { isItemInWorkspace } = await import('../src/client/gallery-store.js')
    const item = {
      id: 'item-1',
      attachment: dummyAttachment,
      prompt: 'test',
      provider: 'google' as const,
      model: 'imagen',
      createdAt: Date.now(),
      workspaceId: 'ws-standalone',
    }
    expect(isItemInWorkspace(item, { workspaceId: 'ws-standalone' })).toBe(true)
    expect(isItemInWorkspace(item, { workspaceId: 'ws-skills-sync' })).toBe(false)
  })

  it('matches item by sessionId in workspace sessionIds list', async () => {
    const { isItemInWorkspace } = await import('../src/client/gallery-store.js')
    const item = {
      id: 'item-2',
      attachment: dummyAttachment,
      prompt: 'test',
      provider: 'google' as const,
      model: 'imagen',
      createdAt: Date.now(),
      sessionId: 'sess-abc',
    }
    expect(isItemInWorkspace(item, { sessionIds: ['sess-1', 'sess-abc', 'sess-2'] })).toBe(true)
    expect(isItemInWorkspace(item, { sessionIds: ['sess-other'] })).toBe(false)
  })

  it('matches item by workspacePath with path normalization', async () => {
    const { isItemInWorkspace, normalizeWorkspacePath } = await import('../src/client/gallery-store.js')
    expect(normalizeWorkspacePath('D:\\z\\standalone\\')).toBe('d:/z/standalone')
    expect(normalizeWorkspacePath('d:/z/standalone')).toBe('d:/z/standalone')

    const item = {
      id: 'item-3',
      attachment: dummyAttachment,
      prompt: 'test',
      provider: 'google' as const,
      model: 'imagen',
      createdAt: Date.now(),
      workspacePath: 'D:\\z\\standalone',
    }
    expect(isItemInWorkspace(item, { path: 'd:/z/standalone' })).toBe(true)
    expect(isItemInWorkspace(item, { path: 'd:/z/standalone/' })).toBe(true)
    expect(isItemInWorkspace(item, { path: 'D:\\z\\skills-sync' })).toBe(false)
  })

  it('matches item by savedTo file path inside workspace directory', async () => {
    const { isItemInWorkspace } = await import('../src/client/gallery-store.js')
    const item = {
      id: 'item-4',
      attachment: dummyAttachment,
      prompt: 'test',
      provider: 'google' as const,
      model: 'imagen',
      createdAt: Date.now(),
      savedTo: 'D:\\z\\standalone\\dsh-image-gen\\image-123.png',
    }
    expect(isItemInWorkspace(item, { path: 'd:/z/standalone' })).toBe(true)
    expect(isItemInWorkspace(item, { path: 'D:\\z\\other-project' })).toBe(false)
  })

  it('returns true when no workspace filter context is provided', async () => {
    const { isItemInWorkspace } = await import('../src/client/gallery-store.js')
    const item = {
      id: 'item-5',
      attachment: dummyAttachment,
      prompt: 'test',
      provider: 'google' as const,
      model: 'imagen',
      createdAt: Date.now(),
      workspaceId: 'ws-123',
    }
    expect(isItemInWorkspace(item, null)).toBe(true)
    expect(isItemInWorkspace(item, undefined)).toBe(true)
    expect(isItemInWorkspace(item, {})).toBe(true)
  })
})
