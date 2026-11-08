import { useEffect, useRef, useState } from 'react'
import { Check, Mic, Pencil, X } from 'lucide-react'
import {
  DECISION_ANGLES,
  DECISION_ANGLE_HINT,
  DECISION_ANGLE_LABEL,
  anglesByWeight,
  historyLine,
  radarPoints,
  winsLine,
  youLine,
  type DecisionWire
} from '@shared/decision-score'
import type { AgentRelaySessionInfo } from '@shared/types'
import type { RelayRequestWire, RelayResponseWire } from '@shared/phone-remote-protocol'
import { WaitingTime } from '../RelayCard'
import { ProjectMark } from '../SessionDetail'
import { hapticTick } from '../haptics'
import type { ComposerMic } from './Composer'
import { MediaViewer } from './MediaViewer'
import { Button } from '@shared/ui/Button'

const KEYS = ['A', 'B', 'C', 'D']
const DOUBLE_TAP_MS = 450
const SHORT_LABEL_CHARS = 24
const RADAR = { w: 326, h: 262, cx: 163, cy: 134, r: 88, labelR: 128 }
const STARTERS = [
  { text: 'Do A, but…', value: 'Do A, but ' },
  { text: 'Do B, but…', value: 'Do B, but ' },
  { text: 'Not yet, ask me tomorrow', value: 'Not yet, ask me again tomorrow' },
  { text: 'Show me more first', value: 'Show me more before I decide: ' }
]

function short(label: string): string {
  return label.length > SHORT_LABEL_CHARS ? `${label.slice(0, SHORT_LABEL_CHARS - 1).trimEnd()}…` : label
}

function tagsFor(i: number, d: DecisionWire): { text: string; kind: 'rec' | 'you' | 'both' }[] {
  const agree = d.youIdx === d.best
  if (i === d.best && agree) return [{ text: 'Recommended · You usually', kind: 'both' }]
  const tags: { text: string; kind: 'rec' | 'you' | 'both' }[] = []
  if (i === d.best) tags.push({ text: 'Recommended', kind: 'rec' })
  if (i === d.youIdx) tags.push({ text: 'You usually pick this', kind: 'you' })
  return tags
}

