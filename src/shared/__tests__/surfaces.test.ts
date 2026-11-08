import { describe, it, expect } from 'vitest'
import type { InfraEnvironment, InfraSurface } from '../infra'
import {
  askedEnvs,
  commandPaths,
  deployEnvs,
  deploySegments,
  detectSurfaces,
  mergeSurfaces,
  sessionAffects,
  unknownAffects
} from '../surfaces'

const environments: InfraEnvironment[] = [
  {
    name: 'prod',
    foundIn: [],
    urls: ['https://example.com'],
    accounts: [{ provider: 'supabase', id: 'prodref123', foundIn: '' }]
  },
  { name: 'staging', foundIn: [], urls: [], accounts: [] }
]
const envsOf = (command: string): string[] =>
  [...new Set(deploySegments(command).flatMap((s) => deployEnvs(s, environments)))].sort()

describe('deploy commands', () => {
  it.each([
    ['bash portal/deploy.sh staging', ['staging']],
    ['MM_CONFIRM=prod bash web/deploy.sh prod > "$LOG" 2>&1', ['prod']],
    ['if MM_CONFIRM=staging bash web/deploy.sh prod; then echo ok; fi', ['prod']],
    ['npm run deploy:staging', ['staging']],
    ['cd portal && ./deploy.sh --env=production', ['prod']],
    ['supabase functions deploy web-chat --project-ref prodref123', ['prod']]
  ])('%s', (command, want) => expect(envsOf(command)).toEqual(want))

  it.each([
    'grep -rn "deploy.sh prod" docs',
    'git log --grep deploy -- staging',
    'cat > x.mjs <<EOF\nconst a = "deploy staging prod"\nEOF',
    'LOG=/tmp/prod/deploy.log',
    'bash web/deploy.sh prod --dry-run',
    'curl -X POST https://example.com/api -d \'{"note":"deploy"}\'',
    'make restart'
  ])('not a deploy: %s', (command) => expect(envsOf(command)).toEqual([]))
})

