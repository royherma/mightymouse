import type { JSX } from 'react'
import { Code2 } from 'lucide-react'
import { keyProvider } from '../../../shared/key-providers'
import { keysFor, type KeyBook, type KeyMatch } from '../../../shared/key-owner'
import {
  INFRA_GROUP_LABELS,
  INFRA_KINDS,
  infraProvider,
  kindWanted,
  type InfraEntry,
  type InfraGroup,
  type InfraKind,
  type InfraProvider,
  type InfraRecord,
  type ProjectInfra
} from '../../../shared/infra'
import { Button } from './Button'
import { FaviconMark, KeyProviderIcon } from './KeyProviderIcon'
import './InfraScorecard.css'

export type KeyDot = 'works' | 'unchecked' | 'none' | 'failed'

export const DOT_TEXT: Record<KeyDot, string> = {
  works: 'Key works',
  unchecked: 'Key saved, not checked yet',
  none: 'No key saved in Keys',
  failed: 'Key failed its check'
}

const GUESSED_TEXT = 'No key saved, and its name is not in the code'

export const INFRA_GROUPS: InfraGroup[] = ['watch', 'users', 'runs', 'safety']

export function ProviderIcon({
  provider,
  size = 14
}: {
  provider?: InfraProvider
  size?: number
}): JSX.Element {
  if (provider?.keyProvider) return <KeyProviderIcon provider={provider.keyProvider} size={size} />
  if (provider?.site) return <FaviconMark url={`https://${provider.site}`} size={size} />
  return <Code2 size={size} strokeWidth={2} />
}

function matchesFor(
  provider: InfraProvider,
  entry: InfraEntry,
  projectId: string,
  book: KeyBook
): KeyMatch[] {
  return keysFor(provider.keyProvider, entry.key, projectId, book.keys, book.owners)
}

export function keyProblem(
  provider: InfraProvider | undefined,
  entry: InfraEntry,
  projectId: string,
  book: KeyBook
): string {
  const dot = keyDot(provider, entry, projectId, book)
  if (!provider || !dot) return ''
  const matches = matchesFor(provider, entry, projectId, book)
  if (dot === 'none') return entry.keyGuessed ? GUESSED_TEXT : DOT_TEXT.none
  const failed = matches.find(
    (m) => (m.key.status === 'broken' || m.key.status === 'expired') && m.key.lastDetail
  )
  if (dot === 'failed' && failed) return `${DOT_TEXT.failed}: ${failed.key.lastDetail}`
  const shown =
    matches.find((m) => m.key.status === 'ready' || m.key.status === 'expiring') ?? matches[0]
  return `${DOT_TEXT[dot]}: ${shown.key.name} (${shown.why})`
}

export function keyDot(
  provider: InfraProvider | undefined,
  entry: InfraEntry,
  projectId: string,
  book: KeyBook
): KeyDot | null {
  if (!provider?.keyProvider || provider.noKey) return null
  const keys = matchesFor(provider, entry, projectId, book).map((m) => m.key)
  if (keys.length === 0) return 'none'
  if (keys.some((k) => k.status === 'ready' || k.status === 'expiring')) return 'works'
  if (keys.some((k) => k.status === 'broken' || k.status === 'expired')) return 'failed'
  return 'unchecked'
}

type Cell = 'ok' | 'weak' | 'adding' | 'missing'

const CELL_TEXT: Record<Cell, string> = {
  ok: 'hooked up',
  weak: 'hooked up, key needs fixing',
  adding: 'An agent is adding it',
  missing: 'missing'
}

const DOT_RANK: KeyDot[] = ['works', 'unchecked', 'none', 'failed']

const KEY_COUNT_TEXT: Record<KeyDot, string> = {
  works: 'working',
  unchecked: 'not checked',
  none: 'no key',
  failed: 'failed'
}

interface KindScore {
  kind: InfraKind
  cell: Cell
}

