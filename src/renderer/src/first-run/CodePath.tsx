import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  History,
  ListChecks,
  Sparkles
} from 'lucide-react'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { ProviderIcon } from '../components/ProviderIcon'
import { timeAgo } from '../mighty/mighty-shared'
import { CONFIG } from '../../../shared/config'

export type CodeStep = 'project' | 'agent' | 'handoff'
type Harness = 'claude' | 'codex' | 'mightymouse'

interface RecentProject {
  folder: string
  name: string
  updatedAt: string
  projectId?: string
}

interface SelectedProject {
  id: string
  name: string
  cwd: string
}

const STARTERS = [
  { Icon: BookOpen, text: 'Explain how this project is put together' },
  { Icon: ListChecks, text: 'List what I should clean up first' },
  { Icon: History, text: 'Summarize what changed here recently' }
]

async function trackStep(step: CodeStep): Promise<void> {
  const bootMs = await window.api.firstRun.getFirstBootAtMs()
  window.api.track('ftue_step', {
    path: 'code',
    step,
    ms_since_first_boot: bootMs ? Date.now() - bootMs : 0
  })
}

export function CodePath({
  step,
  onStep: setStep,
  onDone
}: {
  step: CodeStep
  onStep: (step: CodeStep) => void
  onDone: () => void
}): React.JSX.Element {

  const [projects, setProjects] = useState<RecentProject[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [picking, setPicking] = useState(false)
  const [selected, setSelected] = useState<SelectedProject | null>(null)

  const [checking, setChecking] = useState(true)
  const [claudeFound, setClaudeFound] = useState(false)
  const [codexFound, setCodexFound] = useState(false)
  const [harness, setHarness] = useState<Harness>('claude')

  const [text, setText] = useState('')
  const [starting, setStarting] = useState(false)
  const [startFailed, setStartFailed] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void trackStep(step)
  }, [step])

  useEffect(() => {
    let live = true
    window.api.firstRunCode
      .recentProjects()
      .then((found) => {
        if (live) setProjects(found)
      })
      .finally(() => {
        if (live) setLoadingProjects(false)
      })
    return () => {
      live = false
    }
  }, [])

  const runChecks = (): void => {
    setChecking(true)
    Promise.all([
      window.api
        .settingsTestBackend('claude')
        .catch(() => ({ ok: false, checks: [], advice: null })),
      window.api.settingsTestBackend('codex').catch(() => ({ ok: false, checks: [], advice: null }))
    ]).then(([claude, codex]) => {
      setClaudeFound(Boolean(claude.checks[0]?.ok))
      setCodexFound(Boolean(codex.checks[0]?.ok))
      setHarness(claude.checks[0]?.ok ? 'claude' : codex.checks[0]?.ok ? 'codex' : 'mightymouse')
      setChecking(false)
    })
  }

  useEffect(() => {
    if (step === 'agent') runChecks()
  }, [step])

  useEffect(() => {
    if (step === 'handoff') composerRef.current?.focus()
  }, [step])

  const choose = async (folder: string, name: string, projectId?: string): Promise<void> => {
    setPicking(true)
    if (projectId) {
      setSelected({ id: projectId, name, cwd: folder })
      setPicking(false)
      setStep('agent')
      return
    }
    const link = await window.api.mighty.pickProjectFolder(folder)
    setPicking(false)
    if (!link) return
    const now = new Date().toISOString()
    const project = await window.api.mighty.upsertProject({
      id: crypto.randomUUID(),
      name,
      created: now,
      updated: now,
      ...link
    })
    if (!project) return
    setSelected({ id: project.id, name: project.name, cwd: link.repoFolder })
    setStep('agent')
  }

  const chooseAnother = async (): Promise<void> => {
    setPicking(true)
    const link = await window.api.mighty.pickProjectFolder()
    if (!link) {
      setPicking(false)
      return
    }
    const name = link.repoFolder.split('/').pop() || link.repoFolder
    await choose(link.repoFolder, name)
  }

  const submit = async (prompt: string): Promise<void> => {
    if (!selected || starting) return
    setStarting(true)
    setStartFailed(false)
    if (harness === 'mightymouse') {
      const session = await window.api.mighty.newSession(selected.id)
      await window.api.mighty.open(false, session.id)
      void window.api.mighty.chat(prompt, session.id, undefined, selected.id)
      onDone()
      return
    }
    const result = await window.api.codeStartAgent({
      project: selected.name,
      cwd: selected.cwd,
      harness,
      inApp: true,
      message: prompt
    })
    if (result.ok) {
      await window.api.firstRunCode.handoff({
        cwd: selected.cwd,
        project: selected.name,
        pane: result.pane,
        message: prompt
      })
      onDone()
      return
    }
    setStarting(false)
    setStartFailed(true)
  }

  const agentRows = [
    { id: 'claude' as const, label: 'Claude Code', sub: "Anthropic's coding app", found: claudeFound },
    { id: 'codex' as const, label: 'Codex', sub: "OpenAI's coding app", found: codexFound },
    {
      id: 'mightymouse' as const,
      label: CONFIG.BRAND_NAME,
      sub: `Built into ${CONFIG.BRAND_NAME}`,
      found: true
    }
  ]
  const noneFound = !claudeFound && !codexFound
  const picked = agentRows.find((r) => r.id === harness) ?? agentRows[2]

  return (
    <div className="fr">
      {step === 'project' && (
        <>
          <span className="fr-badge">
            <FolderGit2 size={22} />
          </span>
          <span className="fr-title">Which folder should it work in?</span>
          {loadingProjects ? (
            <>
              <Spinner size="w-5 h-5" />
              <span className="fr-sub">Looking for your projects...</span>
            </>
          ) : projects.length === 0 ? (
            <span className="fr-sub">Pick the folder you want AI to work in.</span>
          ) : (
            <div className="fr-rows fr-scroll">
              {projects.map((p) => (
                <Button
                  key={p.folder}
                  variant="bare"
                  disabled={picking}
                  className="fr-row fr-row-btn"
                  onClick={() => void choose(p.folder, p.name, p.projectId)}
                >
                  <span className="fr-row-lead">
                    <Folder size={15} className="fr-row-ico" />
                    <span className="font-semibold">{p.name}</span>
                  </span>
                  <span className="fr-row-meta">
                    edited {timeAgo(p.updatedAt)}
                    <ChevronRight size={14} />
                  </span>
                </Button>
              ))}
            </div>
          )}
          <Button
            variant="ghost"
            className="fr-ghost"
            disabled={picking}
            onClick={() => void chooseAnother()}
          >
            <FolderOpen size={15} />
            Choose another folder
          </Button>
        </>
      )}

      {step === 'agent' && (
        <>
          <span className="fr-badge">
            {checking ? <Spinner size="w-5 h-5" /> : <ProviderIcon id={picked.id} size={24} />}
          </span>
          <span className="fr-title">
            {checking
              ? 'Checking your Mac…'
              : claudeFound || codexFound
                ? 'Who should do the coding?'
                : `No coding app found. ${CONFIG.BRAND_NAME} can do it.`}
          </span>
          {!checking && !noneFound && (
            <div className="fr-rows">
              {agentRows.map((r) => (
                <Button
                  key={r.id}
                  variant="bare"
                  disabled={!r.found}
                  className="fr-row fr-row-btn fr-pick"
                  data-picked={harness === r.id ? '' : undefined}
                  onClick={() => setHarness(r.id)}
                >
                  <span className="fr-row-lead">
                    <ProviderIcon id={r.id} size={16} />
                    <span className="flex flex-col items-start">
                      {r.label}
                      <span className="text-[12px] font-normal text-muted">{r.sub}</span>
                    </span>
                  </span>
                  {!r.found ? (
                    <span className="fr-row-meta">not installed</span>
                  ) : (
                    <span className="fr-tick" data-on={harness === r.id ? '' : undefined}>
                      {harness === r.id && <Check size={12} strokeWidth={3.5} />}
                    </span>
                  )}
                </Button>
              ))}
            </div>
          )}
          {!checking && (
            <div className="fr-actions">
              <Button
                variant="primary"
                className="fr-primary"
                onClick={() => {
                  void window.api.settingsSetBackend(harness)
                  setStep('handoff')
                }}
              >
                Continue
                <ArrowRight size={16} />
              </Button>
              {(!claudeFound || !codexFound) && (
                <span className="fr-sub">
                  Want Claude Code or Codex? Install it, then reopen this screen.
                </span>
              )}
              <span className="fr-sub">You can change this later in Settings.</span>
            </div>
          )}
        </>
      )}

      {step === 'handoff' && selected && (
        <>
          <span className="fr-badge">
            <Sparkles size={22} />
          </span>
          <span className="fr-title">
            What should we do in <span className="fr-hl">{selected.name}</span>?
          </span>
          <div className="fr-rows">
            {STARTERS.map(({ Icon, text: starter }) => (
              <Button
                key={starter}
                variant="bare"
                disabled={starting}
                className="fr-row fr-row-btn"
                onClick={() => void submit(starter)}
              >
                <span className="fr-row-lead">
                  <Icon size={15} className="fr-row-ico" />
                  {starter}
                </span>
                <ChevronRight size={14} className="fr-row-ico" />
              </Button>
            ))}
          </div>
          {startFailed && (
            <span className="text-magenta text-[13px]">
              Couldn't start. Try again or pick another agent.
            </span>
          )}
          <textarea
            ref={composerRef}
            className="fr-input"
            placeholder="Tell it what to do…"
            value={text}
            disabled={starting}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                e.preventDefault()
                void submit(text.trim())
              }
            }}
          />
          {starting ? (
            <span className="fr-sub flex items-center gap-2">
              <Spinner size="w-4 h-4" />
              Starting...
            </span>
          ) : (
            <span className="fr-sub">{CONFIG.FIRST_RUN.enterHint}</span>
          )}
        </>
      )}
    </div>
  )
}
