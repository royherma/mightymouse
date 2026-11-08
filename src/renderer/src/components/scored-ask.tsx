import { useEffect, useRef, useState } from 'react'
import {
  DECISION_ANGLES,
  DECISION_ANGLE_HINT,
  DECISION_ANGLE_LABEL,
  anglesByWeight,
  historyLine,
  winsLine,
  youLine,
  type DecisionWire
} from '../../../shared/decision-score'
import type { RelayRequestWire, RelayResponseWire } from '../../../shared/phone-remote-protocol'
import { Button } from './Button'

const KEYS = ['A', 'B', 'C', 'D']
const HINT = '1-3 choose · double-click sends · Enter sends · Esc later'

function Tag({ kind, children }: { kind: 'rec' | 'you' | 'both'; children: string }): React.JSX.Element {
  const tone =
    kind === 'you'
      ? 'bg-blue/15 text-blue'
      : kind === 'both'
        ? 'bg-gradient-to-r from-accent to-blue text-white'
        : 'bg-accent text-white'
  return <span className={`rounded-full px-1.5 py-px text-micro font-semibold ${tone}`}>{children}</span>
}

export function ScoredAsk(props: {
  request: RelayRequestWire
  decision: DecisionWire
  onRespond: (requestId: string, response: RelayResponseWire) => void
}): React.JSX.Element {
  const { request, decision: d, onRespond } = props
  const options = request.params.options ?? []
  const keys = KEYS.slice(0, options.length)
  const agree = d.youIdx === d.best
  const [picked, setPicked] = useState(d.best)
  const [typed, setTyped] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body) rootRef.current?.focus()
  }, [])

  const send = (i: number): void => onRespond(request.id, { answer: options[i], via: 'chip' })
  const later = (): void => onRespond(request.id, { dismissed: true, via: 'dismiss' })

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.target instanceof HTMLTextAreaElement) return
    const n = Number(e.key)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      e.preventDefault()
      setPicked(n - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      send(picked)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      later()
    }
  }

  const byWeight = anglesByWeight(d.weights)
  const cmp = agree || d.youIdx === undefined ? d.totals.map((_, i) => i).sort((a, b) => d.totals[b] - d.totals[a])[1] : d.youIdx
  const blue = [historyLine(d), youLine(d, keys)].filter(Boolean).join(' ')
  const cell = (i: number, strong: boolean): string =>
    `w-10 text-center tabular-nums ${i === d.best ? 'bg-accent/10' : ''} ${strong ? 'font-bold text-on-surface' : 'text-muted'}`

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="flex flex-col gap-3 outline-none">
      <div className="text-lg font-semibold text-on-surface">{request.params.question}</div>
      {request.params.context && (
        <div className="border-l-2 border-surface3 pl-2.5 text-sm text-muted">{request.params.context}</div>
      )}
      <div className="grid gap-4 min-[900px]:grid-cols-2">
        <div className="flex flex-col gap-2">
          {agree && (
            <div className="rounded-md bg-gradient-to-r from-accent/10 to-blue/10 px-2.5 py-1.5 text-sm font-semibold text-on-surface">
              You and the model agree on {KEYS[d.best]}.
            </div>
          )}
          {options.map((label, i) => {
            const tags: { text: string; kind: 'rec' | 'you' | 'both' }[] =
              i === d.best && agree
                ? [{ text: 'Recommended · You usually', kind: 'both' }]
                : [
                    ...(i === d.best ? [{ text: 'Recommended', kind: 'rec' as const }] : []),
                    ...(i === d.youIdx ? [{ text: 'You usually', kind: 'you' as const }] : [])
                  ]
            return (
              <Button
                key={`${i}:${label}`}
                variant="bare"
                aria-pressed={picked === i}
                onClick={() => setPicked(i)}
                onDoubleClick={() => send(i)}
                className={`relative overflow-hidden rounded-md border text-left ${picked === i ? 'border-accent' : 'border-surface3'}`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 ${i === d.best ? (agree ? 'bg-gradient-to-r from-accent/20 to-blue/20' : 'bg-accent/15') : 'bg-on-surface/5'}`}
                  style={{ width: `${d.pcts[i]}%` }}
                />
                <span className="relative flex items-center gap-2.5 px-3 py-2">
                  <span
                    className={`grid h-6 w-6 flex-none place-items-center rounded-sm text-sm font-bold ${picked === i ? 'bg-accent text-white' : 'bg-surface3 text-muted'}`}
                  >
                    {KEYS[i]}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-md text-on-surface">{label}</span>
                    {tags.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {tags.map((t) => (
                          <Tag key={t.text} kind={t.kind}>
                            {t.text}
                          </Tag>
                        ))}
                      </span>
                    )}
                  </span>
                  <span
                    className={`flex-none tabular-nums font-semibold ${i === d.best ? 'text-lg text-accent-text' : 'text-md text-muted'}`}
                  >
                    {d.pcts[i]}%
                  </span>
                </span>
              </Button>
            )
          })}
          <textarea
            className="code-input"
            rows={1}
            value={typed}
            placeholder="Something else…"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && typed.trim()) {
                e.preventDefault()
                onRespond(request.id, { answer: typed.trim(), via: 'typed' })
              }
              if (e.key === 'Escape' && typed) {
                e.stopPropagation()
                setTyped('')
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={later}>
              Later
            </Button>
            <Button
              className="flex-1 truncate"
              onClick={() =>
                typed.trim() ? onRespond(request.id, { answer: typed.trim(), via: 'typed' }) : send(picked)
              }
            >
              {typed.trim() ? 'Send what I typed' : `Send ${KEYS[picked]}`}
            </Button>
          </div>
          <div className="text-xs text-muted">{HINT}</div>
        </div>

        <div className="flex flex-col gap-2 text-sm">
          <div className="font-semibold text-on-surface">How it got to {d.pcts[d.best]}%</div>
          <div className="overflow-hidden rounded-md border border-surface3">
            <div className="flex bg-surface2 font-semibold text-on-surface">
              <span className="flex-1 px-2.5 py-1.5">What matters</span>
              {keys.map((k, i) => (
                <span key={k} className={`${cell(i, false)} py-1.5`}>
                  {k}
                </span>
              ))}
            </div>
            {byWeight.map((a) => {
              const ai = DECISION_ANGLES.indexOf(a)
              const col = d.scores.map((row) => row[ai])
              const hi = Math.max(...col)
              return (
                <div key={a} className="flex items-stretch border-t border-surface3">
                  <span className="flex flex-1 flex-col px-2.5 py-1.5">
                    <span className="font-semibold text-on-surface">
                      {DECISION_ANGLE_LABEL[a]} <span className="font-normal text-muted">· {d.weights[a]}%</span>
                    </span>
                    <span className="text-xs text-muted">{d.notes?.[a] ?? DECISION_ANGLE_HINT[a]}</span>
                  </span>
                  {col.map((v, i) => (
                    <span key={i} className={`${cell(i, v === hi)} grid place-items-center`}>
                      {v}
                    </span>
                  ))}
                </div>
              )
            })}
            <div className="flex border-t border-surface3 bg-surface2 font-semibold">
              <span className="flex-1 px-2.5 py-1.5 text-on-surface">Score</span>
              {d.totals.map((t, i) => (
                <span key={i} className={`${cell(i, i === d.best)} py-1.5`}>
                  {Math.round(t)}
                </span>
              ))}
            </div>
            <div className="flex border-t border-surface3 font-semibold">
              <span className="flex-1 px-2.5 py-1.5 text-on-surface">How sure</span>
              {d.pcts.map((p, i) => (
                <span key={i} className={`${cell(i, i === d.best)} py-1.5`}>
                  {p}%
                </span>
              ))}
            </div>
          </div>
          <div className="text-muted">
            {KEYS[d.best]} leads by {d.lead} points. A lead that size means {d.pcts[d.best]}% sure. A tie would be an
            even split.
          </div>
          <div className="text-muted">{winsLine(d, cmp, keys)}</div>
          {blue && <div className="rounded-md bg-blue/10 px-2.5 py-2 text-blue">{blue}</div>}
        </div>
      </div>
    </div>
  )
}