function scoreKinds(record: InfraRecord, projectId: string, book: KeyBook): KindScore[] {
  return INFRA_KINDS.filter((k) => kindWanted(k, record)).map((kind) => {
    const entries = record.services[kind.id] ?? []
    if (entries.length === 0) return { kind, cell: record.setups?.[kind.id] ? 'adding' : 'missing' }
    const healthy = entries.some((e) => {
      const dot = keyDot(infraProvider(kind.id, e.provider), e, projectId, book)
      return dot !== 'none' && dot !== 'failed'
    })
    return { kind, cell: healthy ? 'ok' : 'weak' }
  })
}

export function brokenKeys(
  record: InfraRecord | null,
  projectId: string,
  book: KeyBook
): { kind: InfraKind; entry: InfraEntry; dot: KeyDot; problem: string }[] {
  if (!record) return []
  return scoreKinds(record, projectId, book).flatMap(({ kind, cell }) => {
    if (cell !== 'weak') return []
    const entry = (record.services[kind.id] ?? [])[0]
    const provider = infraProvider(kind.id, entry.provider)
    const dot = keyDot(provider, entry, projectId, book)
    return dot ? [{ kind, entry, dot, problem: keyProblem(provider, entry, projectId, book) }] : []
  })
}

function scoreOf(kinds: KindScore[]): number {
  if (kinds.length === 0) return 100
  const points = kinds.reduce((n, k) => n + (k.cell === 'ok' ? 1 : k.cell === 'weak' ? 0.5 : 0), 0)
  return Math.round((100 * points) / kinds.length)
}

function verdict(score: number): { text: string; tone: 'green' | 'amber' | 'red' } {
  if (score >= 85) return { text: 'In good shape', tone: 'green' }
  if (score >= 60) return { text: 'A few gaps', tone: 'amber' }
  return { text: 'Missing basics', tone: 'red' }
}

interface Platform {
  id: string
  label: string
  provider?: InfraProvider
  jobs: string[]
  kindId: string
  dot: KeyDot | null
}

function platformsOf(record: InfraRecord, projectId: string, book: KeyBook): Platform[] {
  const byId = new Map<string, Platform>()
  for (const kind of INFRA_KINDS) {
    for (const e of record.services[kind.id] ?? []) {
      const provider = infraProvider(kind.id, e.provider)
      const id = provider?.keyProvider ?? provider?.id ?? e.provider
      const label =
        (provider?.keyProvider && keyProvider(provider.keyProvider)?.label) ||
        provider?.label ||
        e.label ||
        e.provider
      const p = byId.get(id) ?? { id, label, provider, jobs: [], kindId: kind.id, dot: null }
      if (!p.jobs.includes(kind.label)) p.jobs.push(kind.label)
      const dot = keyDot(provider, e, projectId, book)
      if (dot && (!p.dot || DOT_RANK.indexOf(dot) > DOT_RANK.indexOf(p.dot))) {
        p.dot = dot
        p.kindId = kind.id
      }
      byId.set(id, p)
    }
  }
  return [...byId.values()].sort((a, b) => b.jobs.length - a.jobs.length)
}

