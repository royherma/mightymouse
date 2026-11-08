import { Plus, Search, Slash, Terminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyMatch } from '../../shared/fuzzy'
import { mightyProjectForCwd } from '../../shared/relay-sessions'
import type { MightyProject, VoiceRouteHelperOption } from '../../shared/types'
import { ProjectAvatar } from './components/ProjectIcon'
import { agentName, skillName } from './voice-route-labels'
import { Button } from './components/Button'

const MAX_RESULTS = 8
const PICK_BOOST_CAP = 5

interface Hit {
  option: VoiceRouteHelperOption
  label: string
  score: number
}

function labelOf(o: VoiceRouteHelperOption): string {
  return o.kind === 'agent' ? agentName(o.label) : skillName(o.label)
}

function words(text: string): string {
  return text.replace(/[-_/.:]+/g, ' ')
}

/** Letters in order, scored by how many land on a word start: "mmrel" → mightymouse-release. */
function initialsScore(label: string, query: string): number {
  const hay = words(label).toLowerCase()
  let at = 0
  let starts = 0
  for (let i = 0; i < hay.length && at < query.length; i++) {
    if (hay[i] !== query[at]) continue
    if (i === 0 || hay[i - 1] === ' ') starts++
    at++
  }
  return at === query.length ? 2 + (6 * starts) / query.length : 0
}

function scoreOf(o: VoiceRouteHelperOption, label: string, query: string, picks: number): number {
  const boost = Math.min(picks, PICK_BOOST_CAP) + o.percent / 100
  if (query === '') return 1 + boost
  const q = query.toLowerCase()
  const onLabel = fuzzyMatch(words(label), q).score
  const onRest = fuzzyMatch(words(`${o.label} ${o.project} ${o.branch} ${o.description}`), q).score
  const match =
    onLabel > 0 ? onLabel * 10 : onRest > 0 ? onRest * 5 : initialsScore(label, q.replace(/\s+/g, ''))
  if (match === 0) return 0
  const leads = words(label).toLowerCase().startsWith(q) ? 1 : 0
  return match + leads + boost - label.length / 1000
}

export function ProjectMark({
  cwd,
  projects,
  children
}: {
  cwd: string
  projects: MightyProject[]
  children: React.ReactNode
}): React.JSX.Element {
  const project = mightyProjectForCwd(cwd, projects)
  if (!project) return <>{children}</>
  return (
    <span className="vroute-icon" title={project.name}>
      <ProjectAvatar icon={project.icon} imagePath={project.imagePath} size={16} className="rounded-sm" />
    </span>
  )
}

function KindGlyph({ kind }: { kind: VoiceRouteHelperOption['kind'] }): React.JSX.Element {
  const Icon = kind === 'skill' ? Slash : kind === 'new-agent' ? Plus : Terminal
  return (
    <span className="vroute-kind">
      <Icon size={13} strokeWidth={2.5} />
    </span>
  )
}

export function VoiceRouteSearch({
  options,
  projects,
  picks,
  open,
  onOpen,
  onClose,
  onPick,
  onWantFocus
}: {
  options: VoiceRouteHelperOption[]
  projects: MightyProject[]
  picks: Record<string, number>
  open: boolean
  onOpen: () => void
  onClose: () => void
  onPick: (option: VoiceRouteHelperOption, query: string) => void
  onWantFocus: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    onWantFocus()
    inputRef.current?.focus()
  }, [open, onWantFocus])

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim()
    return options
      .map((option) => {
        const label = labelOf(option)
        return { option, label, score: scoreOf(option, label, q, picks[option.sinkId] ?? 0) }
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
  }, [options, picks, query])

  if (!open) {
    return (
      <Button
        variant="ghost"
        className="vroute-more flex w-full items-center gap-1.5"
        onClick={onOpen}
      >
        <Search size={11} strokeWidth={2.5} />
        <span className="flex-1 text-left">Search all skills and agents</span>
        <kbd className="text-xs opacity-70">⌘K</kbd>
      </Button>
    )
  }

  const pick = (hit: Hit | undefined): void => {
    if (hit) onPick(hit.option, query.trim())
  }

  return (
    <div className="vroute-rows">
      <div className="flex items-center gap-1.5 px-[7px] py-1">
        <Search size={12} strokeWidth={2.5} className="shrink-0 text-muted" />
        <input
          ref={inputRef}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          placeholder="Type a skill or agent…"
          value={query}
          onMouseDown={onWantFocus}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, hits.length - 1))
            else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0))
            else if (e.key === 'Enter') pick(hits[cursor])
            else if (e.key === 'Escape') onClose()
            else return
            e.preventDefault()
          }}
        />
        <Button variant="ghost" className="vroute-more" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {hits.length === 0 ? (
        <div className="px-[7px] py-1 text-xs text-muted">Nothing matches &ldquo;{query.trim()}&rdquo;</div>
      ) : (
        hits.map((hit, i) => (
          <div
            key={hit.option.sinkId}
            className={`vroute-row${i === cursor ? ' is-suggested' : ''}`}
            onMouseEnter={() => setCursor(i)}
          >
            <div className="vroute-top">
              <Button
                variant="ghost"
                className="vroute-main"
                title={hit.option.description}
                onClick={() => pick(hit)}
              >
                <ProjectMark cwd={hit.option.cwd} projects={projects}>
                  <KindGlyph kind={hit.option.kind} />
                </ProjectMark>
                <span className="vroute-name text-sm">{hit.label}</span>
                {hit.option.kind === 'agent' && hit.option.project !== '' ? (
                  <span className="vroute-context">{hit.option.project}</span>
                ) : hit.option.kind === 'skill' ? (
                  <span className="vroute-context">{hit.option.description}</span>
                ) : null}
                <span className="vroute-pct">{i === cursor ? '⏎' : `${hit.option.percent}%`}</span>
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
