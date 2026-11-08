import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, ChevronDown, FileText, Paperclip, Sparkles, X } from 'lucide-react'
import { Button } from './Button'
import { HARNESS_NAME, ModelMenu } from './AgentModelPicker'
import { ProviderIcon } from './ProviderIcon'
import type { BrowserTaskModel, BrowserTaskModelsState, BrowserTaskResult } from '../../../shared/types'
import type { ModEdit } from './side-browser-mods'

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; line: string }
  | { kind: 'paused'; why: string }
  | { kind: 'done'; result: BrowserTaskResult }

interface Attached {
  path: string
  name: string
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function names(list: string[]): string {
  return list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`
}

const modelId = (m: BrowserTaskModel): string => `${m.source}:${m.model}`

function TaskModelMenu({
  models,
  onChange
}: {
  models: BrowserTaskModelsState
  onChange: (next: BrowserTaskModelsState) => void
}): JSX.Element {
  const { options, selected } = models
  const sources = [...new Set(options.map((o) => o.source))]
  const cloudName = options.find((o) => o.source === 'cloud')?.label ?? ''
  const icon = (source: BrowserTaskModel['source']): 'mightymouse' | 'claude' =>
    source === 'cloud' ? 'mightymouse' : 'claude'
  return (
    <ModelMenu
      groups={sources.map((s) => ({
        key: s,
        name: s === 'cloud' ? cloudName : `${HARNESS_NAME.claude} - your own plan, no credits`,
        icon: icon(s)
      }))}
      items={options.map((o) => ({
        id: modelId(o),
        group: o.source,
        label: o.label,
        sub: o.source === 'cloud' ? 'Uses your credits' : undefined,
        icon: icon(o.source)
      }))}
      selectedId={modelId(selected)}
      onPick={(id) => {
        const next = options.find((o) => modelId(o) === id)
        if (!next) return
        onChange({ options, selected: { source: next.source, model: next.model } })
        void window.api.sideBrowser.setTaskModel({ source: next.source, model: next.model }).then(onChange)
      }}
      align="right"
      searchable={false}
      ariaLabel="Model for this browser"
      title="The AI that does the work in this browser"
      triggerClassName="inline-flex w-fit max-w-[11rem] shrink-0 items-center gap-1.5 rounded-lg border border-surface3 bg-surface2 px-2 py-1 text-left text-xs font-medium text-on-surface hover:bg-surface1"
      trigger={
        <>
          <ProviderIcon id={icon(selected.source)} size={13} />
          <span className="min-w-0 truncate">
            {options.find((o) => modelId(o) === modelId(selected))?.label ?? selected.model}
          </span>
          <ChevronDown size={12} className="shrink-0 text-muted" strokeWidth={2.5} />
        </>
      }
    />
  )
}

function Outcome({ result }: { result: BrowserTaskResult }): JSX.Element {
  if (!result.ok) return <p className="side-browser-task-line" data-tone="bad">{result.reason}</p>
  if (result.kind === 'mod')
    return (
      <p className="side-browser-task-line" data-tone="good">
        {result.name}: {result.summary} Try it on the page, then keep it or undo it.
      </p>
    )
  if (result.kind === 'steps')
    return (
      <p className="side-browser-task-line" data-tone="good">
        {result.answer} ({result.steps} {result.steps === 1 ? 'step' : 'steps'}, {seconds(result.ms)})
      </p>
    )
  const check = [...result.unsure, ...result.failed, ...result.missing]
  return (
    <>
      <p className="side-browser-task-line" data-tone="good">
        Filled {result.filled.length} {result.filled.length === 1 ? 'field' : 'fields'} in{' '}
        {seconds(result.ms)}. Nothing was submitted.
      </p>
      {check.length > 0 && (
        <p className="side-browser-task-line" data-tone="warn">
          Check the ones outlined in yellow: {names(check)}
        </p>
      )}
    </>
  )
}

export function SideBrowserTask({
  viewId,
  tabIds,
  suggestion,
  edit,
  onClose,
  onShowTab
}: {
  viewId: string | undefined
  tabIds: string[]
  suggestion?: string
  edit?: ModEdit | null
  onClose: () => void
  onShowTab: (viewId: string) => void
}): JSX.Element {
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<Attached[]>([])
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [steps, setSteps] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const [kept, setKept] = useState<string | null>(null)
  const [models, setModels] = useState<BrowserTaskModelsState | null>(null)
  const [editing, setEditingState] = useState<ModEdit | null>(null)
  const editRef = useRef<ModEdit | null>(null)
  const setEditing = (next: ModEdit | null): void => {
    editRef.current = next
    setEditingState(next)
  }
  const lastAsk = useRef('')
  const picker = useRef<HTMLInputElement>(null)
  const runTab = useRef<string | null>(null)
  const showTab = useRef(onShowTab)
  showTab.current = onShowTab

  useEffect(
    () =>
      window.api.sideBrowser.onTaskProgress(({ tabId, line, step, paused, showTab: tab }) => {
        if (tabId !== runTab.current) return
        if (tab) showTab.current(tab)
        if (step) setSteps((prev) => [...prev, line])
        setPhase((p) =>
          p.kind === 'done' || p.kind === 'idle'
            ? p
            : paused
              ? { kind: 'paused', why: paused }
              : step
                ? p
                : { kind: 'running', line }
        )
      }),
    []
  )

  useEffect(
    () => () => {
      if (runTab.current) void window.api.sideBrowser.controlTask(runTab.current, 'stop')
    },
    []
  )

  useEffect(() => {
    void window.api.sideBrowser.taskModels().then(setModels)
  }, [])

  const startRef = useRef<(instruction?: string) => Promise<void>>(async () => undefined)
  useEffect(() => {
    if (!edit) return
    setEditing(edit.modId ? edit : null)
    setNotes(edit.text)
    setPhase({ kind: 'idle' })
    if (edit.auto) void startRef.current(edit.text)
  }, [edit])

  const add = (list: FileList | null): void => {
    if (!list) return
    const next = Array.from(list)
      .map((f) => ({ path: window.api.pathForFile(f), name: f.name }))
      .filter((f) => f.path)
    setFiles((prev) => [...prev, ...next.filter((n) => !prev.some((p) => p.path === n.path))])
  }

  const busy = phase.kind === 'running' || phase.kind === 'paused'

  const start = async (instruction = notes.trim()): Promise<void> => {
    if (!viewId || busy) return
    runTab.current = viewId
    setSteps([])
    setKept(null)
    lastAsk.current = instruction
    setPhase({ kind: 'running', line: 'Starting' })
    const result = await window.api.sideBrowser.runTask(viewId, {
      instruction,
      files: files.map((f) => f.path),
      tabs: tabIds,
      ...(editRef.current ? { editMod: editRef.current.modId } : {})
    })
    runTab.current = null
    if (result.ok && result.kind === 'mod') setNotes('')
    setPhase({ kind: 'done', result })
  }

  startRef.current = start

  const decide = (action: 'keep' | 'undo'): void => {
    if (!viewId || phase.kind !== 'done' || !phase.result.ok || phase.result.kind !== 'mod') return
    void window.api.sideBrowser.mod(viewId, action)
    setEditing(null)
    setKept(action === 'keep' ? `Kept ${phase.result.name}. It runs every time you open this site.` : null)
    setPhase({ kind: 'idle' })
  }

  const control = (command: 'pause' | 'resume' | 'stop'): void => {
    if (!runTab.current) return
    const note = command === 'resume' ? notes.trim() : undefined
    if (note) {
      setSteps((prev) => [...prev, `You: ${note}`])
      setNotes('')
    }
    if (command === 'pause') setPhase({ kind: 'paused', why: 'Paused - use the page, then Continue' })
    if (command === 'resume') setPhase({ kind: 'running', line: 'Continuing' })
    if (command === 'stop') setPhase({ kind: 'running', line: 'Stopping' })
    void window.api.sideBrowser.controlTask(runTab.current, command, note)
  }

  const running = phase.kind === 'running'
  const paused = phase.kind === 'paused'
  const ready = Boolean(viewId) && (files.length > 0 || notes.trim().length > 0)
  const trying = phase.kind === 'done' && phase.result.ok && phase.result.kind === 'mod'
  const fillOnly = files.length > 0 && !notes.trim()

  return (
    <div
      className="side-browser-task"
      data-over={over ? '' : undefined}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        add(e.dataTransfer.files)
      }}
    >
      <div className="side-browser-task-row">
        <Sparkles size={13} className="side-browser-task-icon" />
        <textarea
          className="side-browser-task-input"
          value={notes}
          rows={1}
          placeholder={
            paused
              ? 'Tell me anything, then Continue'
              : trying
                ? 'Tell me what to change about it'
                : editing
                  ? `Tell me what to change about ${editing.name}`
                : 'Tell me what to do here, or drop a file to fill this page'
          }
          disabled={running}
          onChange={(e) => setNotes(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && (paused || ready)) {
              e.preventDefault()
              if (paused) control('resume')
              else void start()
            } else if (e.key === 'Escape' && !busy) onClose()
          }}
        />
        <Button
          variant="bare"
          className="side-browser-nav"
          aria-label="Attach a file"
          title="Attach a file (PDF, Word, text)"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <Paperclip size={13} />
        </Button>
        {models && models.options.length > 1 && <TaskModelMenu models={models} onChange={setModels} />}
        {running && runTab.current && (
          <Button variant="ghost" onClick={() => control('pause')}>
            Pause
          </Button>
        )}
        {paused && (
          <Button variant="primary" onClick={() => control('resume')}>
            Continue
          </Button>
        )}
        {busy && runTab.current ? (
          <Button variant="ghost" onClick={() => control('stop')}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" disabled={!ready || running} onClick={() => void start()}>
            {running ? 'Working…' : fillOnly ? 'Fill it in' : 'Go'}
          </Button>
        )}
        <Button variant="bare" className="side-browser-nav" aria-label="Close" onClick={onClose}>
          <X size={13} />
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept=".pdf,.docx,.doc,.rtf,.odt,.pages,.txt,.md,.csv,.json,.html"
          onChange={(e) => {
            add(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
      </div>
      {files.length > 0 && (
        <div className="side-browser-task-files">
          {files.map((f) => (
            <span key={f.path} className="side-browser-task-file" title={f.path}>
              <FileText size={11} />
              {f.name}
              <Button
                variant="bare"
                aria-label={`Remove ${f.name}`}
                disabled={busy}
                onClick={() => setFiles((prev) => prev.filter((p) => p.path !== f.path))}
              >
                <X size={10} />
              </Button>
            </span>
          ))}
        </div>
      )}
      {steps.length > 0 && (
        <ol className="side-browser-task-steps">
          {steps.map((line, i) => (
            <li key={i} className="side-browser-task-line">
              <Check size={11} />
              {line}
            </li>
          ))}
        </ol>
      )}
      {phase.kind === 'running' && <p className="side-browser-task-line">{phase.line}…</p>}
      {phase.kind === 'paused' && (
        <p className="side-browser-task-line" data-tone="warn">
          {phase.why}
        </p>
      )}
      {phase.kind === 'idle' && !notes && !files.length && suggestion && (
        <div className="side-browser-task-files">
          <Button variant="ghost" onClick={() => void start(suggestion)}>
            <Sparkles size={11} />
            {suggestion}
          </Button>
        </div>
      )}
      {kept && phase.kind === 'idle' && (
        <p className="side-browser-task-line" data-tone="good">
          {kept}
        </p>
      )}
      {phase.kind === 'done' && <Outcome result={phase.result} />}
      {trying && (
        <div className="side-browser-task-files">
          <Button variant="primary" onClick={() => decide('keep')}>
            Keep it
          </Button>
          <Button variant="ghost" onClick={() => decide('undo')}>
            Undo
          </Button>
        </div>
      )}
      {phase.kind === 'done' && phase.result.ok && phase.result.kind === 'steps' && lastAsk.current && (
        <div className="side-browser-task-files">
          <Button variant="ghost" onClick={() => void start(`Every visit: ${lastAsk.current}`)}>
            <Sparkles size={11} />
            Do this every visit
          </Button>
        </div>
      )}
      {phase.kind === 'done' && !phase.result.ok && ready && (
        <Button variant="ghost" onClick={() => void start()}>
          Try again
        </Button>
      )}
    </div>
  )
}
