import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { SITE_BUILD_PROMPT, type SiteProgress, type SiteState } from '../../../shared/infra'
import type { MightyProject } from '../../../shared/types'
import { Button } from './Button'

type Busy = 'publish' | 'unpublish' | null
type Build = { starting?: boolean; pane?: string; error?: string }

const RECHECK_MS = 5_000

function progressText(progress: SiteProgress | null): string {
  if (!progress) return 'Getting your files ready'
  if (progress.step === 'checking') return 'Checking the address is free'
  if (progress.step === 'finishing') return 'Almost done'
  return `Sending ${progress.sent} of ${progress.total} files`
}

export function PublishSite({
  project,
  hostedElsewhere,
  onOpenAgent
}: {
  project: MightyProject
  hostedElsewhere: boolean
  onOpenAgent?: (pane: string) => void
}): JSX.Element | null {
  const projectId = project.id
  const [state, setState] = useState<SiteState | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [editing, setEditing] = useState(false)
  const [justDone, setJustDone] = useState(false)
  const [build, setBuild] = useState<Build>({})
  const [progress, setProgress] = useState<SiteProgress | null>(null)

  useEffect(
    () => window.api.infra.onSiteProgress((p) => p.projectId === projectId && setProgress(p)),
    [projectId]
  )

  useEffect(() => {
    let alive = true
    void window.api.infra.site(projectId).then((s) => {
      if (!alive) return
      setState(s)
      setName(s.suggested)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  const waiting = !!state && !state.site && state.pageFolder === null
  const building = waiting && !!build.pane
  useEffect(() => {
    if (!waiting) return
    let alive = true
    const recheck = (): void =>
      void window.api.infra.site(projectId).then((s) => {
        if (alive) setState((cur) => (cur ? { ...cur, pageFolder: s.pageFolder } : s))
      })
    window.addEventListener('focus', recheck)
    const timer = building ? setInterval(recheck, RECHECK_MS) : null
    return () => {
      alive = false
      window.removeEventListener('focus', recheck)
      if (timer) clearInterval(timer)
    }
  }, [projectId, waiting, building])

  if (!state) return null

  const run = async (kind: Exclude<Busy, null>): Promise<void> => {
    setBusy(kind)
    setProgress(null)
    setJustDone(false)
    const next =
      kind === 'publish'
        ? await window.api.infra.publishSite(projectId, name)
        : await window.api.infra.unpublishSite(projectId)
    setState(next)
    setBusy(null)
    if (next.error) return
    setEditing(false)
    setJustDone(kind === 'publish')
    if (kind === 'unpublish') setName(next.suggested)
  }

  const startBuild = (): void => {
    if (!project.repoFolder) return
    setBuild({ starting: true })
    void window.api
      .codeStartAgent({
        project: project.name,
        cwd: project.repoFolder,
        inApp: true,
        message: SITE_BUILD_PROMPT
      })
      .then((result) => setBuild(result.ok ? { pane: result.pane } : { error: result.reason }))
      .catch(() => setBuild({ error: 'Something went wrong on this Mac.' }))
  }

  const { site, error, planRequired, pageFolder } = state
  const clean = name.toLowerCase().replace(/[^a-z0-9-]/g, '')

  if (!site && pageFolder === null) {
    if (hostedElsewhere && !build.pane && !build.starting && !build.error) return null
    return (
      <div className="infra-publish">
        <div className="infra-publish-line">
          {build.pane ? (
            <>
              <Loader2 size={12} strokeWidth={2.5} data-spin="" />
              <span>
                An agent is getting your site ready. The address box shows up here when it is.
              </span>
              {onOpenAgent && (
                <Button variant="ghost" onClick={() => onOpenAgent(build.pane as string)}>
                  Open in Agents
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="infra-publish-suffix">
                {build.error
                  ? `The agent couldn't start: ${build.error}`
                  : `Want this online at ${clean || 'your-site'}${CONFIG.BILLING.SITES.HOST_SUFFIX}? It needs a web page first.`}
              </span>
              <Button disabled={build.starting} onClick={startBuild}>
                {build.starting ? <Loader2 size={12} data-spin="" /> : null}
                {build.starting
                  ? 'Starting an agent'
                  : build.error
                    ? 'Try again'
                    : 'Build it for me'}
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }

  const showForm = !site || editing
  const sends = pageFolder ? `the ${pageFolder} folder` : "this project's folder"

  return (
    <div className="infra-publish">
      {site && !editing && (
        <div className="infra-publish-line">
          <Button
            variant="bare"
            className="infra-publish-link"
            onClick={() => void window.api.openExternal(site.url)}
          >
            {site.url.replace('https://', '')}
          </Button>
          {justDone && (
            <span className="infra-added">
              <Check size={11} strokeWidth={3} /> Online
            </span>
          )}
          <Button variant="ghost" disabled={!!busy} onClick={() => void run('publish')}>
            {busy === 'publish' ? <Loader2 size={12} data-spin="" /> : null}
            {busy === 'publish' ? 'Updating' : 'Update site'}
          </Button>
          <Button variant="ghost" disabled={!!busy} onClick={() => setEditing(true)}>
            Change address
          </Button>
          <Button variant="ghost" disabled={!!busy} onClick={() => void run('unpublish')}>
            {busy === 'unpublish' ? <Loader2 size={12} data-spin="" /> : null}
            {busy === 'unpublish' ? 'Taking it down' : 'Take it down'}
          </Button>
        </div>
      )}
      {showForm && (
        <div className="infra-publish-line">
          <input
            value={clean}
            placeholder="your-site"
            maxLength={40}
            disabled={!!busy}
            aria-label="Site address"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && clean.length >= 3) void run('publish')
            }}
          />
          <span className="infra-publish-suffix">{CONFIG.BILLING.SITES.HOST_SUFFIX}</span>
          <Button disabled={!!busy || clean.length < 3} onClick={() => void run('publish')}>
            {busy === 'publish' ? <Loader2 size={12} data-spin="" /> : null}
            {busy === 'publish' ? 'Putting it online' : 'Put it online'}
          </Button>
          {editing && (
            <Button variant="ghost" disabled={!!busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {busy === 'publish' && (
        <div className="infra-publish-line infra-publish-suffix" role="status">
          <progress
            value={progress?.step === 'sending' ? progress.sent : undefined}
            max={progress?.total || 1}
          />
          {progressText(progress)}
        </div>
      )}
      {showForm && !busy && !error && pageFolder !== null && (
        <div className="infra-publish-line infra-publish-suffix">
          Anyone with the link can see it. Puts {sends} online. You can take it down any time.
        </div>
      )}
      {error && !busy && (
        <div className="infra-publish-line keys-sheet-err">
          {error}
          {planRequired && (
            <Button variant="ghost" onClick={() => void window.api.openUpgradeWindow('settings')}>
              See plans
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
