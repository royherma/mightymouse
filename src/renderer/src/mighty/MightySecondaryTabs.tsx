import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, Plus, Trash2, Play, FileText, FileCode, FileWarning } from 'lucide-react'
import { Button } from '../components/Button'
import { Row } from '../components/Layout'
import { Switch } from '../components/Switch'
import { CONFIG } from '../../../shared/config'
import type { GithubJobEvent, MightyJob, MightyArtifact, MightySchedule, MightySettings, MightyOutputFormat, ChatTabNameFormat, LinkTarget } from '../../../shared/types'

import { tabFormatLabel, fileName, isHtml, timeAgo, fullTime, JOB_TEMPLATES, SCHEDULES, FORMAT_LABELS } from './mighty-shared'
import { AutoGrowTextarea } from './MightyConversationView'
const GITHUB_EVENT_LABELS: Record<GithubJobEvent, string> = {
  'pr-opened': 'On GitHub: new pull request',
  'issue-opened': 'On GitHub: new issue',
  'checks-failed': 'On GitHub: failed checks'
}
const GITHUB_EVENTS = Object.keys(GITHUB_EVENT_LABELS) as GithubJobEvent[]
const isGithubEvent = (v: string): v is GithubJobEvent => v in GITHUB_EVENT_LABELS
const folderName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

