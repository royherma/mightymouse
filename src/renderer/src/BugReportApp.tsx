import { JSX, useCallback, useEffect, useState } from 'react'
import { Bug, Check, ImagePlus, Mail, X } from 'lucide-react'
import { WindowFrame, LoadingBody } from './WindowFrame'
import { Card } from './components/Card'
import { Button } from './components/Button'
import { Spinner } from './components/Spinner'
import {
  BUG_REPORT_BODY_MIN,
  BUG_REPORT_LIMITS,
  type BugReportActivityEntry,
  type BugReportDiagnostics,
  type BugReportContext
} from '../../shared/bug-report'

/**
 * The bug report form (?window=bug) — replaces the old mailto: as the primary
 * way to report a problem.
 *
 * A typed report is never lost: if the submit fails, the user gets the email
 * fallback with everything they wrote already in it.
 */

function DiagnosticsList({ d }: { d: BugReportDiagnostics }): JSX.Element {
  const rows: [string, string][] = [
    ['Version', d.appVersion],
    ['System', `${d.platform} ${d.arch} (${d.osRelease})`],
    ['Model', d.backend],
    ['Last mode', d.lastMode ?? '—'],
    ['Signed in', d.signedIn ? 'yes' : 'no'],
    ...(d.lastError ? ([['Last error', d.lastError]] as [string, string][]) : [])
  ]
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2 text-xlg">
          <span className="text-muted w-20 shrink-0">{label}</span>
          <span className="text-on-surface break-all">{value}</span>
        </div>
      ))}
    </div>
  )
}

