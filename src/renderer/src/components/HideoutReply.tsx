import type { CSSProperties, JSX } from 'react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from './Button'
import { ProviderIcon, providerIconFor, type ProviderIconId } from './ProviderIcon'
import { alignWords, tokenIndexAt, tokenizeForHighlight } from '../mighty/speech-highlight'
import type { HideoutHop, HideoutSpendRow } from '../../../shared/hideout'
import type { SpokenWord } from '../../../shared/types'

export type PlaybackClock = () => { t: number; d: number } | null

const SHORT_REPLY = 110
const CLIP_LINES = 3

const ICON_MIC = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)
const ICON_VOICE = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
)
const ICON_ARROW = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

export const money = (usd?: number): string =>
  usd === undefined ? '—' : usd === 0 ? 'free' : usd < 0.001 ? '<$0.001' : `$${usd.toFixed(usd < 1 ? 3 : 2)}`

const took = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)

export function HopTile({ hop }: { hop: Pick<HideoutHop, 'icon' | 'model'> }): JSX.Element {
  const glyph =
    hop.icon === 'mic' ? ICON_MIC : hop.icon === 'voice' ? ICON_VOICE : <ProviderIcon id={hop.model?.includes('/') ? providerIconFor(hop.model) : (hop.icon as ProviderIconId)} size={14} />
  return <span className="tile">{glyph}</span>
}

export function SpendRows({ rows }: { rows: HideoutSpendRow[] }): JSX.Element | null {
  const top = [...rows].sort((a, b) => b.usd - a.usd || b.turns - a.turns).slice(0, 4)
  if (!top.length) return null
  return (
    <div className="spend">
      {top.map((r) => (
        <div key={r.key} className="srow">
          <HopTile hop={r} />
          <span className="lbl">{r.label}</span>
          <span className="n">{r.turns}×</span>
          <span className={`usd${r.usd ? '' : ' free'}`}>{r.usd || r.local ? money(r.usd) : '—'}</span>
        </div>
      ))}
    </div>
  )
}

export function HideoutChain({ hops, firstSoundMs }: { hops: HideoutHop[]; firstSoundMs: number | null }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const turn = hops.map((h) => `${h.key}:${h.ms}`).join()
  useEffect(() => setOpen(false), [turn])
  if (!hops.length) return null
  const ms = hops.reduce((n, h) => n + h.ms, 0)
  const usd = hops.reduce((n, h) => n + (h.usd ?? 0), 0)
  const unknown = hops.some((h) => h.usd === undefined)
  const price = unknown && !usd ? '—' : `${money(usd)}${unknown ? '+' : ''}`
  return (
    <div className="chain-wrap">
      {open ? (
        <div className="chain-detail">
          {hops.map((h, i) => (
            <Fragment key={i}>
              {i ? <span className="arrow">{ICON_ARROW}</span> : null}
              <div className="hstep">
                <HopTile hop={h} />
                <span className="lbl">{h.label}</span>
                <span className="where">{h.local ? 'on this Mac' : 'cloud'}</span>
                <span className="nums">
                  {took(h.ms)} · <span className={h.usd === 0 ? 'free' : ''}>{money(h.usd)}</span>
                </span>
              </div>
            </Fragment>
          ))}
        </div>
      ) : null}
      <Button variant="bare" className={`chain${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {hops.map((h, i) => (
          <span key={i} className="hop" title={h.label}>
            {i ? <span className="arrow">{ICON_ARROW}</span> : null}
            <HopTile hop={h} />
            <span className="n">{took(h.ms)}</span>
          </span>
        ))}
        <span className="total" title={`Done in ${took(ms)}`}>
          {firstSoundMs === null ? took(ms) : `first sound ${took(firstSoundMs)}`} · {price}
        </span>
      </Button>
    </div>
  )
}

function charStops(tokens: string[]): number[] {
  let at = 0
  return tokens.map((t) => (at += t.length))
}

export function HideoutReply({
  reply,
  voiced,
  words,
  waiting,
  speaking,
  position
}: {
  reply: string
  voiced: boolean
  words: SpokenWord[] | null
  waiting: boolean
  speaking: boolean
  position: PlaybackClock
}): JSX.Element {
  const timed = useMemo(() => (words ? alignWords(reply, words) : null), [reply, words])
  const tokens = useMemo(() => timed?.map((t) => t.text) ?? tokenizeForHighlight(reply), [reply, timed])
  const stops = useMemo(() => charStops(tokens), [tokens])
  const [lit, setLit] = useState(tokens.length)
  const played = useRef(false)
  const inner = useRef<HTMLDivElement>(null)
  const [clip, setClip] = useState<{ h: number; line: number; full: number } | null>(null)
  const [shift, setShift] = useState(0)

  useEffect(() => {
    played.current = false
  }, [reply])

  useEffect(() => {
    if (!voiced) return setLit(tokens.length)
    if (!speaking) return setLit(played.current || !waiting ? tokens.length : -1)
    played.current = true
    const lastEnd = timed?.reduce((m, t) => Math.max(m, t.end ?? 0), 0) ?? 0
    let raf = 0
    const tick = (): void => {
      const p = position()
      if (p) {
        const total = stops[stops.length - 1] ?? 0
        const i = timed ? tokenIndexAt(timed, p.t) : p.d ? stops.findIndex((s) => s >= (p.t / p.d) * total) : -1
        setLit(i < 0 && timed && p.t >= lastEnd ? tokens.length : i)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [voiced, speaking, waiting, timed, stops, tokens.length, position])

  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const line = parseFloat(getComputedStyle(el).lineHeight) || 40
    setClip({ h: Math.min(el.scrollHeight, line * CLIP_LINES), line, full: el.scrollHeight })
  }, [reply])

  useLayoutEffect(() => {
    if (!clip || clip.full <= clip.h || !inner.current) return setShift(0)
    const span = inner.current.children[Math.max(0, Math.min(lit, tokens.length - 1))] as HTMLElement | undefined
    const top = span?.offsetTop ?? 0
    setShift(Math.max(0, Math.min(top - clip.line, clip.full - clip.h)))
  }, [lit, clip, tokens.length])

  const clipped = !!clip && clip.full > clip.h
  return (
    <div
      className={`reply ${reply.length <= SHORT_REPLY ? 'short' : 'long'}`}
      style={{ '--clip': clip ? `${clip.h}px` : 'none', '--shift': `${-shift}px` } as CSSProperties}
    >
      <div className={`rbox${clipped ? ' clipped' : ''}${shift ? ' shifted' : ''}`}>
        <div ref={inner} className="rtext">
          {tokens.map((t, i) => (
            <span key={i} className={i < lit ? 'was' : i === lit ? 'now' : 'next'}>
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
