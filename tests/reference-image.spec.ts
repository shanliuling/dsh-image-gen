import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Message } from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  findReferenceImage,
  findReferenceImages,
  parseImageAttachmentRef,
  resolveReferenceImage,
  resolveReferenceImages,
} from '../src/reference-image.js'

const signal = new AbortController().signal

function imageRef(id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png'): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes: 12,
    width: 32,
    height: 24,
    name: `${id}.png`,
  }
}

function messages(content: unknown[]): Message[] {
  return [{ role: 'assistant', content }] as unknown as Message[]
}

function sourcedMessage(content: unknown[], source: { kind: 'user' } | { kind: 'tool'; callId: string }): Message {
  return { id: 'message-id', role: 'user', content, source } as unknown as Message
}

describe('reference image compatibility boundary', () => {
  it('finds the newest image recursively inside tool-result content', () => {
    const older = imageRef('older')
    const newest = imageRef('newest')
    const history = [
      ...messages([{ type: 'image', attachment: older }]),
      ...messages([{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [
          { type: 'text', text: 'edited image' },
          { type: 'image', attachment: newest },
        ],
      }]),
    ]

    expect(findReferenceImage(history)).toBe(newest)
  })

  it('honors an explicit attachment id from an earlier effective message', () => {
    const selected = imageRef('selected')
    const newest = imageRef('newest')
    const history = [
      ...messages([{ type: 'image', attachment: selected }]),
      ...messages([{ type: 'image', attachment: newest }]),
    ]

    expect(findReferenceImage(history, 'selected')).toBe(selected)
  })

  it('collects every image from the newest image-bearing message in block order', () => {
    const older = imageRef('older')
    const first = imageRef('first')
    const second = imageRef('second')
    const history = [
      ...messages([{ type: 'image', attachment: older }]),
      ...messages([
        { type: 'image', attachment: first },
        { type: 'text', text: 'combine these' },
        { type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'image', attachment: second }] },
      ]),
    ]

    expect(findReferenceImages(history)).toEqual([first, second])
  })

  it('resolves explicit attachment ids in caller order', async () => {
    const first = imageRef('first', 'image/jpeg')
    const second = imageRef('second', 'image/webp')
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({
      ref,
      data: new Uint8Array([String(ref.attachmentId) === 'second' ? 2 : 1]),
    }))

    await expect(resolveReferenceImages({
      agent: { session: { deriveMessages: () => messages([
        { type: 'image', attachment: first },
        { type: 'image', attachment: second },
      ]) } },
      attachments: { readImage },
      sourceAttachmentIds: ['second', 'first'],
      signal,
    })).resolves.toEqual([
      { data: new Uint8Array([2]), mediaType: 'image/webp' },
      { data: new Uint8Array([1]), mediaType: 'image/jpeg' },
    ])
    expect(readImage.mock.calls.map(([ref]) => String(ref.attachmentId))).toEqual(['second', 'first'])
  })

  it('accepts a redundant singular attachment selector already included in the plural selector', async () => {
    const firstDigest = '4b859c853c4fdcdd236b54c846000fa6d049d1315e901035c127991c14836640'
    const secondDigest = 'dd68082c844d269797d231f5acb2137075d89ba908966af8d5d4e9fd34b4eefc'
    const first = imageRef(`sha256:${firstDigest}`)
    const second = imageRef(`sha256:${secondDigest}`)
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: new Uint8Array([1]) }))

    await expect(resolveReferenceImages({
      agent: { session: { deriveMessages: () => messages([
        { type: 'image', attachment: first },
        { type: 'image', attachment: second },
      ]) } },
      attachments: { readImage },
      sourceAttachmentId: firstDigest,
      sourceAttachmentIds: [firstDigest, secondDigest],
      signal,
    })).resolves.toHaveLength(2)
    expect(readImage.mock.calls.map(([ref]) => String(ref.attachmentId)))
      .toEqual([`sha256:${firstDigest}`, `sha256:${secondDigest}`])
  })

  it('matches a bare SHA-256 digest to the canonical DSH attachment id', () => {
    const digest = '4b859c853c4fdcdd236b54c846000fa6d049d1315e901035c127991c14836640'
    const ref = imageRef(`sha256:${digest}`)

    expect(findReferenceImages(messages([{ type: 'image', attachment: ref }]), [digest]))
      .toEqual([ref])
    expect(findReferenceImages(messages([{ type: 'image', attachment: ref }]), ['4b859c85']))
      .toEqual([])
  })

  it('prefers images in the latest human message over later tool-read images', () => {
    const cat = imageRef('cat')
    const person = imageRef('person')
    const unrelatedWorkspaceImage = imageRef('workspace-image')
    const history = [
      sourcedMessage([
        { type: 'image', attachment: cat },
        { type: 'image', attachment: person },
        { type: 'text', text: 'replace the person with the cat' },
      ], { kind: 'user' }),
      sourcedMessage([{
        type: 'tool-result',
        toolCallId: 'read-call',
        content: [{ type: 'image', attachment: unrelatedWorkspaceImage }],
      }], { kind: 'tool', callId: 'read-call' }),
    ]

    expect(findReferenceImages(history)).toEqual([cat, person])
  })

  it('falls back to the newest generated or tool-read image when the current human message has no image', () => {
    const generated = imageRef('generated')
    const history = [
      sourcedMessage([{
        type: 'tool-result', toolCallId: 'generate-call',
        content: [{ type: 'image', attachment: generated }],
      }], { kind: 'tool', callId: 'generate-call' }),
      sourcedMessage([{ type: 'text', text: 'add sunglasses to the last image' }], { kind: 'user' }),
    ]

    expect(findReferenceImages(history)).toEqual([generated])
  })

  it('derives effective messages and reads the full durable reference', async () => {
    const ref = imageRef('source', 'image/webp')
    const deriveMessages = vi.fn(() => messages([{ type: 'image', attachment: ref }]))
    const readImage = vi.fn(async (received: ImageAttachmentRef) => ({
      ref: received,
      data: new Uint8Array([1, 2, 3]),
    }))

    await expect(resolveReferenceImage({
      agent: { session: { deriveMessages } },
      attachments: { readImage },
      signal,
    })).resolves.toEqual({
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/webp',
    })
    expect(deriveMessages).toHaveBeenCalledOnce()
    expect(readImage).toHaveBeenCalledWith(ref, signal)
  })

  it('automatically resolves all images from the newest image-bearing message', async () => {
    const first = imageRef('first', 'image/png')
    const second = imageRef('second', 'image/jpeg')
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({
      ref,
      data: new Uint8Array([String(ref.attachmentId) === 'first' ? 1 : 2]),
    }))

    await expect(resolveReferenceImages({
      agent: { session: { deriveMessages: () => messages([
        { type: 'image', attachment: first },
        { type: 'image', attachment: second },
      ]) } },
      attachments: { readImage },
      signal,
    })).resolves.toEqual([
      { data: new Uint8Array([1]), mediaType: 'image/png' },
      { data: new Uint8Array([2]), mediaType: 'image/jpeg' },
    ])
  })

  it('fails clearly when the effective conversation has no image', async () => {
    await expect(resolveReferenceImage({
      agent: { session: { deriveMessages: () => messages([{ type: 'text', text: 'no image' }]) } },
      attachments: { readImage: vi.fn() },
      signal,
    })).rejects.toThrow('upload or generate an image first')
  })

  it('validates complete serialized refs including original dimensions', () => {
    expect(parseImageAttachmentRef({
      attachmentId: 'sha256:test',
      mediaType: 'image/jpeg',
      bytes: 20,
      width: 10,
      height: 8,
      name: 'test.jpg',
      originalDimensions: { width: 20, height: 16 },
    })).toMatchObject({
      attachmentId: 'sha256:test',
      mediaType: 'image/jpeg',
      originalDimensions: { width: 20, height: 16 },
    })
    expect(parseImageAttachmentRef({ attachmentId: 'fake' })).toBeUndefined()
  })
  it('reads an explicitly named image from the session workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-image-gen-workspace-'))
    await mkdir(join(workspaceRoot, 'images'))
    await writeFile(join(workspaceRoot, 'images', 'source.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0x00]))
    const deriveMessages = vi.fn(() => messages([{ type: 'image', attachment: imageRef('newest') }]))

    await expect(resolveReferenceImage({
      agent: { session: { deriveMessages, header: { cwd: workspaceRoot } } },
      attachments: { readImage: vi.fn() },
      sourcePath: 'images/source.jpg',
      signal,
    })).resolves.toEqual({
      data: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      mediaType: 'image/jpeg',
    })
    expect(deriveMessages).not.toHaveBeenCalled()
  })

  it('reads multiple workspace images in caller order', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-image-gen-workspace-'))
    await writeFile(join(workspaceRoot, 'first.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))
    await writeFile(join(workspaceRoot, 'second.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 2]))

    await expect(resolveReferenceImages({
      agent: { session: { deriveMessages: () => [], header: { cwd: workspaceRoot } } },
      attachments: { readImage: vi.fn() },
      sourcePaths: ['second.jpg', 'first.png'],
      signal,
    })).resolves.toEqual([
      { data: new Uint8Array([0xff, 0xd8, 0xff, 2]), mediaType: 'image/jpeg' },
      { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), mediaType: 'image/png' },
    ])
  })

  it('accepts a redundant singular workspace path already included in source_paths', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-image-gen-workspace-'))
    await writeFile(join(workspaceRoot, 'first.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await writeFile(join(workspaceRoot, 'second.jpg'), new Uint8Array([0xff, 0xd8, 0xff]))

    await expect(resolveReferenceImages({
      agent: { session: { deriveMessages: () => [], header: { cwd: workspaceRoot } } },
      attachments: { readImage: vi.fn() },
      sourcePath: 'first.png',
      sourcePaths: ['first.png', 'second.jpg'],
      signal,
    })).resolves.toHaveLength(2)
  })

  it('does not fall back to the newest conversation image when source_path is missing', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-image-gen-workspace-'))
    const readImage = vi.fn()

    await expect(resolveReferenceImage({
      agent: { session: { deriveMessages: () => messages([{ type: 'image', attachment: imageRef('newest') }]), header: { cwd: workspaceRoot } } },
      attachments: { readImage },
      sourcePath: 'missing.jpg',
      signal,
    })).rejects.toThrow('could not find workspace image')
    expect(readImage).not.toHaveBeenCalled()
  })

  it('rejects workspace traversal and symlink escapes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-image-gen-parent-'))
    const workspaceRoot = join(parent, 'workspace')
    const outside = join(parent, 'outside')
    await mkdir(workspaceRoot)
    await mkdir(outside)
    await writeFile(join(outside, 'source.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await symlink(outside, join(workspaceRoot, 'linked'), 'junction')
    const base = {
      agent: { session: { deriveMessages: () => [], header: { cwd: workspaceRoot } } },
      attachments: { readImage: vi.fn() },
      signal,
    }

    await expect(resolveReferenceImage({ ...base, sourcePath: '../outside/source.png' }))
      .rejects.toThrow('must stay inside')
    await expect(resolveReferenceImage({ ...base, sourcePath: 'linked/source.png' }))
      .rejects.toThrow('resolves outside')
  })

  it('rejects ambiguous explicit selectors instead of guessing', async () => {
    await expect(resolveReferenceImage({
      attachments: { readImage: vi.fn() },
      sourceAttachmentId: 'source',
      sourcePath: 'source.png',
      signal,
    })).rejects.toThrow('accepts only one of')
  })

  it('rejects conflicting singular and plural selectors of the same kind', async () => {
    await expect(resolveReferenceImages({
      attachments: { readImage: vi.fn() },
      sourceAttachmentId: 'first',
      sourceAttachmentIds: ['second'],
      signal,
    })).rejects.toThrow('source_attachment_id must also appear in source_attachment_ids')
  })

  it('rejects empty or partially missing explicit image lists', async () => {
    const first = imageRef('first')
    const base = {
      agent: { session: { deriveMessages: () => messages([{ type: 'image', attachment: first }]) } },
      attachments: { readImage: vi.fn() },
      signal,
    }

    await expect(resolveReferenceImages({ ...base, sourceAttachmentIds: [] }))
      .rejects.toThrow('must not be empty')
    await expect(resolveReferenceImages({ ...base, sourceAttachmentIds: ['first', 'missing'] }))
      .rejects.toThrow('could not find image attachment missing')
  })
})
