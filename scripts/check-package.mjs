/** Install the actual tarball away from the source tree and verify published DSH settings. */
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '>=3.18.4 <4')
assert.ok(existsSync(join(root, 'lib', 'index.js')), 'Run the build before test:package')
assert.ok(existsSync(join(root, 'lib', 'client.js')), 'Run the build before test:package')
const npm = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(existsSync)
assert.ok(npm, 'npm must be installed with Node for the isolated package check')
const temporaryRoot = realpathSync(tmpdir())
const home = realpathSync(await mkdtemp(join(temporaryRoot, 'dsh-image-gen-package-')))
assert.equal(dirname(home), temporaryRoot)
assert.ok(basename(home).startsWith('dsh-image-gen-package-'))

try {
  console.log('Packing the current plugin build for an independent installation...')
  const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', home], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
  }))
  const tarball = join(home, packed[0].filename)
  await writeFile(join(home, 'package.json'), JSON.stringify({
    name: 'image-gen-package-verification', private: true, type: 'module', dependencies: {
      'dsh-image-gen': `file:${tarball.replaceAll('\\', '/')}`,
      '@deepseek-ai/cordis': '4.0.4',
      '@deepseek-ai/schemastery': '3.18.4',
      '@deepseek-ai/dsh-app-boot': '0.2.0-rc.2',
      '@deepseek-ai/dsh-config-editor': '0.2.0-rc.2',
      '@deepseek-ai/dsh-settings': '0.2.0-rc.2',
      'schemastery-legacy': 'npm:@deepseek-ai/schemastery@3.18.2',
      react: '18.3.1',
      'react-test-renderer': '18.3.1',
    },
  }, null, 2))
  console.log('Installing the tarball with published DSH 0.2.0-rc.2 services...')
  execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: home, stdio: 'inherit', timeout: 180_000,
  })
  assert.ok(!realpathSync(join(home, 'node_modules', 'dsh-image-gen')).startsWith(root), 'The installed plugin must not link to the source checkout')
  await copyFile(join(root, 'scripts', 'fixtures', 'package-settings.mjs'), join(home, 'verify.mjs'))
  for (const version of ['3.18.4', '3.18.2']) {
    execFileSync(process.execPath, [join(home, 'verify.mjs'), version], { cwd: home, stdio: 'inherit', timeout: 60_000 })
  }
} finally {
  // home is a direct mkdtemp result; only this test's installation is removed.
  await rm(home, { recursive: true, force: true })
}