function ordinal(n: number): string {
  return n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`
}

function rankLine(all: ProjectInfra[], projectId: string, book: KeyBook): string | null {
  const scored = all
    .filter((p) => p.record)
    .map((p) => ({
      id: p.projectId,
      score: scoreOf(scoreKinds(p.record as InfraRecord, p.projectId, book))
    }))
  if (scored.length < 2) return null
  const mine = scored.find((p) => p.id === projectId)
  if (!mine) return null
  const place = scored.filter((p) => p.score > mine.score).length + 1
  return place === 1
    ? `Best of your ${scored.length} projects`
    : `${ordinal(place)} of your ${scored.length} projects`
}

export function InfraScorecard({
  projectId,
  record,
  all,
  book,
  onJump
}: {
  projectId: string
  record: InfraRecord | null
  all: ProjectInfra[]
  book: KeyBook
  onJump: (kindId: string) => void
}): JSX.Element {
  if (!record) {
    return (
      <aside className="infra-card" aria-busy="true">
        <div className="infra-card-wait">Scoring…</div>
      </aside>
    )
  }

  const kinds = scoreKinds(record, projectId, book)
  const score = scoreOf(kinds)
  const v = verdict(score)
  const hooked = kinds.filter((k) => k.cell === 'ok' || k.cell === 'weak').length
  const next = kinds.find((k) => k.cell === 'missing') ?? kinds.find((k) => k.cell === 'weak')
  const rank = rankLine(all, projectId, book)
  const platforms = platformsOf(record, projectId, book)
  const keyed = platforms.filter((p) => p.dot)
  const keyCounts = DOT_RANK.map((d) => [d, keyed.filter((p) => p.dot === d).length] as const)

  return (
    <aside className="infra-card" aria-label="Score">
      <section className="infra-card-score">
        <div className="infra-card-number" data-tone={v.tone}>
          {score}
          <span>/100</span>
        </div>
        <div className="infra-card-verdict" data-tone={v.tone}>
          {v.text}
        </div>
        <div className="infra-card-sub">
          {hooked} of {kinds.length} basics hooked up
          {rank && <> · {rank}</>}
        </div>
        {next && (
          <Button variant="bare" className="infra-card-next" onClick={() => onJump(next.kind.id)}>
            <b>Fix next: {next.kind.label}</b>
            <span>
              {next.cell === 'weak' ? 'Its key is missing or failing' : next.kind.missing}
            </span>
          </Button>
        )}
      </section>

      <section className="infra-card-block">
        <h3 className="keys-section-head">By area</h3>
        {INFRA_GROUPS.map((group) => {
          const inGroup = kinds.filter((k) => k.kind.group === group)
          if (inGroup.length === 0) return null
          const done = inGroup.filter((k) => k.cell === 'ok').length
          return (
            <div key={group} className="infra-card-slice">
              <span className="infra-card-slice-name">{INFRA_GROUP_LABELS[group]}</span>
              <span className="infra-card-slice-count">
                {done}/{inGroup.length}
              </span>
              <span className="infra-card-cells">
                {inGroup.map((k) => (
                  <Button
                    key={k.kind.id}
                    variant="bare"
                    className="infra-card-cell"
                    data-cell={k.cell}
                    title={`${k.kind.label} - ${CELL_TEXT[k.cell]}`}
                    aria-label={`${k.kind.label} - ${CELL_TEXT[k.cell]}`}
                    onClick={() => onJump(k.kind.id)}
                  />
                ))}
              </span>
            </div>
          )
        })}
      </section>

      {platforms.length > 0 && (
        <section className="infra-card-block">
          <h3 className="keys-section-head">
            {platforms.length} {platforms.length === 1 ? 'service' : 'services'}
          </h3>
          {platforms.map((p) => (
            <Button
              key={p.id}
              variant="bare"
              className="infra-card-platform"
              onClick={() => onJump(p.kindId)}
            >
              <ProviderIcon provider={p.provider} />
              <span className="infra-card-platform-text">
                <b>{p.label}</b>
                <span>{p.jobs.join(', ')}</span>
              </span>
              {p.dot && (
                <span
                  className="keys-status-dot infra-dot"
                  data-dot={p.dot}
                  title={DOT_TEXT[p.dot]}
                />
              )}
            </Button>
          ))}
          {keyed.length > 0 && (
            <div className="infra-card-keys">
              {keyCounts
                .filter(([, n]) => n > 0)
                .map(([d, n]) => (
                  <span key={d}>
                    <span className="keys-status-dot infra-dot" data-dot={d} />
                    {n} {KEY_COUNT_TEXT[d]}
                  </span>
                ))}
            </div>
          )}
        </section>
      )}
    </aside>
  )
}
