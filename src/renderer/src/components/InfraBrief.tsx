import { useId, useState } from 'react'
import type { JSX } from 'react'
import { Check } from 'lucide-react'
import {
  briefSentence,
  cleanBrief,
  type InfraRecord,
  type ProjectBrief
} from '../../../shared/infra'
import { goalText, nichesFor } from '../../../shared/playbooks'
import {
  BRIEF_WORDS as W,
  defaultGoalDay,
  goalChoices,
  goalFrom,
  goalUnit,
  likeYours
} from '../../../shared/brief'
import { Button } from './Button'

type Open = 'lines' | 'goal' | null

export function BriefRows({
  projectId,
  record
}: {
  projectId: string
  record: InfraRecord
}): JSX.Element {
  const listId = useId()
  const brief = record.brief
  const types = record.business ?? []
  const [open, setOpen] = useState<Open>(null)
  const [failed, setFailed] = useState(false)
  const [what, setWhat] = useState('')
  const [audience, setAudience] = useState('')
  const [niche, setNiche] = useState('')
  const [goalId, setGoalId] = useState('')
  const [target, setTarget] = useState('')
  const [by, setBy] = useState('')
  const choices = goalChoices(types, brief?.niche)
  const picked = choices.find((c) => c.id === goalId) ?? choices[0]

  function edit(which: Exclude<Open, null>): void {
    setFailed(false)
    setWhat(brief?.what ?? '')
    setAudience(brief?.audience ?? '')
    setNiche(brief?.niche ?? '')
    const current = choices.find((c) => c.id === brief?.goal?.metric) ?? choices[0]
    setGoalId(current.id)
    setTarget(String(brief?.goal?.target ?? current.target ?? ''))
    setBy(brief?.goal?.by ?? defaultGoalDay(new Date()))
    setOpen(which)
  }

  function pick(id: string): void {
    setGoalId(id)
    const choice = choices.find((c) => c.id === id)
    setTarget(choice?.target !== undefined ? String(choice.target) : '')
  }

  function save(next: ProjectBrief): void {
    setFailed(false)
    void window.api.infra
      .setBrief(projectId, cleanBrief(next) ?? {})
      .then((got) => (got.record ? setOpen(null) : setFailed(true)))
      .catch(() => setFailed(true))
  }

  const sentence = briefSentence(brief)
  const goal = goalText(brief)
  const fields = [
    [W.what, what, setWhat, undefined],
    [W.audience, audience, setAudience, undefined],
    [likeYours(types), niche, setNiche, listId]
  ] as const

  return (
    <>
      <div className="infra-tag-row" data-brief="lines">
        <span className="infra-kind">{W.audience}</span>
        <span className="infra-chips">
          {open === 'lines' ? (
            <span className="infra-brief-fields">
              {fields.map(([label, value, set, list]) => (
                <label key={label} className="infra-other">
                  <input
                    value={value}
                    list={list}
                    placeholder={label}
                    aria-label={label}
                    onChange={(e) => set(e.target.value)}
                  />
                </label>
              ))}
              <datalist id={listId}>
                {nichesFor(types).map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </span>
          ) : sentence ? (
            <span className="infra-brief-text">{sentence}</span>
          ) : (
            <span className="infra-empty">Not set yet</span>
          )}
          {open === 'lines' && failed && <span className="infra-empty">{W.failed}</span>}
        </span>
        <span className="infra-tag-side">
          {open === 'lines' && (
            <Button variant="bare" className="infra-link" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          )}
          <Button
            variant="bare"
            className="infra-link"
            onClick={() =>
              open === 'lines' ? save({ ...brief, what, audience, niche }) : edit('lines')
            }
          >
            {open === 'lines' ? 'Done' : W.change}
          </Button>
        </span>
      </div>
      <div className="infra-tag-row" data-brief="goal">
        <span className="infra-kind">{W.goal}</span>
        <span className="infra-chips">
          {open === 'goal' ? (
            <>
              {choices.map((c) => (
                <Button
                  key={c.id}
                  variant="bare"
                  className="infra-chip"
                  data-on={c.id === picked.id ? '' : undefined}
                  aria-pressed={c.id === picked.id}
                  title={c.hint}
                  onClick={() => pick(c.id)}
                >
                  {c.id === picked.id && <Check size={11} strokeWidth={2.5} />}
                  {c.label}
                  {c.typical && ` · ${c.typical}`}
                </Button>
              ))}
              {picked.target !== undefined && (
                <label className="infra-other infra-brief-aim">
                  {W.aim}
                  <input
                    type="number"
                    step="any"
                    value={target}
                    aria-label={`${W.aim} ${picked.label}`}
                    onChange={(e) => setTarget(e.target.value)}
                  />
                  {goalUnit(picked.id)} {W.by}
                  <input
                    type="date"
                    value={by}
                    aria-label={W.by}
                    onChange={(e) => setBy(e.target.value)}
                  />
                </label>
              )}
            </>
          ) : goal ? (
            <span className="infra-brief-text">{goal}</span>
          ) : (
            <span className="infra-empty">Not set yet</span>
          )}
          {open === 'goal' && failed && <span className="infra-empty">{W.failed}</span>}
        </span>
        <span className="infra-tag-side">
          {open === 'goal' && (
            <Button variant="bare" className="infra-link" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          )}
          <Button
            variant="bare"
            className="infra-link"
            onClick={() =>
              open === 'goal'
                ? save({ ...brief, goal: goalFrom(picked, target, by) })
                : edit('goal')
            }
          >
            {open === 'goal' ? W.setGoal : W.change}
          </Button>
        </span>
      </div>
    </>
  )
}
