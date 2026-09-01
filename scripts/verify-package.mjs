import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function runPack() {
  const cacheDir = join(tmpdir(), 'npm-cache')
  const raw = execFileSync('npm', ['pack', '--json', '--ignore-scripts', `--cache=${cacheDir}`], { encoding: 'utf8' })
  const pack = JSON.parse(raw)
  return pack.filename ?? pack[0]?.filename ?? Object.values(pack)[0]?.filename
}

const tarball = runPack()
assert.ok(tarball, 'package pack did not report a tarball')
const dir = mkdtempSync(join(tmpdir(), 'dsh-image-gen-verify-'))
try {
  execFileSync('tar', ['-xzf', tarball, '-C', dir])
  const pkg = JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8'))
  for (const path of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'cordis.patch.yml']) {
    assert.ok(readFileSync(join(dir, 'package', path)).length > 0, 'missing packed artifact: ' + path)
  }
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  console.log('packed plugin contract verified:', tarball)
} finally {
  rmSync(dir, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}
