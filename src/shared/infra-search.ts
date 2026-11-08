import type { MightyProject } from './types'
import type { KeyRecord, ProjectKeyMap } from './keys'
import { keyProvider } from './key-providers'
import { INFRA_KINDS, infraProvider, type InfraRecord, type ProjectInfra } from './infra'

export const ENV_LABELS: Record<string, string> = {
  prod: 'Production',
  staging: 'Staging',
  preview: 'Preview',
  dev: 'Development'
}

const KEY_STATUS_TEXT: Record<KeyRecord['status'], string> = {
  ready: 'Key works',
  unverified: 'Key saved, not checked yet',
  broken: 'Key failed its check',
  expiring: 'Key expires soon',
  expired: 'Key expired',
  missing: 'Key missing'
}

export type InfraJump = { kind?: string; env?: string }

export interface InfraHit {
  id: string
  projectId: string | null
  title: string
  detail: string
  jump: InfraJump
  keyId?: string
  shape?: string
  addKey?: { name: string; provider: string }
}

const providerName = (id: string): string => keyProvider(id)?.label ?? id

function kindForKey(
  record: InfraRecord | null,
  name: string,
  provider: string
): string | undefined {
  if (!record) return undefined
  return INFRA_KINDS.find((k) =>
    (record.services[k.id] ?? []).some(
      (e) => e.key === name || infraProvider(k.id, e.provider)?.keyProvider === provider
    )
  )?.id
}

export function infraHits(
  query: string,
  projects: MightyProject[],
  all: ProjectInfra[],
  maps: ProjectKeyMap[]
): InfraHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const out: InfraHit[] = []
  const add = (hit: InfraHit, haystack: (string | undefined)[]): void => {
    const text = haystack.filter(Boolean).join(' ').toLowerCase()
    if (words.every((w) => text.includes(w))) out.push(hit)
  }

  for (const p of projects) {
    const record = all.find((x) => x.projectId === p.id)?.record ?? null
    add({ id: `${p.id}:project`, projectId: p.id, title: p.name, detail: 'Project', jump: {} }, [
      p.name
    ])
    for (const kind of INFRA_KINDS) {
      for (const e of record?.services[kind.id] ?? []) {
        const label = infraProvider(kind.id, e.provider)?.label ?? e.label ?? e.provider
        add(
          {
            id: `${p.id}:svc:${kind.id}:${e.provider}`,
            projectId: p.id,
            title: label,
            detail: [kind.label, e.key, e.foundIn].filter(Boolean).join(' · '),
            jump: { kind: kind.id }
          },
          [label, e.provider, kind.label, e.key, e.foundIn, p.name]
        )
      }
    }
    for (const env of record?.environments ?? []) {
      const label = ENV_LABELS[env.name] ?? env.name
      const hosts = env.urls.map((u) => new URL(u).host)
      add(
        {
          id: `${p.id}:env:${env.name}`,
          projectId: p.id,
          title: label,
          detail: hosts.join(' · ') || env.foundIn.join(' · '),
          jump: { env: env.name }
        },
        [label, env.name, ...env.urls, ...env.accounts.flatMap((a) => [a.provider, a.id]), p.name]
      )
    }
  }

  for (const map of maps) {
    const project = projects.find((p) => p.id === map.projectId)
    if (map.projectId !== 'global' && !project) continue
    const projectId = project?.id ?? null
    const record = all.find((x) => x.projectId === projectId)?.record ?? null
    const owner = project?.name ?? 'All projects'
    const keyHit = (
      id: string,
      name: string,
      provider: string,
      detail: string,
      extra: string[],
      more: Partial<InfraHit> = {}
    ): void =>
      add(
        {
          id: `${map.projectId}:key:${id}`,
          projectId,
          title: name,
          detail,
          jump: { kind: kindForKey(record, name, provider) },
          ...more
        },
        [name, provider, providerName(provider), owner, ...extra]
      )
    for (const k of map.keys) {
      keyHit(
        k.id,
        k.name,
        k.provider,
        [providerName(k.provider), KEY_STATUS_TEXT[k.status], k.sourcePath]
          .filter(Boolean)
          .join(' · '),
        [k.sourcePath ?? '', k.note ?? ''],
        { keyId: k.id, shape: k.shape }
      )
    }
    for (const n of map.missing) {
      keyHit(
        `missing:${n.name}`,
        n.name,
        n.provider,
        `${providerName(n.provider)} · ${KEY_STATUS_TEXT.missing}`,
        n.evidence,
        { addKey: { name: n.name, provider: n.provider } }
      )
    }
    for (const b of map.cloud) {
      for (const name of b.names) {
        keyHit(
          `cloud:${b.host}:${name}`,
          name,
          '',
          [`Saved on ${providerName(b.host)}`, b.label].filter(Boolean).join(' · '),
          [b.host, providerName(b.host), b.label ?? '']
        )
      }
    }
  }
  return out
}
