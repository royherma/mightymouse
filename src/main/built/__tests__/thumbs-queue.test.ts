import { describe, expect, it, vi } from 'vitest'

const mkdir = vi.fn<() => Promise<void>>()
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }))
vi.mock('../../store/paths', () => ({ PATHS: { LINK_PREVIEWS: '/tmp/mm-thumbs-test' } }))
vi.mock('fs', () => ({ existsSync: () => true }))
vi.mock('fs/promises', () => ({
  mkdir: () => mkdir(),
  stat: async () => ({ mtimeMs: 1 }),
  writeFile: async () => undefined
}))

import { queueThumbs } from '../thumbs'

const item = (id: string) => ({ id, file: `/tmp/${id}.html` }) as never

describe('built thumbnails queue', () => {
  it('keeps producing thumbnails after one batch fails', async () => {
    mkdir.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue(undefined)
    const onChange = vi.fn()

    queueThumbs([item('a')], onChange)
    queueThumbs([item('b')], onChange)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 1000 })
  })
})
