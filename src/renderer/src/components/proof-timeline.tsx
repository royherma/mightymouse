import { useState } from 'react'
import { Camera, Globe } from 'lucide-react'
import type { AgentTranscriptTurn } from '../../../shared/types'
import { findPaths, isMediaPath, MediaTile } from './local-path'
import { RailSection } from './agent-context-rail'
import { Button } from './Button'
import { shortWhen } from './session-facts'
import { useMediaViewer } from './media-viewer'
import { linkMenu, openWeb } from '../hooks/useRailMode'

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g
const MOMENTS_SHOWN = 5

interface ProofMoment {
  at: number
  who: 'You' | 'Agent'
  media: string[]
  links: string[]
}

export function proofMoments(turns: readonly AgentTranscriptTurn[], cwd?: string): ProofMoment[] {
  const seen = new Set<string>()
  const fresh = (key: string): boolean => !seen.has(key) && !!seen.add(key)
  const moments: ProofMoment[] = []
  for (const turn of [...turns].reverse()) {
    if (turn.role === 'tool') continue
    const paths = [...(turn.files ?? []), ...findPaths(turn.text, cwd).map((f) => f.path)]
    const media = paths.filter(isMediaPath).filter(fresh)
    const links =
      turn.role === 'agent'
        ? [...turn.text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,:;!?*_]+$/, '')).filter(fresh)
        : []
    if (media.length || links.length) {
      moments.push({ at: turn.at, who: turn.role === 'you' ? 'You' : 'Agent', media, links })
    }
  }
  return moments
}

function linkParts(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url)
    return { host: u.host, rest: `${u.pathname}${u.search}`.replace(/^\/$/, '') }
  } catch {
    return { host: url, rest: '' }
  }
}

function LinkRow(props: { url: string }): React.JSX.Element {
  const { host, rest } = linkParts(props.url)
  return (
    <a
      href={props.url}
      className="local-path local-path-row"
      title={props.url}
      onClick={(e) => {
        e.preventDefault()
        void openWeb(props.url, e.metaKey)
      }}
      onContextMenu={(e) => void linkMenu(e, props.url)}
    >
      <Globe size={13} strokeWidth={2} />
      <span className="local-path-row-name">{host}</span>
      <span className="local-path-row-folder">{rest}</span>
    </a>
  )
}

export function ProofSection(props: {
  moments: ProofMoment[]
  agentName?: string
  now: number
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const [all, setAll] = useState(false)
  const shown = all ? props.moments : props.moments.slice(0, MOMENTS_SHOWN)
  const count = props.moments.reduce((n, m) => n + m.media.length + m.links.length, 0)
  const { open, viewer } = useMediaViewer(props.moments.flatMap((m) => m.media))
  return (
    <RailSection
      title="Screenshots & links"
      icon={Camera}
      open={props.open}
      onToggle={props.onToggle}
      badge={String(count)}
    >
      <ol className="proof-timeline">
        {shown.map((moment) => (
          <li key={`${moment.at}-${moment.media[0] ?? moment.links[0]}`} className="proof-moment">
            <span className="proof-moment-when">
              {moment.who === 'Agent' ? (props.agentName ?? moment.who) : moment.who} · {shortWhen(moment.at, props.now)}
            </span>
            {moment.media.length > 0 && (
              <div className="proof-moment-media">
                {moment.media.map((path) => (
                  <MediaTile key={path} path={path} onOpen={() => open(path)} />
                ))}
              </div>
            )}
            {moment.links.map((url) => (
              <LinkRow key={url} url={url} />
            ))}
          </li>
        ))}
      </ol>
      {props.moments.length > MOMENTS_SHOWN && (
        <Button variant="bare" className="agent-rail-files-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${props.moments.length}`}
        </Button>
      )}
      {viewer}
    </RailSection>
  )
}
