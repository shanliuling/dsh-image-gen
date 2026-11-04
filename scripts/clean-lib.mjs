import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve from this script, not from the caller's cwd. lib/ is generated
// output and must never resolve inside an unrelated working directory.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(repoRoot, 'lib')
if (dirname(target) !== repoRoot) throw new Error('refusing to clean unexpected path: ' + target)
await rm(target, { recursive: true, force: true })
