import { describe, it, expect } from 'vitest'
import { KEY_PROVIDERS, keyProvider } from '../key-providers'
import type { KeyRecord } from '../keys'
import { duplicateKeys, keyNameFromCode, keysFor, ownerPrefixes, type KeyOwner } from '../key-owner'

const key = (name: string, provider: string, extra: Partial<KeyRecord> = {}): KeyRecord => ({
  id: `global:${name}`,
  name,
  provider,
  routes: ['api'],
  scope: 'global',
  source: 'keychain',
  shape: '',
  length: 0,
  status: 'ready',
  addedBy: 'scan',
  updated: '',
  ...extra
})

const owners: KeyOwner[] = [
  {
    id: 'dlc',
    prefixes: ownerPrefixes(['labelco', 'labelco', 'nimbus'], KEY_PROVIDERS)
  },
  { id: 'acme', prefixes: ownerPrefixes(['Acme', 'acme'], KEY_PROVIDERS) }
]

const names = (provider: string, projectId: string, keys: KeyRecord[]): string[] =>
  keysFor(provider, undefined, projectId, keys, owners).map((m) => m.key.name)

describe('keysFor', () => {
  it('counts a NIMBUS_ key for labelco only', () => {
    const keys = [key('NIMBUS_POSTHOG_PROD_TOKEN', 'posthog')]
    expect(names('posthog', 'dlc', keys)).toEqual(['NIMBUS_POSTHOG_PROD_TOKEN'])
    expect(names('posthog', 'acme', keys)).toEqual([])
  })

  it('counts an unprefixed key for every project', () => {
    const keys = [key('SENTRY_AUTH_TOKEN', 'sentry')]
    expect(names('sentry', 'dlc', keys)).toEqual(['SENTRY_AUTH_TOKEN'])
    expect(names('sentry', 'acme', keys)).toEqual(['SENTRY_AUTH_TOKEN'])
  })

  it('lets an explicit Used by list replace the name rule', () => {
    const keys = [key('SENTRY_AUTH_TOKEN', 'sentry', { projects: ['acme'] })]
    expect(names('sentry', 'acme', keys)).toEqual(['SENTRY_AUTH_TOKEN'])
    expect(names('sentry', 'dlc', keys)).toEqual([])
  })

  it('says why a key counts', () => {
    const [m] = keysFor(
      'posthog',
      undefined,
      'dlc',
      [key('NIMBUS_POSTHOG_PROD_TOKEN', 'posthog')],
      owners
    )
    expect(m.why).toBe('name starts with NIMBUS_')
  })
})

describe('keyNameFromCode', () => {
  it('uses the name the code reads, not the provider default', () => {
    const posthog = keyProvider('posthog')!
    const code = 'const t = env.POSTHOG_PROJECT_TOKEN'
    expect(
      keyNameFromCode(posthog, ['POSTHOG_PROJECT_TOKEN', 'POSTHOG_HOST'], code, KEY_PROVIDERS)
    ).toEqual({
      key: 'POSTHOG_PROJECT_TOKEN'
    })
  })

  it('marks the provider default as guessed when the code names nothing', () => {
    const posthog = keyProvider('posthog')!
    expect(keyNameFromCode(posthog, [], '', KEY_PROVIDERS)).toEqual({
      key: 'POSTHOG_API_KEY',
      guessed: true
    })
  })
})

describe('duplicateKeys', () => {
  const pairs = (keys: KeyRecord[]): string[][] =>
    duplicateKeys(keys).map(([a, b]) => [a.name, b.name])

  it('flags a one-letter typo and two names for the same key', () => {
    expect(
      pairs([
        key('CLOUDFLARE_ANALYTICSS_TOKEN', 'cloudflare'),
        key('CLOUDFLARE_ANALYTICS_TOKEN', 'cloudflare')
      ])
    ).toHaveLength(1)
    expect(pairs([key('RESEND_API_KEY', 'resend'), key('RESEND_TOKEN', 'resend')])).toHaveLength(1)
  })

  it('leaves prod and staging keys alone', () => {
    expect(
      pairs([
        key('NIMBUS_POSTHOG_PROD_TOKEN', 'posthog'),
        key('NIMBUS_POSTHOG_STAGING_TOKEN', 'posthog')
      ])
    ).toEqual([])
    expect(
      pairs([key('STRIPE_SECRET_KEY', 'stripe'), key('STRIPE_WEBHOOK_SECRET', 'stripe')])
    ).toEqual([])
  })
})
