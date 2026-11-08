import { useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Building2,
  Circle,
  Code2,
  Compass,
  FileCode2,
  FlaskConical,
  Handshake,
  HeartHandshake,
  Landmark,
  Link2,
  Megaphone,
  Play,
  Plus,
  Scissors,
  Terminal,
  TrendingUp,
  X,
  type LucideIcon
} from 'lucide-react'
import {
  FACTORY_AREAS,
  type AcceptanceLine,
  type FactoryArea,
  type FactoryGroup,
  type FactoryTask
} from '../../../shared/factory'
import { Button } from './Button'
import { FactoryFiles } from './FactoryFiles'

export const AREA_ICON: Record<FactoryArea, LucideIcon> = {
  product: Compass,
  engineering: Code2,
  data: BarChart3,
  marketing: Megaphone,
  sales: Handshake,
  customers: HeartHandshake,
  company: Building2
}

export const GROUP_ICON: Record<FactoryGroup, LucideIcon> = {
  rd: FlaskConical,
  sm: TrendingUp,
  ga: Landmark
}

export function AreaTag({ area, kind }: { area: FactoryArea; kind?: string }): React.JSX.Element {
  const Icon = AREA_ICON[area]
  return (
    <span className="factory-area-tag">
      <Icon size={11} /> {FACTORY_AREAS[area].label}
      {kind && ` · ${kind}`}
    </span>
  )
}

type Patch = {
  title?: string
  outcome?: string
  acceptance?: AcceptanceLine[]
  scope?: string[]
  dependsOn?: string[]
  area?: string
  kind?: string
}

