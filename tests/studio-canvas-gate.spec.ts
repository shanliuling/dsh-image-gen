import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StudioCanvasGate, studioCanvasLicenseState } from '../src/client/tl/studio-canvas-gate.js'

function render(state: 'loading' | 'unconfigured' | 'configured' | 'failed'): string {
  return renderToStaticMarkup(createElement(
    StudioCanvasGate,
    { state, loadingLabel: 'Loading canvas…' },
    createElement('span', { id: 'editor' }, 'editor'),
  ))
}

describe('studio canvas license gate', () => {
  it('keeps tldraw unmounted while the first config read is pending', () => {
    expect(studioCanvasLicenseState(null, true)).toBe('loading')
    const html = render('loading')
    expect(html).toContain('Loading canvas…')
    expect(html).not.toContain('id="editor"')
  })

  it('distinguishes loaded without a key from a configured key', () => {
    expect(studioCanvasLicenseState({ tldrawLicenseKey: '' }, false)).toBe('unconfigured')
    expect(studioCanvasLicenseState({ tldrawLicenseKey: '  ' }, false)).toBe('unconfigured')
    expect(studioCanvasLicenseState({ tldrawLicenseKey: ' tldraw-abc123 ' }, false)).toBe('configured')
  })

  it.each(['unconfigured', 'configured'] as const)('mounts the editor once the config read succeeds (%s)', state => {
    expect(render(state)).toContain('id="editor"')
  })

  it('opens the editor after a failed read instead of leaving it loading forever', () => {
    expect(studioCanvasLicenseState(null, false)).toBe('failed')
    const html = render('failed')
    expect(html).toContain('id="editor"')
    expect(html).not.toContain('Loading canvas…')
  })
})