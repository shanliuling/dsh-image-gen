import { rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

// lib/ is generated output. A clean build prevents declarations from removed
// modules from leaking into the published package.
const target = resolve('lib')
if (basename(target) !== 'lib') throw new Error('refusing to clean unexpected path: ' + target)
await rm(target, { recursive: true, force: true })