export function FactoryDraft({
  draft,
  busy,
  canUp,
  canDown,
  onSave,
  onUp,
  onDown,
  onSplit,
  onQueue,
  onReject
}: {
  draft: FactoryTask
  busy: boolean
  canUp: boolean
  canDown: boolean
  onSave: (patch: Patch) => void
  onUp: () => void
  onDown: () => void
  onSplit: () => void
  onQueue: () => void
  onReject: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState(draft.title)
  const [outcome, setOutcome] = useState(draft.outcome)
  const [acceptance, setAcceptance] = useState(draft.acceptance)
  const [fileInput, setFileInput] = useState('')
  const saveChecks = (next: AcceptanceLine[]): void => {
    setAcceptance(next)
    onSave({ acceptance: next.filter((item) => item.text.trim()) })
  }
  const editCheck = (index: number, patch: Partial<AcceptanceLine>): AcceptanceLine[] =>
    acceptance.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
  const addFile = (): void => {
    const path = fileInput.trim()
    setFileInput('')
    if (path && !draft.scope.includes(path)) onSave({ scope: [...draft.scope, path] })
  }

  return (
    <article className="factory-draft" aria-label={`Idea: ${draft.title}`}>
      <input
        className="factory-draft-title"
        aria-label="Task title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (title.trim() && title !== draft.title) onSave({ title: title.trim() })
        }}
      />
      <textarea
        className="factory-draft-outcome"
        aria-label="What changes"
        rows={3}
        value={outcome}
        onChange={(event) => setOutcome(event.target.value)}
        onBlur={() => {
          if (outcome.trim() && outcome !== draft.outcome) onSave({ outcome: outcome.trim() })
        }}
      />
      {(draft.oversized || draft.duplicateOf) && (
        <p className="factory-draft-warn">
          <AlertTriangle size={14} />
          {draft.oversized ? 'Too big to run. Split it first.' : `Similar to ${draft.duplicateOf}`}
          {draft.oversized && (
            <Button variant="ghost" className="ml-auto" disabled={busy} onClick={onSplit}>
              <Scissors size={13} /> Split
            </Button>
          )}
        </p>
      )}

      <section className="factory-decide">
        <p className="factory-decide-head">Build this?</p>
        <div className="factory-area-pills" role="radiogroup" aria-label="Area">
          {(Object.keys(FACTORY_AREAS) as FactoryArea[]).map((area) => {
            const Icon = AREA_ICON[area]
            return (
              <Button
                key={area}
                variant="bare"
                role="radio"
                aria-checked={draft.area === area}
                className="factory-area-pill"
                onClick={() => draft.area !== area && onSave({ area, kind: '' })}
              >
                <Icon size={13} /> {FACTORY_AREAS[area].label}
              </Button>
            )
          })}
        </div>
        <div className="factory-decide-actions">
          <Button
            className="factory-cta"
            disabled={busy || draft.oversized || !draft.area}
            title={draft.area ? undefined : 'Pick where it goes first'}
            onClick={onQueue}
          >
            <Play size={16} /> {draft.area ? 'Build it' : 'Pick where it goes'}
          </Button>
          <Button variant="ghost" className="factory-cta" disabled={busy} onClick={onReject}>
            <X size={16} /> Skip
          </Button>
        </div>
      </section>

      <details className="factory-more">
        <summary>Edit details</summary>
        {draft.area && (
          <section className="factory-draft-block">
            <h3>Kind</h3>
            <select
              aria-label="Kind"
              value={draft.kind}
              onChange={(event) => onSave({ kind: event.target.value })}
            >
              <option value="">Any kind</option>
              {FACTORY_AREAS[draft.area].kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </section>
        )}

        <section className="factory-draft-block">
          <h3>Done when</h3>
          <ul className="factory-checks">
            {acceptance.map((line, index) => (
              <li key={`${draft.id}-${index}`}>
                <Circle size={14} className="factory-check-dot" />
                <span className="factory-check-fields">
                  <input
                    aria-label="Check"
                    placeholder="What must be true"
                    value={line.text}
                    onChange={(event) =>
                      setAcceptance(editCheck(index, { text: event.target.value }))
                    }
                    onBlur={(event) => saveChecks(editCheck(index, { text: event.target.value }))}
                  />
                  <span className="factory-check-command">
                    <Terminal size={12} />
                    <input
                      aria-label="Check command"
                      placeholder="Command (optional)"
                      value={line.command}
                      onChange={(event) =>
                        setAcceptance(editCheck(index, { command: event.target.value }))
                      }
                      onBlur={(event) =>
                        saveChecks(editCheck(index, { command: event.target.value }))
                      }
                    />
                  </span>
                </span>
                <Button
                  variant="bare"
                  className="factory-row-x"
                  aria-label="Remove check"
                  onClick={() =>
                    saveChecks(acceptance.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  <X size={14} />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="bare"
            className="factory-add"
            onClick={() => setAcceptance((current) => [...current, { text: '', command: '' }])}
          >
            <Plus size={14} /> Add a check
          </Button>
        </section>

        <section className="factory-draft-block">
          <h3>Code it touches</h3>
          <div className="factory-chips">
            {draft.scope.map((path) => (
              <span key={path} className="factory-chip" title={path}>
                <FileCode2 size={13} />
                {path.split('/').at(-1)}
                <Button
                  variant="bare"
                  aria-label={`Remove ${path}`}
                  onClick={() => onSave({ scope: draft.scope.filter((item) => item !== path) })}
                >
                  <X size={12} />
                </Button>
              </span>
            ))}
            <input
              className="factory-chip-input"
              aria-label="Add a file"
              placeholder="+ file path"
              value={fileInput}
              onChange={(event) => setFileInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addFile()
              }}
              onBlur={addFile}
            />
          </div>
          {draft.dependsOn.length > 0 && (
            <div className="factory-chips mt-2">
              {draft.dependsOn.map((id) => (
                <span key={id} className="factory-chip" data-muted="">
                  <Link2 size={13} /> Waits on {id}
                </span>
              ))}
            </div>
          )}
        </section>

        <FactoryFiles key={draft.id} task={draft} />

        <div className="factory-decide-links">
          <Button variant="bare" disabled={busy || !canUp} onClick={onUp}>
            <ArrowUp size={14} /> Move up
          </Button>
          <Button variant="bare" disabled={busy || !canDown} onClick={onDown}>
            <ArrowDown size={14} /> Move down
          </Button>
          <Button variant="bare" disabled={busy} onClick={onSplit}>
            <Scissors size={14} /> Split in two
          </Button>
        </div>
      </details>
    </article>
  )
}
