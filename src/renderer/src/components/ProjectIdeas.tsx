import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, RefreshCw, ThumbsDown } from 'lucide-react'
import { Button } from './Button'
import { CONFIG } from '../../../shared/config'
import type {
  ProjectIdea,
  ProjectIdeaKind,
  ProjectIdeaVerdict
} from '../../../shared/project-ideas'

const KIND_LABEL: Record<ProjectIdeaKind, string> = {
  finish: CONFIG.UI_LABELS.CODE_IDEAS_KIND_FINISH,
  next: CONFIG.UI_LABELS.CODE_IDEAS_KIND_NEXT,
  fix: CONFIG.UI_LABELS.CODE_IDEAS_KIND_FIX,
  try: CONFIG.UI_LABELS.CODE_IDEAS_KIND_TRY
}

type IdeasState = { ideas: ProjectIdea[]; loading: boolean }

function useProjectIdeas(
  cwd: string,
  name: string,
  titles: string[]
): IdeasState & { refresh: () => void; regenerate: () => void } {
  const [state, setState] = useState<IdeasState>({ ideas: [], loading: true })
  const titlesRef = useRef(titles)
  titlesRef.current = titles
  const runRef = useRef(0)

  const load = useCallback(
    async (modes: Array<'cached' | 'generate' | 'refresh'>) => {
      const run = ++runRef.current
      setState((s) => ({ ideas: s.ideas, loading: true }))
      let ideas: ProjectIdea[] = []
      for (const mode of modes) {
        const result = await window.api
          .codeProjectIdeas({ cwd, name, titles: titlesRef.current, mode })
          .catch(() => null)
        if (run !== runRef.current) return
        if (result?.ideas.length) {
          ideas = result.ideas
          setState({ ideas, loading: mode === 'cached' })
        }
      }
      setState((s) => ({ ideas: ideas.length ? ideas : s.ideas, loading: false }))
    },
    [cwd, name]
  )

  useEffect(() => {
    setState({ ideas: [], loading: true })
    void load(['cached', 'generate'])
  }, [load])

  return { ...state, refresh: () => void load(['refresh']), regenerate: () => void load(['generate']) }
}

