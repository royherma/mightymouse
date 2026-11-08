import { Check, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActionCardPayload,
  ActionResultPayload,
  ActionStepPayload
} from '../../../shared/action-engine'
import { COMPUTER_USE_ACTION_ID } from '../../../shared/action-engine'
import { ActionRows } from './ActionRows'
import { Button } from './Button'

const RESULT_GLYPH_SIZE = 13

/** How long the outcome line stays before the section clears itself. Long
 *  enough to read one sentence, short enough that the card it lives in is not
 *  held open by a result nobody is looking at any more. */
const RESULT_LINGER_MS = 2400

const MS_PER_SECOND = 1000
const STEPS_RESULT_LINGER_MS = 8000
const ELAPSED_TICK_MS = 100

/** The card arrives while the voice window is still showing its skeleton, and
 *  this component is not mounted during that branch — so a plain subscribe in
 *  an effect misses it and the row never appears. Subscribing at module load
 *  catches it either way; a mount that comes later replays what was held. */
let held: ActionCardPayload | null = null
let heldResult: ActionResultPayload | null = null
let heldSteps: ActionStepPayload[] = []
let heldBusyId = ''
let heldRanId = ''
let heldStartedAt = 0
let heldTotalMs = 0
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

if (typeof window !== 'undefined' && window.api?.onActionCardShow) {
  window.api.onActionCardShow((payload) => {
    held = payload
    heldResult = null
    heldSteps = []
    heldBusyId = ''
    heldRanId = ''
    notify()
  })
  window.api.onActionResult((payload) => {
    heldResult = payload
    if (heldBusyId !== '') heldTotalMs = Date.now() - heldStartedAt
    heldBusyId = ''
    notify()
  })
  window.api.onActionStep((payload: ActionStepPayload) => {
    if (held?.runId !== payload.runId) return
    heldSteps = [...heldSteps.filter((s) => s.step !== payload.step), payload]
    notify()
  })
  // The card window is hidden and reused, not destroyed, so these module
  // globals outlive it: the next voice note mounted on the PREVIOUS run's
  // proposals and showed them until its own card landed 1-3s later.
  window.api.onVoiceRouteReset?.(() => {
    held = null
    heldResult = null
    heldSteps = []
    heldBusyId = ''
    heldRanId = ''
    heldStartedAt = 0
    heldTotalMs = 0
    notify()
  })
}

export interface ActionsSectionProps {
  /** Shown above the rows. Omitted where the host card already says what this
   *  is, which is why there is no default. */
  heading?: string
  onActive?: (active: boolean) => void
  persist?: boolean
  onClose?: () => void
}