export function JobsTab({ name }: { name: string }): JSX.Element {
  const [jobs, setJobs] = useState<MightyJob[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const load = useCallback(async () => setJobs(await window.api.mighty.listJobs()), [])
  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(
    async (job: MightyJob) => {
      await window.api.mighty.upsertJob({ ...job, enabled: !job.enabled })
      void load()
    },
    [load]
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.mighty.deleteJob(id)
      void load()
    },
    [load]
  )

  const runNow = useCallback(
    async (id: string) => {
      setRunning(id)
      try {
        await window.api.mighty.runJob(id)
        void load()
      } finally {
        setRunning(null)
      }
    },
    [load]
  )

  const addJob = useCallback(
    async (template: (typeof JOB_TEMPLATES)[number]) => {
      setPickerOpen(false)
      const s = await window.api.mighty.newSession()
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
      await window.api.mighty.upsertJob({
        id: crypto.randomUUID(),
        name: template.name,
        prompt: template.prompt,
        schedule: template.schedule,
        hour: template.hour,
        enabled: false,
        lastRun: null,
        created: now,
        sessionId: s.id
      })
      void load()
    },
    [load]
  )

  const patch = useCallback(
    async (job: MightyJob, fields: Partial<MightyJob>) => {
      await window.api.mighty.upsertJob({ ...job, ...fields })
      void load()
    },
    [load]
  )

  const pickFolder = useCallback(
    async (known?: string) => known ?? (await window.api.mighty.pickProjectFolder())?.repoFolder,
    []
  )

  const changeWhen = useCallback(
    async (job: MightyJob, value: string) => {
      if (!isGithubEvent(value)) {
        await patch(job, { trigger: undefined, schedule: value as MightySchedule })
        return
      }
      const repoCwd = await pickFolder(job.trigger?.repoCwd ?? job.target?.cwd)
      if (repoCwd) await patch(job, { trigger: { kind: 'github', repoCwd, event: value }, schedule: 'manual' })
    },
    [patch, pickFolder]
  )

  const changeTarget = useCallback(
    async (job: MightyJob, coding: boolean, change = false) => {
      if (!coding) {
        await patch(job, { target: undefined })
        return
      }
      const cwd = await pickFolder(change ? undefined : job.trigger?.repoCwd)
      if (cwd) await patch(job, { target: { kind: 'code', cwd, project: folderName(cwd) } })
    },
    [patch, pickFolder]
  )

  return (
    <div className="px-5 py-4 space-y-3 overflow-y-auto h-[calc(100vh-2.75rem-3.25rem)]">
      <Row className="justify-between">
        <p className="text-sm text-muted">Work {name} does on its own, on a schedule.</p>
        <Button
          variant="primary"
          onClick={() => setPickerOpen((v) => !v)}
          className="inline-flex items-center gap-1.5"
        >
          <Plus size={14} /> Add job
        </Button>
      </Row>

      {pickerOpen && (
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-surface3 bg-surface2/40 p-3">
          {JOB_TEMPLATES.map((t) => (
            <Button variant="bare"
              key={t.label}
              onClick={() => void addJob(t)}
              className="flex items-center gap-2 rounded-xl border border-surface3 bg-surface1 px-3.5 py-3 text-left text-sm text-on-surface hover:border-accent hover:bg-surface2 transition-colors min-w-0"
            >
              <t.icon size={16} className="text-muted shrink-0" />
              <span className="truncate">{t.label}</span>
            </Button>
          ))}
        </div>
      )}

      {jobs.length === 0 && !pickerOpen && (
        <div className="text-center text-muted py-12">No jobs yet.</div>
      )}

      {jobs.map((job) => (
        <div key={job.id} className="rounded-xl bg-surface2 p-3.5 space-y-2.5">
          <Row>
            <input
              value={job.name}
              onChange={(e) => void patch(job, { name: e.target.value })}
              className="flex-1 min-w-0 bg-transparent text-md font-medium outline-none focus:bg-surface3 rounded px-1.5 py-0.5 truncate focus:text-clip"
            />
            <Switch on={job.enabled} onChange={() => void toggle(job)} />
          </Row>

          <AutoGrowTextarea
            value={job.prompt}
            onChange={(e) => void patch(job, { prompt: e.target.value })}
            className="w-full resize-none bg-surface3/40 rounded-lg px-2.5 py-2 text-sm outline-none focus:shadow-focus overflow-y-auto"
          />

          <Row className="flex-wrap text-sm">
            <select
              value={job.trigger?.event ?? job.schedule}
              onChange={(e) => void changeWhen(job, e.target.value)}
              className="bg-surface3 rounded-md px-2 py-1 outline-none"
            >
              {SCHEDULES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              {GITHUB_EVENTS.map((e) => (
                <option key={e} value={e}>
                  {GITHUB_EVENT_LABELS[e]}
                </option>
              ))}
            </select>

            <select
              value={job.target ? 'code' : 'mighty'}
              onChange={(e) => void changeTarget(job, e.target.value === 'code')}
              className="bg-surface3 rounded-md px-2 py-1 outline-none"
            >
              <option value="mighty">{name} answers</option>
              <option value="code">Coding agent in a project folder</option>
            </select>

            {job.target && (
              <Button variant="ghost" onClick={() => void changeTarget(job, true, true)} title={job.target.cwd}>
                <FolderOpen size={12} /> {job.target.project}
              </Button>
            )}

            {job.trigger && (
              <span className="text-muted truncate max-w-[12rem]" title={job.trigger.repoCwd}>
                watching {folderName(job.trigger.repoCwd)}
              </span>
            )}

            {(!job.trigger && (job.schedule === 'daily' || job.schedule === 'weekdays')) && (
              <label className="flex items-center gap-1 text-muted">
                at
                <select
                  value={job.hour}
                  onChange={(e) => void patch(job, { hour: Number(e.target.value) })}
                  className="bg-surface3 rounded-md px-2 py-1 outline-none"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </label>
            )}

            <span className="text-muted ml-auto truncate max-w-[10rem]">
              {job.lastRun ? `ran ${timeAgo(job.lastRun)}` : 'never run'}
            </span>

            <Row className="shrink-0">
              <Button
                variant="ghost"
                onClick={() => void runNow(job.id)}
                disabled={running === job.id}
                className="inline-flex items-center gap-1 whitespace-nowrap"
              >
                <Play size={12} /> {running === job.id ? 'Running…' : 'Run now'}
              </Button>
              <Button variant="icon" onClick={() => void remove(job.id)}>
                <Trash2 size={14} />
              </Button>
            </Row>
          </Row>
        </div>
      ))}
    </div>
  )
}

// ── Made tab (registry) ──────────────────────────────────────────────────────────

export function MadeTab({ name }: { name: string }): JSX.Element {
  const [items, setItems] = useState<MightyArtifact[]>([])
  const [toast, setToast] = useState('')
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => setItems(await window.api.mighty.listRegistry()), [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => () => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current)
  }, [])

  const remove = useCallback(
    async (path: string) => {
      await window.api.mighty.deleteArtifact(path)
      void load()
    },
    [load]
  )

  const open = useCallback(async (a: MightyArtifact) => {
    const opened = await window.api.mighty.openArtifact(a.path)
    if (!opened) {
      setToast(`${fileName(a.path)} is missing - it may have failed to save.`)
      if (toastTimeout.current) clearTimeout(toastTimeout.current)
      toastTimeout.current = setTimeout(() => setToast(''), 4000)
    }
  }, [])

  return (
    <div className="px-5 py-4 space-y-2 overflow-y-auto h-[calc(100vh-2.75rem-3.25rem)] relative">
      <p className="text-sm text-muted">Everything {name} has built for you.</p>
      {items.length === 0 && (
        <div className="text-center text-muted py-12">
          Nothing yet. Ask {name} to make you something.
        </div>
      )}
      {items.map((a) => {
        const html = isHtml(a.path)
        return (
          <Row key={a.path} gap={3} className="rounded-xl bg-surface2 px-3.5 py-2.5">
            {a.exists ? (
              html ? (
                <FileCode size={18} className="text-accent-text shrink-0" />
              ) : (
                <FileText size={18} className="text-muted shrink-0" />
              )
            ) : (
              <FileWarning size={18} className="text-red shrink-0" />
            )}
            <Button variant="bare"
              onClick={() => void open(a)}
              className="flex-1 text-left min-w-0"
              title={!a.exists ? 'File missing - it may have failed to save' : html ? 'Open in app' : 'Reveal in Finder'}
            >
              <div className="text-md truncate flex items-center gap-1.5">
                {fileName(a.path)}
                {!a.exists ? (
                  <span className="text-xs text-red bg-red/10 rounded px-1 py-0.5">Missing</span>
                ) : (
                  html && (
                    <span className="text-xs text-accent-text bg-accent/10 rounded px-1 py-0.5">HTML</span>
                  )
                )}
              </div>
              <div className="text-sm text-muted truncate">{a.prompt}</div>
            </Button>
            <span className="text-sm text-muted shrink-0" title={fullTime(a.ts)}>
              {timeAgo(a.ts)}
            </span>
            <Button variant="icon" onClick={() => void remove(a.path)} className="shrink-0">
              <Trash2 size={14} />
            </Button>
          </Row>
        )
      })}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-surface3 text-sm rounded-lg px-3.5 py-2 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

export type ChatSettingsHooks = {
  onNameChange: (name: string) => void
  onTabNameFormatChange: (format: ChatTabNameFormat) => void
  onProjectsChanged: () => void
  onAdvancedModeChange: (on: boolean) => void
}

const CHAT_FIELD_CLS =
  'w-full bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md outline-none transition-colors focus:border-accent focus:shadow-focus'

function ChatField({
  label,
  help,
  children
}: {
  label: string
  help: string
  children: JSX.Element
}): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="block font-semibold text-lg">{label}</span>
      {children}
      <span className="block text-muted text-sm">{help}</span>
    </label>
  )
}