function ActivityList({ entries }: { entries: BugReportActivityEntry[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
      {entries.map((e, i) => (
        <div key={`${e.ts}-${i}`} className="flex gap-2 text-xlg">
          <span className="text-muted w-14 shrink-0 tabular-nums">
            {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <span
            className={`w-10 shrink-0 ${e.kind === 'error' ? 'text-red' : 'text-muted'}`}
          >
            {e.kind}
          </span>
          <span className="text-on-surface break-all">{e.label}</span>
        </div>
      ))}
    </div>
  )
}

export default function BugReportApp(): JSX.Element {
  const [ctx, setCtx] = useState<BugReportContext | null>(null)
  const [body, setBody] = useState('')
  const [steps, setSteps] = useState('')
  const [email, setEmail] = useState('')
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null)
  const [screenshotThumb, setScreenshotThumb] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<{ error: string; emailFallback: string } | null>(null)

  useEffect(() => {
    void window.api.bugReportContext().then((c) => {
      setCtx(c)
      if (c.email) setEmail(c.email)
    })
  }, [])

  const pickScreenshot = useCallback(async () => {
    const path = await window.api.bugReportPickScreenshot()
    if (!path) return
    setScreenshotPath(path)
    setScreenshotThumb(await window.api.bugReportScreenshotThumb(path))
  }, [])

  const submit = useCallback(async () => {
    setSending(true)
    setFailure(null)
    const result = await window.api.bugReportSubmit({ body, steps, replyEmail: email, screenshotPath })
    setSending(false)
    if (result.ok) {
      setSent(true)
      // Let the "thanks" state land before the window disappears — an instant
      // close reads as "did that work?".
      setTimeout(() => void window.api.bugReportClose(), 1400)
      return
    }
    setFailure({ error: result.error, emailFallback: result.emailFallback })
  }, [body, steps, email, screenshotPath])

  if (!ctx) return <WindowFrame title="Report a Bug"><LoadingBody /></WindowFrame>

  if (sent) {
    return (
      <WindowFrame title="Report a Bug">
        <div className="flex flex-col items-center justify-center gap-3 h-[calc(100vh-2.75rem)] text-muted">
          <Check size={32} className="text-green-light" />
          <span className="text-lg text-on-surface font-semibold">Sent. Thank you.</span>
          <span className="text-md">We read every one of these.</span>
        </div>
      </WindowFrame>
    )
  }

  const canSend = body.trim().length >= BUG_REPORT_BODY_MIN && !sending

  return (
    <WindowFrame title="Report a Bug">
      <div className="p-4">
        <Card>
          <div className="flex items-center gap-2 mb-2">
            <Bug size={16} className="text-accent-text" />
            <span className="text-md font-semibold">What went wrong?</span>
          </div>
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={BUG_REPORT_LIMITS.BODY_MAX}
            placeholder="It froze when I hit the hotkey in Safari…"
            className="w-full h-24 resize-none rounded-sm bg-surface2 border border-surface3 p-2 text-md text-on-surface placeholder:text-muted focus:outline-none focus:border-accent"
          />

          <div className="text-md font-semibold mt-3 mb-1">What were you doing?</div>
          <textarea
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            maxLength={BUG_REPORT_LIMITS.STEPS_MAX}
            placeholder="Optional. The steps that led up to it."
            className="w-full h-16 resize-none rounded-sm bg-surface2 border border-surface3 p-2 text-md text-on-surface placeholder:text-muted focus:outline-none focus:border-accent"
          />

          <div className="text-md font-semibold mt-3 mb-1">Where can we reach you?</div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={BUG_REPORT_LIMITS.EMAIL_MAX}
            placeholder="Optional. Only if you want a reply."
            className="w-full rounded-sm bg-surface2 border border-surface3 p-2 text-md text-on-surface placeholder:text-muted focus:outline-none focus:border-accent"
          />

          <div className="flex items-center gap-2 mt-3">
            {screenshotThumb ? (
              <img
                src={screenshotThumb}
                alt="Attached screenshot"
                className="h-10 w-10 object-cover rounded-sm border border-surface3"
              />
            ) : null}
            <Button variant="ghost" onClick={() => void pickScreenshot()}>
              <span className="flex items-center gap-1.5">
                <ImagePlus size={14} />
                {screenshotPath ? 'Change screenshot' : 'Attach a screenshot'}
              </span>
            </Button>
            {screenshotPath ? (
              <Button
                variant="bare"
                onClick={() => {
                  setScreenshotPath(null)
                  setScreenshotThumb(null)
                }}
                className="text-muted hover:text-on-surface"
                aria-label="Remove screenshot"
              >
                <X size={14} />
              </Button>
            ) : null}
          </div>
        </Card>

        <div className="text-xlg uppercase tracking-wider text-muted font-bold mt-3 mb-1">Sent with your report</div>
        <Card>
          <DiagnosticsList d={ctx.diagnostics} />
          {ctx.activity.length > 0 ? (
            <>
              <div className="text-xlg uppercase tracking-wider text-muted font-bold mt-3 mb-1">
                Recent activity
              </div>
              <ActivityList entries={ctx.activity} />
            </>
          ) : (
            <div className="text-xlg text-muted mt-3">
              {ctx.activitySuppressed
                ? 'Recent activity is off while Incognito is on.'
                : 'No recent activity recorded yet.'}
            </div>
          )}
          <div className="text-xlg text-muted mt-3">
            No text you wrote or selected is included - only the details above.
          </div>
        </Card>

        {failure ? (
          <Card className="border-red">
            <div className="text-md font-semibold text-red mb-1">Could not send</div>
            <div className="text-xlg text-muted mb-2 break-all">{failure.error}</div>
            <Button variant="ghost" onClick={() => void window.api.bugReportEmailFallback(failure.emailFallback)}>
              <span className="flex items-center gap-1.5">
                <Mail size={14} />
                Send by email instead
              </span>
            </Button>
          </Card>
        ) : null}

        <div className="flex items-center justify-end gap-2 mt-3">
          <Button variant="ghost" onClick={() => void window.api.bugReportClose()}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSend}>
            {sending ? (
              <span className="flex items-center gap-1.5">
                <Spinner />
                Sending…
              </span>
            ) : (
              'Send report'
            )}
          </Button>
        </div>
      </div>
    </WindowFrame>
  )
}