export function ActionsSection({
  heading,
  onActive,
  persist,
  onClose
}: ActionsSectionProps): React.JSX.Element | null {
  const [card, setCard] = useState<ActionCardPayload | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [busyId, setBusyId] = useState('')
  const [result, setResult] = useState<ActionResultPayload | null>(null)
  const [ranId, setRanId] = useState('')
  const [steps, setSteps] = useState<ActionStepPayload[]>([])
  const [stopping, setStopping] = useState(false)
  const [cmdHeld, setCmdHeld] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const stepsBox = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = stepsBox.current
    if (box) box.scrollTop = box.scrollHeight
  }, [steps])

  useEffect(() => {
    const sync = (): void => {
      if (heldResult) {
        if (held) setCard(held)
        setRanId(heldRanId)
        setBusyId('')
        setStopping(false)
        setResult(heldResult)
        setSteps(heldSteps)
        return
      }
      setSteps(heldSteps)
      if (!held) return
      setCard(held)
      // The ranking already decided; pre-select whatever it marked, and fall
      // back to the top row so the card is never a list with nothing chosen.
      const pick = held.proposals.find((p) => p.preselected) ?? held.proposals[0]
      const offered = held.proposals
      setSelectedId((current) =>
        offered.some((p) => p.proposalId === current) ? current : (pick?.proposalId ?? '')
      )
      setBusyId(heldBusyId)
      setRanId(heldRanId)
      if (heldBusyId === '') setStopping(false)
      setResult(null)
    }
    listeners.add(sync)
    sync()
    return () => {
      listeners.delete(sync)
    }
  }, [])

  const active = card !== null || result !== null
  useEffect(() => {
    onActive?.(active)
  }, [active, onActive])

  const runIsComputerUse =
    card?.proposals.find((p) => p.proposalId === ranId)?.actionId === COMPUTER_USE_ACTION_ID
  const showSteps = runIsComputerUse && (busyId !== '' || (result !== null && steps.length > 0))

  useEffect(() => {
    if (busyId === '') return
    const timer = setInterval(() => setElapsedMs(Date.now() - heldStartedAt), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [busyId])

  useEffect(() => {
    if (!result || persist) return
    const timer = setTimeout(
      () => {
        held = null
        heldResult = null
        heldSteps = []
        setResult(null)
        setCard(null)
        setSelectedId('')
        setRanId('')
        setSteps([])
      },
      runIsComputerUse ? STEPS_RESULT_LINGER_MS : RESULT_LINGER_MS
    )
    return () => clearTimeout(timer)
  }, [result, persist, runIsComputerUse])

  const confirm = useCallback(
    (proposalId: string): void => {
      if (!card || busyId !== '') return
      heldResult = null
      heldSteps = []
      heldBusyId = proposalId
      heldRanId = proposalId
      heldStartedAt = Date.now()
      heldTotalMs = 0
      setResult(null)
      setSteps([])
      setElapsedMs(0)
      setBusyId(proposalId)
      setRanId(proposalId)
      setStopping(false)
      window.api.actionRun(card.runId, proposalId)
    },
    [card, busyId]
  )

  const stop = useCallback((): void => {
    if (!card || stopping) return
    setStopping(true)
    window.api.actionStop(card.runId)
  }, [card, stopping])

  // This window is focusable:false, so it receives no keydown of its own — main
  // watches the physical modifiers and pushes the held state here. The ⌘⌥⇧1/2/3
  // run itself happens in main too (capture-hotkey.ts); this only draws them.
  useEffect(() => window.api.onActionChordMods(setCmdHeld), [])

  const changeChip = useCallback(
    (proposalId: string, slotKey: string, value: string): void => {
      if (!card || busyId !== '') return
      window.api.actionSetSlot(card.runId, proposalId, slotKey, value)
      const next: ActionCardPayload = {
        ...card,
        proposals: card.proposals.map((p) =>
          p.proposalId === proposalId
            ? {
                ...p,
                chips: p.chips.map((c) =>
                  c.key === slotKey
                    ? {
                        ...c,
                        value,
                        confidence: undefined
                      }
                    : c
                )
              }
            : p
        )
      }
      // `held` is what a remount re-reads: updating state alone makes the chip
      // snap back to the model's pick the next time the card syncs.
      held = next
      setCard(next)
      setSelectedId(proposalId)
    },
    [card, busyId]
  )

  const dismiss = useCallback((): void => {
    if (!card) return
    // Main clears the run off whichever proposal it is handed, so the selected
    // one stands in for the card. Without an id it would keep the run pending
    // and the outcome would log as 'ignored' rather than a real dismissal.
    if (selectedId !== '') window.api.actionDismiss(card.runId, selectedId)
    held = null
    heldResult = null
    heldSteps = []
    setCard(null)
    setSelectedId('')
    setRanId('')
    setSteps([])
  }, [card, selectedId])

  const close = useCallback((): void => {
    held = null
    heldResult = null
    heldSteps = []
    setCard(null)
    setResult(null)
    setSelectedId('')
    setRanId('')
    setSteps([])
    onClose?.()
  }, [onClose])

  if (!card || card.proposals.length === 0) return null

  return (
    <div className="actions-section">
      {heading !== undefined && (
        <div className="actions-head">
          <span className="actions-label">{heading}</span>
          <Button variant="bare" className="actions-hint actrow-more" onClick={dismiss}>
            Not now
          </Button>
        </div>
      )}
      {/* Keyed on the run so a new ranking re-folds the list: expanding once
          would otherwise leave every later card opened on rows nobody asked
          to see. */}
      <ActionRows
        key={card.runId}
        proposals={card.proposals}
        selectedId={selectedId}
        busyId={busyId}
        doneId={result ? ranId : ''}
        doneOk={result?.ok === true}
        stopping={stopping}
        showNumbers={cmdHeld}
        onSelect={setSelectedId}
        onConfirm={confirm}
        onChipChange={changeChip}
        onClose={onClose ? close : undefined}
        onStop={stop}
      />
      {showSteps && (
        <div className="actions-steps-total">
          <span>{busyId !== '' ? 'Working' : 'Took'}</span>
          <span className="actions-steps-time">
            {((busyId !== '' ? elapsedMs : heldTotalMs) / MS_PER_SECOND).toFixed(1)} s
          </span>
        </div>
      )}
      {showSteps && (
        <div className="actions-steps" ref={stepsBox}>
          {steps
            .filter((s) => busyId !== '' || s.pending !== true)
            .map((s) => (
              <div key={s.step} className={`actions-steps-line${s.pending ? ' is-pending' : ''}`}>
                <span className="actions-steps-text">
                  {s.step}. {s.line}
                </span>
                {s.ms !== undefined && (
                  <span className="actions-steps-time">{(s.ms / MS_PER_SECOND).toFixed(1)} s</span>
                )}
              </div>
            ))}
        </div>
      )}
      {result && (
        <div className={`actions-result${result.ok ? '' : ' is-fail'}`}>
          <span className="actions-result-glyph">
            {result.ok ? (
              <Check size={RESULT_GLYPH_SIZE} strokeWidth={3} />
            ) : (
              <X size={RESULT_GLYPH_SIZE} strokeWidth={3} />
            )}
          </span>
          <span className="actions-result-text">
            {result.line !== '' ? result.line : result.ok ? 'Done' : "That didn't work"}
          </span>
        </div>
      )}
      {result?.detail && (
        <div className="actions-steps-total">
          <span>{result.detail}</span>
        </div>
      )}
    </div>
  )
}
