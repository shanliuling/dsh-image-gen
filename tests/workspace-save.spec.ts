import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveImageToWorkspace, workspaceImageDir, workspaceImageName } from '../src/workspace-save.js'

const FIXED_DATE = new Date(Date.UTC(2026, 0, 15, 8, 4, 9))
const isWin = process.platform === 'win32'
const root = isWin ? 'H:\\ws' : '/ws'
const foreignAbs = isWin ? 'C:\\other' : '/etc'
const parentTraversal = isWin ? '..\\escape' : '../escape'

describe('workspaceImageName', () => {
  it('builds a UTC-stamped, digest-suffixed name per media type', () => {
    expect(workspaceImageName('sha256:0123456789abcdef', 'image/png', FIXED_DATE)).toBe('image-20260115-080409-01234567.png')
    expect(workspaceImageName('sha256:0123456789abcdef', 'image/jpeg', FIXED_DATE)).toBe('image-20260115-080409-01234567.jpg')
    expect(workspaceImageName('sha256:0123456789abcdef', 'image/webp', FIXED_DATE)).toBe('image-20260115-080409-01234567.webp')
    expect(workspaceImageName('sha256:0123456789abcdef', 'image/gif', FIXED_DATE)).toBe('image-20260115-080409-01234567.gif')
  })

  it('accepts bare digests and pads short digests to eight chars', () => {
    expect(workspaceImageName('abcdef', 'image/png', FIXED_DATE)).toBe('image-20260115-080409-abcdef00.png')
    expect(workspaceImageName('abc', 'image/png', FIXED_DATE)).toBe('image-20260115-080409-abc00000.png')
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

  it('honours an already-aborted signal without writing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'))
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(saveImageToWorkspace({ workspaceRoot: base, folder: undefined, attachmentId: 'sha256:bbbb2222', mediaType: 'image/png', data: new Uint8Array([9]), signal: controller.signal })).rejects.toThrow()
    } finally { await rm(base, { recursive: true, force: true }) }
  })
})
