import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { defineConfig, type UserConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  peerDependencies?: Record<string, string>
}
const id = pkg.name
const defaultClientExternals = ['@deepseek-ai/cordis', 'react', 'react/jsx-runtime', 'react-dom']
const clientPeers = new Set([
  ...defaultClientExternals,
  ...Object.keys(pkg.peerDependencies ?? {}).filter(name => name !== '@deepseek-ai/schemastery'),
])
const isClientExternal = (dependency: string): boolean =>
  Array.from(clientPeers).some(peer => dependency === peer || dependency.startsWith(peer + '/'))

const host: UserConfig = {
  name: id,
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: value => isBuiltin(value) || value.startsWith('node:') || value.startsWith('@deepseek-ai/'),
    alwaysBundle: value => !isBuiltin(value) && !value.startsWith('node:') && !value.startsWith('@deepseek-ai/'),
  },
}

const client: UserConfig = {
  name: `${id}/client`,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: dependency => isClientExternal(dependency),
    alwaysBundle: dependency => (isClientExternal(dependency) ? undefined : true),
    onlyBundle: false,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
