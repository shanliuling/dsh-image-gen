import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it.each([
  { baseURI: undefined, prefix: '' },
  { baseURI: 'https://dsh.example/', prefix: '' },
  { baseURI: 'https://dsh.example/dsh/', prefix: '/dsh' },
])('resolves image routes at the document base $baseURI', async ({ baseURI, prefix }) => {
  if (baseURI) vi.stubGlobal('document', { baseURI })

  const { IMAGE_ROUTE, STUDIO_ROUTE, ZIP_PROGRESS_ROUTE } = await import('../src/shared.js')
  expect(IMAGE_ROUTE).toBe(prefix + '/plugins/dsh-image-gen/image')
  expect(STUDIO_ROUTE).toBe(prefix + '/plugins/dsh-image-gen/studio')
  expect(ZIP_PROGRESS_ROUTE).toBe(prefix + '/plugins/dsh-image-gen/zip/progress')
})
