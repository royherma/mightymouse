import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IncomingMessage, ServerResponse } from 'http'

const root = mkdtempSync(join(tmpdir(), 'mm-static-'))
for (const dir of [join(root, 'src/main/phone-remote/react/dist'), join(root, 'Resources/phone-remote-public')]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body>deck</body></html>')
  writeFileSync(join(dir, 'app.js'), 'console.log("bundle")')
}
writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET-CREDENTIAL')

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    getAppPath: () => root,
    getPath: (name: string) => (name === 'exe' ? join(root, 'MacOS', 'MightyMouse') : root)
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { serveStatic } = await import('../http-handlers')

afterAll(() => rmSync(root, { recursive: true, force: true }))

function get(url: string): { status: number; body: string } {
  let status = 0
  let body = ''
  const req = { url, method: 'GET', headers: {}, socket: { remoteAddress: '10.0.0.9' } }
  const res = {
    writeHead: (s: number) => {
      status = s
    },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? '' : chunk.toString()
    }
  }
  serveStatic(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  return { status, body }
}

describe('serveStatic path containment', () => {
  it('still serves a bundle asset and the SPA shell', () => {
    expect(get('/app.js').body).toContain('bundle')
    expect(get('/').body).toContain('deck')
    expect(get('/some/client/route').body).toContain('deck')
  })

  const up = '/..'.repeat(40)
  it.each([
    '/../../../../../secret.txt',
    '/assets/../../../../../../secret.txt',
    `${up}${root}/secret.txt`,
    `/assets${up}${root}/secret.txt`
  ])('never reads a file outside the public dir: %s', (url) => {
    expect(get(url).body).not.toContain('TOP-SECRET-CREDENTIAL')
  })
})
