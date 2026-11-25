import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../../store/mighty', () => ({
  MIGHTY: {
    listProjects: () => [{ id: 'p-app', name: 'App', repoFolder: '/nowhere/app' }],
    upsertProject: (p: unknown) => p,
    backfillProjectImages: () => 2
  }
}))
vi.mock('../../../store/project-image', () => ({
  resolveProjectRepoFolder: (p: { repoFolder?: string }) => p.repoFolder ?? null,
  discoverProjectImage: () => null,
  copyProjectImage: () => null
}))

const { PROJECT_ICON_HANDLERS } = await import('../project-icon')

const run = (args: Record<string, unknown>) => PROJECT_ICON_HANDLERS.set_project_icon.run(args as never, {} as never)

describe('set_project_icon aimed at a project that does not exist', () => {
  it('errors on an unknown project name instead of reporting a refresh', async () => {
    const r = await run({ project: 'Nope' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('No MightyMouse project matched Nope.')
  })

  it('errors on a folder that is no project instead of reporting a refresh', async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'mm-not-a-project-')))
    const r = await run({ folder })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(`No MightyMouse project matched ${folder}.`)
  })
})
