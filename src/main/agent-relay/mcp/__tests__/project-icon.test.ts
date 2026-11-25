import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Project = { id: string; name: string; repoFolder?: string; imagePath?: string; imageRemoved?: boolean; updated?: string }

const h = vi.hoisted(() => ({
  projects: [] as Project[],
  upserts: [] as Project[],
  copies: [] as [string, string][],
  discovered: new Map<string, string>(),
  backfilled: 0,
  backfillCalls: 0,
  broadcasts: 0
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: () => h.broadcasts++ } }]
  }
}))
vi.mock('../../../store/mighty', () => ({
  MIGHTY: {
    listProjects: () => h.projects,
    upsertProject: (p: Project) => (h.upserts.push(p), p),
    backfillProjectImages: () => (h.backfillCalls++, h.backfilled)
  }
}))
vi.mock('../../../store/project-image', () => ({
  resolveProjectRepoFolder: (p: Project) => p.repoFolder ?? null,
  discoverProjectImage: (repo: string) => h.discovered.get(repo) ?? null,
  copyProjectImage: (id: string, src: string) => {
    h.copies.push([id, src])
    return /\.(png|jpe?g|webp|ico|svg)$/i.test(src) ? `/images/${id}.png` : null
  }
}))

const { PROJECT_ICON_HANDLERS } = await import('../project-icon')

const run = (args: Record<string, unknown>) => PROJECT_ICON_HANDLERS.set_project_icon.run(args as never, {} as never)
const text = (r: { content: Array<{ text: string }> }): string => r.content[0].text

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mm-project-icon-')))
const dir = (...parts: string[]): string => {
  const p = join(root, ...parts)
  mkdirSync(p, { recursive: true })
  return p
}
const outer = dir('work', 'mono')
const inner = dir('work', 'mono', 'apps', 'web')
const app = dir('work', 'app')
const app2 = dir('work', 'app2')
const icon = join(root, 'icon.png')
const notAnImage = join(root, 'notes.txt')
writeFileSync(icon, 'png')
writeFileSync(notAnImage, 'txt')

beforeEach(() => {
  h.projects = [
    { id: 'p-mono', name: 'Mono', repoFolder: outer },
    { id: 'p-web', name: 'Web App', repoFolder: inner },
    { id: 'p-app', name: 'App', repoFolder: app },
    { id: 'p-none', name: 'No Folder' }
  ]
  h.upserts = []
  h.copies = []
  h.discovered = new Map()
  h.backfilled = 0
  h.backfillCalls = 0
  h.broadcasts = 0
})

describe('set_project_icon with a path', () => {
  it('applies the image to the project the agent is working in and tells the sidebar', async () => {
    const r = await run({ path: icon, cwd: join(app, 'src') })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe(`Updated icon for App using ${icon}.`)
    expect(h.upserts).toHaveLength(1)
    expect(h.upserts[0]).toMatchObject({ id: 'p-app', imagePath: '/images/p-app.png', imageRemoved: undefined })
    expect(h.broadcasts).toBe(1)
  })

  it('clears an earlier "icon removed" flag so the new icon shows', async () => {
    h.projects[2].imageRemoved = true
    await run({ path: icon, cwd: app })
    expect(h.upserts[0].imageRemoved).toBeUndefined()
  })

  it('picks the deepest project when repos nest', async () => {
    await run({ path: icon, cwd: join(inner, 'src', 'pages') })
    expect(h.upserts.map((p) => p.id)).toEqual(['p-web'])
    await run({ path: icon, cwd: join(outer, 'packages') })
    expect(h.upserts.map((p) => p.id)).toEqual(['p-web', 'p-mono'])
  })

  it('does not match a sibling folder that only shares a name prefix', async () => {
    const r = await run({ path: icon, cwd: app2 })
    expect(r.isError).toBe(true)
    expect(h.upserts).toEqual([])
  })

  it('follows a symlinked working directory to the real repo', async () => {
    const link = join(root, 'link-to-app')
    symlinkSync(app, link)
    await run({ path: icon, cwd: link })
    expect(h.upserts.map((p) => p.id)).toEqual(['p-app'])
  })

  it('an explicit folder beats the working directory', async () => {
    await run({ path: icon, folder: inner, cwd: app })
    expect(h.upserts.map((p) => p.id)).toEqual(['p-web'])
  })

  it('matches a project by name ignoring case and spaces at the ends', async () => {
    await run({ path: icon, project: '  web app ', cwd: app })
    expect(h.upserts.map((p) => p.id)).toEqual(['p-web'])
  })

  it.each([
    ['a relative path', 'icon.png'],
    ['a file that does not exist', join(root, 'missing.png')]
  ])('refuses %s without writing anything', async (_name, path) => {
    const r = await run({ path, cwd: app })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe(`No image file at ${path}.`)
    expect(h.copies).toEqual([])
    expect(h.upserts).toEqual([])
  })

  it('refuses when no project matches', async () => {
    const r = await run({ path: icon, project: 'Nope' })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe('No MightyMouse project matched Nope.')
    expect(h.upserts).toEqual([])
  })

  it('refuses a file that is not a supported image and leaves the project alone', async () => {
    const r = await run({ path: notAnImage, cwd: app })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^Unsupported image format/)
    expect(h.upserts).toEqual([])
    expect(h.broadcasts).toBe(0)
  })
})

describe('set_project_icon without a path', () => {
  it('uses the icon found in the project folder', async () => {
    h.discovered.set(app, join(app, 'favicon.svg'))
    const r = await run({ cwd: app })
    expect(text(r)).toBe(`Updated icon for App from ${join(app, 'favicon.svg')}.`)
    expect(h.copies).toEqual([['p-app', join(app, 'favicon.svg')]])
    expect(h.backfillCalls).toBe(0)
  })

  it('errors when the named project has no icon file, without a sweep over every project', async () => {
    const r = await run({ project: 'App' })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe(`No icon file found in ${app}. Add favicon.png or favicon.svg there, or pass path.`)
    expect(h.backfillCalls).toBe(0)
  })

  it('falls back to refreshing every project when only the working directory was known', async () => {
    h.backfilled = 3
    const r = await run({ cwd: app })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe('Refreshed 3 project icons.')
    expect(h.broadcasts).toBe(1)
  })

  it('says "icon" for one and does not ping the sidebar for none', async () => {
    h.backfilled = 1
    expect(text(await run({ cwd: join(root, 'elsewhere') }))).toBe('Refreshed 1 project icon.')
    h.broadcasts = 0
    h.backfilled = 0
    expect(text(await run({}))).toBe('Refreshed 0 project icons.')
    expect(h.broadcasts).toBe(0)
  })
})
