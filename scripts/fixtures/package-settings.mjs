/** Real profile/editor/settings integration; UI handlers run without external image APIs. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire, registerHooks } from 'node:module'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'

const home = dirname(fileURLToPath(import.meta.url))
const version = process.argv[2]
const legacy = version === '3.18.2'
const pluginURL = import.meta.resolve('dsh-image-gen')
if (legacy) {
  // Simulate a profile resolving an older schemastery copy. The actual
  // published 3.18.2 is loaded only by the installed plugin; the host stays 0.2.
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery' && context.parentURL === pluginURL) {
      return nextResolve('schemastery-legacy', context)
    }
    return nextResolve(specifier, context)
  } })
}
const plugin = await import('dsh-image-gen')
const profileDir = join(home, `profile-${version}`)
initProfile(profileDir, ['test-settings-bundle'])
const bundle = join(profileDir, 'node_modules', 'test-settings-bundle')
await mkdir(bundle, { recursive: true })
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-settings-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
  { id: 'config-editor', name: 'cordis:editor' },
  { id: 'settings', name: 'cordis:settings' },
  { id: 'image-gen', name: 'cordis:image', config: { provider: 'google', saveToWorkspace: false } },
] }]))
await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
const profile = {
  name: 'test', startedBundles: ['test-settings-bundle'], dir: profileDir,
  patchPath: join(profileDir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
  cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
}
let routes
async function start() {
  routes = new Map()
  return boot('test', join(profileDir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: listener => { listener(); return () => {} } })
    // Only image API dependencies are inert. The Loader, ConfigEditor and
    // Settings services, schema resolution, disk writes and restart are real.
    ctx.provide('tools', { register: () => () => {} })
    ctx.provide('credentials', { resolve: async () => undefined })
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 10_000_000, mediaTypes: ['image/png'] } })
    ctx.provide('webServer', { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } })
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, image: plugin })
  })
}

const require = createRequire(import.meta.url)
const source = await readFile(join(dirname(fileURLToPath(pluginURL)), 'client.js'), 'utf8')
let client
const browser = new EventTarget()
browser.__ModuleLoader__ = { load: ({ factory }) => { client = factory(require) } }
new Function('window', source)(browser)
assert.equal(typeof client.ImageGenerationSettingsCard, 'function', 'The installed browser bundle must export the settings card')

function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  return typeof node === 'object' ? text(node.children) : String(node)
}
async function waitFor(check) {
  const deadline = Date.now() + 10_000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'The actual card save handler did not settle')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }
}
function health() {
  let result
  const route = routes.get('/plugins/dsh-image-gen/settings-health')
  assert.ok(route, 'The installed plugin must register diagnostics')
  route.handler({ method: 'GET' }, { setHeader() {}, end: body => { result = JSON.parse(body) } })
  return result
}
// Exercise real effects and hooks. Only the browser transport is replaced:
// the health response comes from the installed plugin's actual HTTP handler.
globalThis.fetch = async (url, options) => {
  const path = new URL(url, 'http://profile.invalid').pathname
  if (path === '/plugins/dsh-image-gen/subscription-status') {
    return new Response(JSON.stringify({ statuses: {} }))
  }
  assert.equal(path, '/plugins/dsh-image-gen/settings-health', 'The test must not call any image or login API')
  assert.equal(options?.method ?? 'GET', 'GET')
  return new Response(JSON.stringify(health()))
}
const renderers = new Set()
async function card(ctx) {
  let writes = 0
  const read = () => {
    const section = ctx.settings.describe().find(row => row.ns === 'image-gen')
    return { value: section?.value, writable: true, status: section ? 'ready' : 'unavailable', mode: 'host' }
  }
  let snapshot = read()
  const listeners = new Set()
  const props = {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      set: async (field, value) => {
        writes++
        await ctx.settings.mutate('image-gen', [{ op: 'set', path: [field], value }])
        snapshot = read()
        for (const listener of listeners) listener()
        return true
      },
    },
    credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => { throw new Error('This test must not save credentials') } },
    credentialsAvailable: () => true,
    locale: { getSnapshot: () => ({ active: 'en' }) },
  }
  let renderer
  await act(async () => { renderer = create(React.createElement(client.ImageGenerationSettingsCard, props)) })
  renderers.add(renderer)
  await act(async () => { renderer.root.findByProps({ className: 'dsh-ig-head' }).props.onClick() })
  const row = () => renderer.root.findAll(node => node.type === 'div' && node.props.className?.startsWith('dsh-ig-provider-row '))
    .find(node => text(node.findByProps({ className: 'dsh-ig-provider-name' })) === 'OpenAI-compatible (relay)')
  await act(async () => { row().findByProps({ className: 'dsh-ig-provider-head' }).props.onClick() })
  const input = type => row().findAllByType('input').find(element => element.props.type === type)
  const save = async () => { await act(async () => { row().findByType('form').props.onSubmit({ preventDefault() {} }) }) }
  const type = async (kind, value) => { await act(async () => { input(kind).props.onChange({ target: { value } }) }) }
  const close = async () => { await act(async () => { renderer.unmount() }); renderers.delete(renderer) }
  return { render: () => renderer.toJSON(), row, input, save, type, close, writes: () => writes }
}

let ctx
try {
  ctx = await start()
  assert.deepEqual(health(), { settings: 'live', liveSchema: !legacy })
  const form = await card(ctx)
  if (legacy) {
    assert.ok(text(form.render()).includes('3.18.4'), 'The missing capability must have an actionable UI diagnostic')
    assert.equal(form.input('url').props.disabled, true)
    await form.save()
    await waitFor(() => text(form.row()).includes('3.18.4'))
    assert.equal(form.writes(), 0, 'An incompatible card must not attempt settings or credential writes')
    await assert.rejects(ctx.settings.mutate('image-gen', [{ op: 'set', path: ['provider'], value: 'openai' }]), /no volatile fields/)
    console.log('PASS: installed bundle + published schemastery 3.18.2 reports incompatibility and blocks writes')
  } else {
    assert.equal(form.input('url').props.disabled, false)
    await form.type('url', 'https://saved.example/v1')
    await form.type(undefined, 'test-image-model')
    await form.save()
    await waitFor(() => text(form.row()).includes('Saved'))
    assert.ok(form.writes() > 0)
    assert.ok((await readFile(profile.patchPath, 'utf8')).includes('https://saved.example/v1'))
    await form.close()
    const refreshed = await card(ctx)
    assert.equal(refreshed.input('url').props.value, 'https://saved.example/v1')
    assert.equal(refreshed.input(undefined).props.value, 'test-image-model')
    await refreshed.close()
    await ctx.fiber.dispose()
    ctx = await start()
    const restarted = await card(ctx)
    assert.equal(restarted.input('url').props.value, 'https://saved.example/v1')
    assert.equal(restarted.input(undefined).props.value, 'test-image-model')
    console.log('PASS: installed browser save handler + DSH 0.2 profile/editor persists settings across fresh form and host restart')
  }
} finally {
  for (const renderer of renderers) await act(async () => { renderer.unmount() })
  await ctx?.fiber.dispose()
}
// The browser bundle owns process-irrelevant cache timers. The profile has
// been disposed; finish this isolated test worker without waiting for them.
process.exit(0)
