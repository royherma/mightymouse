#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const __dirname = dirname(fileURLToPath(import.meta.url))
const addonDir = join(__dirname, '..', 'native', 'passkeys')
const electronVersion = JSON.parse(execSync('node -p "JSON.stringify(require(\'electron/package.json\').version)"').toString())

const PY_CANDIDATES = [
  '/opt/homebrew/opt/python@3.12/bin/python3.12',
  '/opt/homebrew/opt/python@3.10/bin/python3.10',
  '/usr/bin/python3'
]
let python = ''
for (const p of PY_CANDIDATES) {
  if (!existsSync(p)) continue
  try {
    execSync(`${p} -c "import plistlib"`, { stdio: 'ignore' })
    python = p
    break
  } catch {
    // broken interpreter — try the next one
  }
}

const env = { ...process.env }
if (python) {
  env.npm_config_python = python
  env.PYTHON = python
}

const nodeGyp = join(__dirname, '..', 'node_modules', '.bin', 'node-gyp')
const cmd = `${nodeGyp} rebuild --target=${electronVersion} --arch=${process.arch} --dist-url=https://electronjs.org/headers`
console.log(`[build-passkeys-addon] ${cmd}`)
try {
  execSync(cmd, { cwd: addonDir, stdio: 'inherit', env })
} catch (e) {
  console.error('[build-passkeys-addon] WARNING: build failed — passkeys fall back to page defaults')
  process.exit(0)
}

const unresolved = execSync(`nm -m "${join(addonDir, 'build', 'Release', 'passkeys.node')}"`)
  .toString()
  .split('\n')
  .filter((l) => l.includes('dynamically looked up') && !/ _(napi|node_api)_/.test(l))
if (unresolved.length) {
  console.error(`[build-passkeys-addon] unresolved symbols resolve to NULL at call time and crash the app:\n${unresolved.join('\n')}`)
  process.exit(1)
}
