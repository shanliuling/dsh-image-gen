import { describe, expect, it } from 'vitest'
import { shouldShowBatchBar, type BatchBarTab } from '../src/client/gallery-batch-bar.js'

const tabs: BatchBarTab[] = ['gallery', 'favorites', 'studio', 'inspiration']

describe('shouldShowBatchBar', () => {
  it('shows on the grid tabs when manage mode is on', () => {
    expect(shouldShowBatchBar('gallery', true, 0)).toBe(true)
    expect(shouldShowBatchBar('favorites', true, 0)).toBe(true)
  })

  it('shows on the grid tabs when items are selected', () => {
    expect(shouldShowBatchBar('gallery', false, 3)).toBe(true)
    expect(shouldShowBatchBar('favorites', false, 1)).toBe(true)
  })

  it('never shows on the workbench or inspiration tabs', () => {
    for (const tab of tabs) {
      if (tab === 'gallery' || tab === 'favorites') continue
      expect(shouldShowBatchBar(tab, true, 5)).toBe(false)
      expect(shouldShowBatchBar(tab, false, 0)).toBe(false)
    }
  })

  it('hides on the grid tabs when idle', () => {
    expect(shouldShowBatchBar('gallery', false, 0)).toBe(false)
    expect(shouldShowBatchBar('favorites', false, 0)).toBe(false)
  })
})
