/**
 * Layout rules behind #130. They are plain CSS strings, so these tests pin the
 * rule text itself; the behaviour was reproduced in Chromium with tldraw 5.3.0.
 */
import { describe, expect, it } from 'vitest'
import { PLUGIN_STYLE } from '../src/client/plugin-style.js'
import { STUDIO_STYLE } from '../src/client/studio-style.js'

describe('workbench styles (#130)', () => {
  it('keeps the reduced-motion override off the tldraw canvas', () => {
    // tldraw moves one shared tooltip anchor between buttons; with its
    // transitions flattened the tooltip stayed at stale coordinates, often
    // the window's top-left corner.
    const rule = /@media\(prefers-reduced-motion:reduce\)\{([^{]+)\{/.exec(STUDIO_STYLE)?.[1]
    expect(rule).toBe('.dsh-ig-workbench :not(.dsh-ig-tl-canvas,.dsh-ig-tl-canvas *)')
  })

  it('never wraps a canvas toolbar label, and hides labels in a compact column', () => {
    expect(STUDIO_STYLE).toContain('.dsh-ig-canvas-toolbar button,.dsh-ig-status-badge{white-space:nowrap;flex-shrink:0}')
    expect(STUDIO_STYLE).toContain('.dsh-ig-canvas-toolbar.is-compact button>span')
  })

  it('lets the gallery toolbar wrap instead of overlapping', () => {
    expect(PLUGIN_STYLE).toMatch(/\.dsh-ig-studio-toolbar\{[^}]*flex-wrap:wrap/)
    expect(PLUGIN_STYLE).toMatch(/\.dsh-ig-studio-toolbar-left\{[^}]*flex-wrap:wrap/)
  })
})