export function ScoredAsk(props: {
  request: RelayRequestWire
  decision: DecisionWire
  session?: AgentRelaySessionInfo
  mic?: ComposerMic
  imageSrc: (requestId: string) => string
  onRespond: (requestId: string, response: RelayResponseWire) => void
  onOpenSession?: () => void
}): React.JSX.Element {
  const { request, decision: d, session, mic } = props
  const options = request.params.options ?? []
  const project = session?.project?.name ?? request.params.from ?? 'the agent'
  const agree = d.youIdx === d.best
  const [picked, setPicked] = useState(d.best)
  const [custom, setCustom] = useState(false)
  const [txt, setTxt] = useState('')
  const [why, setWhy] = useState(false)
  const [viewing, setViewing] = useState(false)
  const [cmpPick, setCmpPick] = useState(-1)
  const [sent, setSent] = useState<string | null>(null)
  const lastTap = useRef({ i: -1, at: 0 })

  const respond = (response: RelayResponseWire, shown: string | null): void => {
    hapticTick()
    setSent(shown)
    props.onRespond(request.id, response)
  }
  const sendChoice = (i: number): void => respond({ answer: options[i], via: 'chip' }, options[i])
  const send = (): void => {
    if (!custom) return sendChoice(picked)
    if (txt.trim()) respond({ answer: txt.trim(), via: 'typed' }, txt.trim())
  }
  const tap = (i: number): void => {
    const now = Date.now()
    if (lastTap.current.i === i && now - lastTap.current.at < DOUBLE_TAP_MS) return sendChoice(i)
    hapticTick()
    lastTap.current = { i, at: now }
    setPicked(i)
    setCustom(false)
  }

  const patch = mic?.draftPatch
  const consumeRef = useRef(mic?.onDraftConsumed)
  consumeRef.current = mic?.onDraftConsumed
  useEffect(() => {
    if (patch == null) return
    setTxt((prev) => (prev.trim() ? `${prev.trimEnd()} ${patch}` : patch))
    consumeRef.current?.()
  }, [patch])

  const [micEl, setMicEl] = useState<HTMLButtonElement | null>(null)
  const onMicDown = mic?.onMicDown
  const onMicUp = mic?.onMicUp
  useEffect(() => {
    if (!micEl || !onMicDown || !onMicUp) return
    const down = (e: PointerEvent): void => {
      e.preventDefault()
      hapticTick()
      onMicDown()
    }
    const up = (e: PointerEvent): void => {
      e.preventDefault()
      onMicUp()
    }
    micEl.addEventListener('pointerdown', down, { passive: false })
    micEl.addEventListener('pointerup', up)
    micEl.addEventListener('pointercancel', up)
    return () => {
      micEl.removeEventListener('pointerdown', down)
      micEl.removeEventListener('pointerup', up)
      micEl.removeEventListener('pointercancel', up)
    }
  }, [micEl, onMicDown, onMicUp])

  if (sent !== null) {
    return (
      <div className="aiDc aiDcSent" data-request-id={request.id}>
        <div className="aiDcSentMarks">
          <span className="aiDcSentCheck">
            <Check size={22} strokeWidth={2.5} />
          </span>
          <ProjectMark project={session?.project} size={44} />
        </div>
        <div className="aiDcSentTitle">Sent to {project}</div>
        {sent && <div className="aiDcSentQuote">“{sent}”</div>}
        <div className="aiDcMuted">Typed into the agent&apos;s terminal. It&apos;s working again.</div>
      </div>
    )
  }

  const pct = d.pcts[d.best]
  const order = d.totals.map((_, i) => i).sort((a, b) => d.totals[b] - d.totals[a])
  const cmp = cmpPick >= 0 ? cmpPick : agree || d.youIdx === undefined ? order[1] : d.youIdx
  const cmpIsYou = cmp === d.youIdx && !agree
  const byWeight = anglesByWeight(d.weights)
  const col = byWeight.map((a) => DECISION_ANGLES.indexOf(a))
  const valuesOf = (i: number): number[] => col.map((ai) => d.scores[i][ai])
  const poly = (vals: number[], r = RADAR.r): string =>
    radarPoints(vals, RADAR.cx, RADAR.cy, r)
      .map((p) => p.join(','))
      .join(' ')
  const labelAt = radarPoints([100, 100, 100, 100, 100], RADAR.cx, RADAR.cy, RADAR.labelR)
  const spokes = radarPoints([100, 100, 100, 100, 100], RADAR.cx, RADAR.cy, RADAR.r)
  const keys = KEYS.slice(0, options.length)
  const blue = [historyLine(d), youLine(d, keys)].filter(Boolean).join(' ')

  return (
    <div className="aiDc" data-request-id={request.id}>
      {request.params.hasImage && !why && (
        <Button variant="bare" type="button" className="aiDcPhotoBtn" aria-label="View the picture" onClick={() => setViewing(true)}>
          <img
            className="aiDcPhoto"
            data-small={custom ? '' : undefined}
            src={props.imageSrc(request.id)}
            alt={request.params.caption ?? 'From your agent'}
          />
        </Button>
      )}
      {viewing && (
        <MediaViewer
          media={[{ key: request.id, src: props.imageSrc(request.id), name: request.params.caption ?? 'From your agent' }]}
          index={0}
          onClose={() => setViewing(false)}
        />
      )}
      <div className="aiDcBody">
        <div className="aiDcFrom">
          <ProjectMark project={session?.project} size={26} />
          <span>
            <b>{project}</b>
            {session?.model ? ` · ${session.model}` : ''}
          </span>
          <WaitingTime request={request} />
        </div>
        <div className="aiDcQ">{request.params.question}</div>
        {request.params.context && <div className="aiDcContext">{request.params.context}</div>}
        {props.onOpenSession && !why && (
          <Button variant="bare" type="button" className="aiDcLink" onClick={props.onOpenSession}>
            Read the whole conversation ›
          </Button>
        )}

        {!why ? (
          <div className="aiDcList">
            {agree && !custom && (
              <div className="aiDcAgree">
                <span className="aiDcAgreeDots" aria-hidden="true">
                  <i />
                  <i />
                </span>
                <b>You and the model agree on {KEYS[d.best]}.</b>
              </div>
            )}
            {!custom && !agree && <div className="aiDcHint">Tap to choose · double-tap to send</div>}
            {options.map((label, i) => {
              const on = !custom && picked === i
              const tags = tagsFor(i, d)
              return (
                <Button
                  variant="bare"
                  key={`${i}:${label}`}
                  type="button"
                  className="aiDcRoute"
                  aria-pressed={on}
                  data-dim={custom ? '' : undefined}
                  onClick={() => tap(i)}
                >
                  <span
                    className="aiDcFill"
                    data-best={i === d.best ? (agree ? 'both' : '') : undefined}
                    style={{ width: `${d.pcts[i]}%` }}
                  />
                  <span className="aiDcRouteRow">
                    <span className="aiDcKey">{KEYS[i]}</span>
                    <span className="aiDcRouteText">
                      <span className="aiDcRouteLabel">{label}</span>
                      {tags.length > 0 && (
                        <span className="aiDcTags">
                          {tags.map((t) => (
                            <span key={t.text} className="aiDcTag" data-kind={t.kind}>
                              {t.text}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    {i === d.best && (
                      <span className="aiDcPct" data-best="">
                        {d.pcts[i]}%<small>sure</small>
                      </span>
                    )}
                  </span>
                </Button>
              )
            })}
            {!custom ? (
              <>
                <Button variant="bare" type="button" className="aiDcElse" onClick={() => setCustom(true)}>
                  <Pencil size={16} strokeWidth={1.8} />
                  <span>Something else…</span>
                  <small>type or say it</small>
                </Button>
                <Button variant="bare" type="button" className="aiDcLink" onClick={() => setWhy(true)}>
                  Why {pct}%? See how it decided
                </Button>
              </>
            ) : (
              <div className="aiDcCustom">
                <div className="aiDcCustomHead">
                  <span>Tell {project} something else</span>
                  <Button
                    variant="bare"
                    type="button"
                    aria-label="Close"
                    onClick={() => {
                      setCustom(false)
                      setTxt('')
                    }}
                  >
                    <X size={14} strokeWidth={2} />
                  </Button>
                </div>
                <div className="aiDcCustomBox">
                  <textarea
                    autoFocus
                    value={txt}
                    onChange={(e) => setTxt(e.target.value)}
                    placeholder={
                      mic?.recording ? 'Listening…' : mic?.dictating ? 'Writing it down…' : 'What should it do instead?'
                    }
                  />
                  {mic && (
                    <Button
                      variant="bare"
                      ref={setMicEl}
                      type="button"
                      className="aiDcMic"
                      data-on={mic.recording ? '' : undefined}
                      aria-label="Hold to talk"
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      <Mic size={17} strokeWidth={2.2} />
                    </Button>
                  )}
                </div>
                <span className="aiDcMuted">Start from one of these, or hold the mic and talk</span>
                <div className="aiDcStarters">
                  {STARTERS.map((s) => (
                    <Button variant="bare" key={s.text} type="button" onClick={() => setTxt(s.value)}>
                      {s.text}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="aiDcWhy">
            <div className="aiDcMini">
              {options.map((label, i) => (
                <div key={i}>
                  <span
                    className="aiDcKeySmall"
                    data-kind={i === d.best ? 'rec' : i === cmp ? (cmpIsYou ? 'you' : 'cmp') : undefined}
                  >
                    {KEYS[i]}
                  </span>
                  <span className="aiDcMiniLabel">{label}</span>
                  <b>{d.pcts[i]}%</b>
                </div>
              ))}
            </div>

            <div className="aiDcRadarBand">
              <span className="aiDcH">
                {KEYS[d.best]} vs {KEYS[cmp]} on what matters
              </span>
              <div className="aiDcRadar">
                <svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} aria-hidden="true">
                  {[25, 50, 75, 100].map((v) => (
                    <polygon key={v} className="aiDcRing" points={poly([v, v, v, v, v])} />
                  ))}
                  {spokes.map(([x, y], i) => (
                    <line key={i} className="aiDcRing" x1={RADAR.cx} y1={RADAR.cy} x2={x} y2={y} />
                  ))}
                  <polygon className="aiDcShape" data-kind={cmpIsYou ? 'you' : 'cmp'} points={poly(valuesOf(cmp))} />
                  <polygon className="aiDcShape" data-kind="rec" points={poly(valuesOf(d.best))} />
                  {radarPoints(valuesOf(d.best), RADAR.cx, RADAR.cy, RADAR.r).map(([x, y], i) => (
                    <circle key={i} className="aiDcDot" cx={x} cy={y} r={4} />
                  ))}
                </svg>
                {byWeight.map((a, i) => (
                  <span
                    key={a}
                    className="aiDcRadarLabel"
                    style={{ left: `${(labelAt[i][0] / RADAR.w) * 100}%`, top: `${(labelAt[i][1] / RADAR.h) * 100}%` }}
                  >
                    <b>{DECISION_ANGLE_LABEL[a]}</b>
                    <small>matters {d.weights[a]}%</small>
                  </span>
                ))}
              </div>
              <div className="aiDcLegend">
                <span>
                  <i data-kind={agree ? 'both' : 'rec'} />
                  <b>{KEYS[d.best]}</b> {agree ? 'Recommended · You usually' : 'Recommended'}
                </span>
                <span>
                  <i data-kind={cmpIsYou ? 'you' : 'cmp'} />
                  <b>{KEYS[cmp]}</b> {cmpIsYou ? 'You usually' : cmp === order[1] ? 'Next best' : short(options[cmp])}
                </span>
              </div>
              <div className="aiDcCompare">
                <span>Compare {KEYS[d.best]} with</span>
                {options.map((_, i) =>
                  i === d.best ? null : (
                    <Button variant="bare" key={i} type="button" aria-pressed={i === cmp} onClick={() => setCmpPick(i)}>
                      {KEYS[i]}
                    </Button>
                  )
                )}
              </div>
              <span className="aiDcRadarLine">Bigger shape = better. {winsLine(d, cmp, keys)}</span>
            </div>

            <div>
              <div className="aiDcH">How it got to {pct}%</div>
              <div className="aiDcMuted">
                Each choice is scored 0-100 on five things. The % next to each thing is how much it matters for this
                decision.
              </div>
            </div>

            <div className="aiDcTable">
              <div className="aiDcTr aiDcTh">
                <span className="aiDcTName">What matters</span>
                {options.map((_, i) => (
                  <span key={i} className="aiDcTd">
                    {KEYS[i]}
                  </span>
                ))}
              </div>
              {byWeight.map((a) => {
                const ai = DECISION_ANGLES.indexOf(a)
                const colVals = d.scores.map((row) => row[ai])
                const hi = Math.max(...colVals)
                return (
                  <div key={a} className="aiDcTr">
                    <span className="aiDcTName">
                      <b>
                        {DECISION_ANGLE_LABEL[a]} <small>· {d.weights[a]}%</small>
                      </b>
                      <small>{d.notes?.[a] ?? DECISION_ANGLE_HINT[a]}</small>
                    </span>
                    {colVals.map((v, i) => (
                      <span
                        key={i}
                        className="aiDcTd"
                        data-hi={v === hi ? '' : undefined}
                        data-best={i === d.best ? '' : undefined}
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                )
              })}
              <div className="aiDcTr aiDcTotal">
                <span className="aiDcTName">Score</span>
                {d.totals.map((t, i) => (
                  <span key={i} className="aiDcTd" data-best={i === d.best ? '' : undefined}>
                    {Math.round(t)}
                  </span>
                ))}
              </div>
            </div>

            <div className="aiDcLead">
              {KEYS[d.best]} leads by {d.lead} points. A lead that size means {pct}% sure. A tie would be an even
              split.
            </div>
            {blue && (
              <div className="aiDcHistory">
                <i />
                <span>{blue}</span>
              </div>
            )}
            <Button variant="bare" type="button" className="aiDcLink" onClick={() => setWhy(false)}>
              Back to the choices
            </Button>
          </div>
        )}
      </div>
      <div className="aiDcBar">
        <Button variant="bare" type="button" className="aiDcLater" onClick={() => respond({ dismissed: true, via: 'dismiss' }, '')}>
          Skip
        </Button>
        <Button
          variant="bare"
          type="button"
          className="aiDcSend"
          data-kind={custom ? (txt.trim() ? 'typed' : 'empty') : undefined}
          disabled={custom && !txt.trim()}
          onClick={send}
        >
          {custom
            ? txt.trim()
              ? 'Send what I typed'
              : 'Type or say something'
            : `Send ${KEYS[picked]}`}
        </Button>
      </div>
    </div>
  )
}