describe('surfaces', () => {
  const surfaces: InfraSurface[] = [
    { name: 'Mac app', paths: ['src/'], kind: 'desktop', manual: true },
    { name: 'Phone Remote', paths: ['src/main/phone-remote/'], kind: 'mobile', manual: true },
    { name: 'Portal', paths: ['portal/'], kind: 'web', manual: true }
  ]

  it('gives a file to the most specific surface and counts stated ones', () => {
    const touched = {
      edits: {
        '/repo/src/main/phone-remote/a.ts': 5,
        '/repo/src/main/b.ts': 9,
        'portal/c.tsx': 7,
        '/elsewhere/d.ts': 8,
        '/repo/docs/e.md': 8
      },
      reads: {},
      deploys: [{ at: 20, command: 'bash portal/deploy.sh staging' }],
      asked: { staging: 30, prod: 31, preview: 32 }
    }
    const out = sessionAffects(
      touched,
      { root: '/repo', cwd: '/repo' },
      { surfaces, environments },
      ['production']
    )
    expect(out.surfaces.map((s) => [s.name, s.files, s.lastAt])).toEqual([
      ['Mac app', 1, 9],
      ['Portal', 1, 7],
      ['Phone Remote', 1, 5]
    ])
    expect(out.envs).toEqual([
      { name: 'staging', lastAt: 20 },
      { name: 'prod', lastAt: 0, stated: true }
    ])
  })

  it('shows the part an agent is reading only until it edits something', () => {
    const command =
      "sed -n '4,9p' portal/src/a.tsx && grep -rn 's/x/y/' ./portal/src src/main/b.ts https://x.io/p"
    const reads = {
      ...Object.fromEntries(commandPaths(command).map((p, i) => [p, i + 1])),
      '/repo/portal/c.tsx': 9
    }
    const where = { root: '/repo', cwd: '/repo' }
    const names = (edits: Record<string, number>): unknown[] =>
      sessionAffects({ edits, reads, deploys: [], asked: {} }, where, { surfaces }).surfaces.map(
        (s) => [s.name, s.files, s.reads]
      )
    expect(names({})).toEqual([['Portal', 0, 3]])
    expect(names({ '/repo/src/main/b.ts': 1 })).toEqual([['Mac app', 1, 0]])
  })

  it.each([
    ['change the pricing headline and ship it to staging. Do not change anything yet', ['staging']],
    ['Deploy the portal to PROD, then run portal/deploy.sh staging', ['prod', 'staging']],
    ['do not deploy to prod', []],
    ['staging looks broken, why?', []],
    ['Have we deployed web staging recently?', []],
    ['<summary>Background command "ship to prod" completed</summary>', []],
    ['x'.repeat(1500) + ' ship to staging', []]
  ])('asked for: %s', (said, want) => expect(askedEnvs(said)).toEqual(want))

  it('shows an asked-for environment only until a real deploy or a stated name covers it', () => {
    const touched = { edits: {}, reads: {}, deploys: [], asked: { staging: 5, preview: 6 } }
    const where = { root: '/repo', cwd: '/repo' }
    expect(sessionAffects(touched, where, { surfaces, environments }).envs).toEqual([
      { name: 'staging', lastAt: 5, asked: true }
    ])
  })

  it('finds surfaces from the file list and lets a hand-set one win its folder', () => {
    const scanned = detectSurfaces([
      'ios/App.xcodeproj/project.pbxproj',
      'web/deploy.sh',
      'src/main/index.ts',
      'README.md'
    ])
    expect(scanned.map((s) => [s.name, s.paths])).toEqual([
      ['iPhone app', ['ios/']],
      ['Web', ['web/']],
      ['Desktop app', ['src/']]
    ])
    expect(mergeSurfaces(scanned, surfaces).map((s) => s.name)).toEqual([
      'Mac app',
      'Phone Remote',
      'Portal',
      'iPhone app',
      'Web'
    ])
  })

  it.each([
    [['Vily.xcodeproj/project.pbxproj', 'Podfile'], [['iPhone app', ['']]]],
    [['settings.gradle', 'app/build.gradle'], [['Android app', ['']]]],
    [['scripts/deploy.sh', 'public/index.html', 'firebase.json'], [['Web app', ['']]]],
    [
      ['functions/package.json', 'create-app/public/index.html'],
      [
        ['Cloud backend', ['functions/']],
        ['Create app', ['create-app/']]
      ]
    ],
    [
      ['web/backend/package.json', 'web/frontend/vite.config.ts', 'docs/index.html'],
      [
        ['Backend', ['web/backend/']],
        ['Frontend', ['web/frontend/']]
      ]
    ],
    [
      ['wrangler.jsonc', 'apps/api/src/index.ts', 'apps/web/src/main.tsx', 'packages/x/a.ts'],
      [
        ['Backend', ['apps/api/']],
        ['Web', ['apps/web/']]
      ]
    ],
    [['README.md', 'main.py', 'electron.vite.config.ts'], []]
  ])('finds the apps in %j', (files, want) =>
    expect(detectSurfaces(files).map((s) => [s.name, s.paths])).toEqual(want)
  )

  it('gives a whole-repo surface every file a more specific one does not own', () => {
    const whole: InfraSurface[] = [
      { name: 'iPhone app', paths: [''], kind: 'mobile' },
      { name: 'Web', paths: ['web/'], kind: 'web' }
    ]
    const touched = {
      edits: { '/repo/Podfile': 1, '/repo/web/a.ts': 2, '/elsewhere/b.ts': 3 },
      reads: {},
      deploys: [],
      asked: {}
    }
    const out = sessionAffects(touched, { root: '/repo', cwd: '/repo' }, { surfaces: whole })
    expect(out.surfaces.map((s) => [s.name, s.files])).toEqual([
      ['Web', 1],
      ['iPhone app', 1]
    ])
  })

  it('rejects a name the project does not list', () => {
    expect(
      unknownAffects(['portal', 'Production', 'Billing'], ['Portal', 'prod', 'staging'])
    ).toEqual(['Billing'])
  })
})