const LINK_TARGET_LABELS: Record<LinkTarget, string> = {
  app: 'The Browser tab beside it',
  browser: 'Your browser'
}

export function ChatPrefs({
  onNameChange,
  onTabNameFormatChange
}: Omit<ChatSettingsHooks, 'onProjectsChanged' | 'onAdvancedModeChange'>): JSX.Element {
  const [settings, setSettings] = useState<MightySettings | null>(null)

  useEffect(() => {
    void (async () => setSettings(await window.api.mighty.getSettings()))()
  }, [])

  const update = useCallback(
    (fields: Partial<MightySettings>) => {
      setSettings((prev) => {
        if (!prev) return prev
        const next = { ...prev, ...fields }
        void window.api.mighty.setSettings(next)
        if (fields.name !== undefined) onNameChange(next.name)
        if (fields.tabNameFormat !== undefined) onTabNameFormatChange(next.tabNameFormat)
        return next
      })
    },
    [onNameChange, onTabNameFormatChange]
  )

  if (!settings) return <div className="text-muted text-sm">Loading…</div>

  return (
    <div className="space-y-5">
      <ChatField
        label="Name"
        help={`What you call your agent. Blank uses “${CONFIG.MIGHTY.NAME}”.`}
      >
        <input
          value={settings.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder={CONFIG.MIGHTY.NAME}
          className={CHAT_FIELD_CLS}
        />
      </ChatField>

      <ChatField
        label="Default format"
        help="What it builds when you don’t say. HTML opens as a dashboard inside the app."
      >
        <select
          value={settings.outputFormat}
          onChange={(e) => update({ outputFormat: e.target.value as MightyOutputFormat })}
          className={CHAT_FIELD_CLS}
        >
          {CONFIG.MIGHTY.OUTPUT_FORMATS.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABELS[f]}
            </option>
          ))}
        </select>
      </ChatField>

      <ChatField
        label="Chat tab names"
        help="How new chat tabs name themselves. Tabs you already have keep their names."
      >
        <select
          value={settings.tabNameFormat}
          onChange={(e) => update({ tabNameFormat: e.target.value as ChatTabNameFormat })}
          className={CHAT_FIELD_CLS}
        >
          {CONFIG.MIGHTY.TAB_NAME_FORMATS.map((f) => (
            <option key={f} value={f}>
              {tabFormatLabel(f, new Date())}
            </option>
          ))}
        </select>
      </ChatField>

      <ChatField
        label="Links open in"
        help="Where a link in Chat or Code opens when you click it. ⌘-click opens the other one, right-click lets you pick."
      >
        <select
          value={settings.linksOpenIn}
          onChange={(e) => update({ linksOpenIn: e.target.value as LinkTarget })}
          className={CHAT_FIELD_CLS}
        >
          {CONFIG.MIGHTY.LINK_TARGETS.map((t) => (
            <option key={t} value={t}>
              {LINK_TARGET_LABELS[t]}
            </option>
          ))}
        </select>
      </ChatField>

      <div>
        <Button
          variant="ghost"
          onClick={() => void window.api.mighty.openWorkspace()}
          className="inline-flex items-center gap-2"
        >
          <FolderOpen size={16} /> Open workspace folder
        </Button>
        <span className="block text-muted text-sm mt-1.5">
          Where everything your agent builds is saved.
        </span>
      </div>
    </div>
  )
}
