import { execFile } from 'child_process'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MightyProject } from '../../shared/types'
import { mightyProjectForCwd } from '../../shared/relay-sessions'
import { devLog } from '../../shared/env'
import { MIGHTY } from '../store/mighty'
import type { RelayRequestParams } from './store'

const AVATAR_PX = 128

const CACHE = new Map<string, Buffer>()
const INFLIGHT = new Map<string, Promise<Buffer | undefined>>()

export function relayProject(params: RelayRequestParams | undefined): MightyProject | null {
  const open = MIGHTY.listProjects().filter((p) => !p.archived)
  return mightyProjectForCwd(params?.cwd, open)
}

export async function projectAvatarPng(project: MightyProject): Promise<Buffer | undefined> {
  const src = project.imagePath
  if (!src) return undefined
  const mtime = await stat(src).then((s) => s.mtimeMs).catch(() => undefined)
  if (mtime === undefined) return undefined
  const key = `${src}:${mtime}`
  const cached = CACHE.get(key)
  if (cached) return cached
  const running = INFLIGHT.get(key)
  if (running) return running
  const job = render(src, key).finally(() => INFLIGHT.delete(key))
  INFLIGHT.set(key, job)
  return job
}

// sips, not nativeImage: nativeImage returns an empty image for SVG, and project pictures are often SVG favicons.
async function render(src: string, key: string): Promise<Buffer | undefined> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'mm-project-avatar-'))
    const out = join(dir, 'avatar.png')
    await sips(['-s', 'format', 'png', '-Z', String(AVATAR_PX), src, '--out', out])
    const png = await readFile(out)
    CACHE.set(key, png)
    return png
  } catch (err) {
    devLog.warn('[agent-relay] project avatar render failed', {
      src,
      message: err instanceof Error ? err.message : String(err)
    })
    return undefined
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function sips(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sips', args, (err) => (err ? reject(err) : resolve()))
  })
}