export function ProjectIdeas({
  cwd,
  name,
  titles,
  fallback,
  onPick,
  onSend
}: {
  cwd: string
  name: string
  titles: string[]
  fallback: React.ReactNode
  onPick: (prompt: string) => void
  onSend: (prompt: string) => void
}): React.JSX.Element {
  const { ideas, loading, refresh, regenerate } = useProjectIdeas(cwd, name, titles)
  const [judged, setJudged] = useState<Record<string, ProjectIdeaVerdict | 'checking'>>({})
  const [reopened, setReopened] = useState<Record<string, string>>({})
  useEffect(() => {
    setJudged({})
    setReopened({})
  }, [ideas])
  const setVerdict = (label: string, verdict: ProjectIdeaVerdict | 'checking' | null): void =>
    setJudged((all) => {
      const next = { ...all }
      if (verdict) next[label] = verdict
      else delete next[label]
      return next
    })
  const judge = (idea: ProjectIdea, verdict: ProjectIdeaVerdict | null): void => {
    setPreview(null)
    setVerdict(idea.label, verdict === 'done' ? 'checking' : verdict)
    if (verdict && ideas.every((i) => i.label === idea.label || judged[i.label])) regenerate()
    void window.api
      .codeProjectIdeaFeedback({ cwd, label: idea.label, why: idea.why, verdict })
      .then((check) => {
        if (verdict !== 'done') return
        if (check.done) return setVerdict(idea.label, 'done')
        setVerdict(idea.label, null)
        setReopened((all) => ({ ...all, [idea.label]: check.reason }))
      })
  }
  const [preview, setPreview] = useState<{ text: string; left: number; top: number; width: number } | null>(
    null
  )
  const show = (idea: ProjectIdea, card: HTMLElement): void => {
    const slot = card.parentElement
    const row = slot?.parentElement
    setPreview(
      idea.detail && slot && row
        ? {
            text: idea.detail,
            left: slot.offsetLeft - row.scrollLeft,
            top: slot.offsetTop,
            width: slot.offsetWidth
          }
        : null
    )
  }

  if (!loading && ideas.length === 0) return <>{fallback}</>

  return (
    <section className="project-ideas" aria-busy={loading}>
      {preview && (
        <p
          className="project-idea-preview"
          role="tooltip"
          style={{ left: preview.left, top: preview.top, width: preview.width }}
        >
          {preview.text}
        </p>
      )}
      <header className="project-ideas-head">
        <span>
          {ideas.length === 0
            ? CONFIG.UI_LABELS.CODE_IDEAS_LOADING.replace('{name}', name)
            : CONFIG.UI_LABELS.CODE_IDEAS_TITLE}
        </span>
        <Button
          variant="bare"
          className="project-ideas-refresh"
          onClick={refresh}
          disabled={loading}
          title={CONFIG.UI_LABELS.CODE_IDEAS_REFRESH}
          aria-label={CONFIG.UI_LABELS.CODE_IDEAS_REFRESH}
        >
          <RefreshCw size={12} strokeWidth={2} data-spinning={loading ? '' : undefined} />
        </Button>
      </header>
      <div
        className="project-ideas-grid"
        onMouseLeave={() => setPreview(null)}
        onScroll={() => setPreview(null)}
      >
        {ideas.length === 0
          ? [0, 1, 2].map((i) => <div key={i} className="project-idea project-idea-skeleton" />)
          : ideas.map((idea) =>
              judged[idea.label] ? (
                <div key={idea.label} className="project-idea-slot project-idea-judged">
                  <span>
                    {
                      {
                        checking: CONFIG.UI_LABELS.CODE_IDEAS_CHECKING_DONE,
                        done: CONFIG.UI_LABELS.CODE_IDEAS_MARKED_DONE,
                        bad: CONFIG.UI_LABELS.CODE_IDEAS_MARKED_BAD
                      }[judged[idea.label]]
                    }
                  </span>
                  <Button variant="bare" className="project-idea-undo" onClick={() => judge(idea, null)}>
                    {CONFIG.UI_LABELS.CODE_IDEAS_UNDO}
                  </Button>
                </div>
              ) : (
                <div key={idea.label} className="project-idea-slot">
                  <Button
                    variant="bare"
                    className="project-idea"
                    data-kind={idea.kind}
                    onMouseEnter={(e) => show(idea, e.currentTarget)}
                    onFocus={(e) => show(idea, e.currentTarget)}
                    onBlur={() => setPreview(null)}
                    onClick={() => {
                      setPreview(null)
                      onPick(idea.prompt)
                    }}
                    onDoubleClick={() => onSend(idea.prompt)}
                  >
                    <span className="project-idea-top">
                      {idea.emoji && <span className="project-idea-emoji">{idea.emoji}</span>}
                      <span className="project-idea-kind">{KIND_LABEL[idea.kind]}</span>
                    </span>
                    <span className="project-idea-label">{idea.label}</span>
                    {reopened[idea.label] ? (
                      <span className="project-idea-why" data-reopened="">
                        {CONFIG.UI_LABELS.CODE_IDEAS_NOT_DONE.replace('{reason}', reopened[idea.label])}
                      </span>
                    ) : (
                      idea.why && <span className="project-idea-why">{idea.why}</span>
                    )}
                  </Button>
                  <span className="project-idea-actions">
                    <Button
                      variant="bare"
                      className="project-idea-action"
                      onClick={() => judge(idea, 'done')}
                      aria-label={CONFIG.UI_LABELS.CODE_IDEAS_MARK_DONE}
                    >
                      <span className="project-idea-tip" role="tooltip">
                        <strong>{CONFIG.UI_LABELS.CODE_IDEAS_MARK_DONE}</strong>
                        {CONFIG.UI_LABELS.CODE_IDEAS_MARK_DONE_HINT}
                      </span>
                      <Check size={12} strokeWidth={2.25} />
                    </Button>
                    <Button
                      variant="bare"
                      className="project-idea-action"
                      onClick={() => judge(idea, 'bad')}
                      aria-label={CONFIG.UI_LABELS.CODE_IDEAS_MARK_BAD}
                    >
                      <span className="project-idea-tip" role="tooltip">
                        <strong>{CONFIG.UI_LABELS.CODE_IDEAS_MARK_BAD}</strong>
                        {CONFIG.UI_LABELS.CODE_IDEAS_MARK_BAD_HINT}
                      </span>
                      <ThumbsDown size={12} strokeWidth={2.25} />
                    </Button>
                  </span>
                </div>
              )
            )}
      </div>
    </section>
  )
}
