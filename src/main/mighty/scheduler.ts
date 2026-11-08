import { Notification } from 'electron'
import { CONFIG } from '../../shared/config'
import { PREFS } from '../store/prefs'
import { MIGHTY } from '../store/mighty'
import { parseTs } from '../store/history'
import { runMighty } from './run-mighty'
import { isJobDue } from '../../shared/mighty-schedule'
import { MightyJob } from '../../shared/types'

const GITHUB_POLL_MS = 120_000
const GITHUB_FIRES_PER_POLL = 3
const lastPolled = new Map<string, number>()

// ── Mighty scheduler ──────────────────────────────────────────────────────────
// One in-app tick loop owns WHEN Mighty wakes up; run-mighty owns WHAT it does.
// Mirrors the existing lightweight loops (analytics flush / updater): a single
// setInterval, no OS-level cron. A job fires at most once per due window; misses
// while the app was quit catch up on the next launch (one run per overdue job, no
// storm). The due math lives in shared/mighty-schedule.ts so it's unit-testable.

let timer: ReturnType<typeof setInterval> | null = null
// Guards against overlap: a slow run must not be re-fired by the next tick.
const running = new Set<string>()

/** Fire one job: run it via Mighty, stamp lastRun, append the result to its session, notify. */
async function fireJob(job: MightyJob, message: string = job.prompt): Promise<void> {
  if (running.has(job.id)) return
  running.add(job.id)
  // The session the run actually landed in. A job whose session was deleted (or which
  // never had one) points at nothing, and runMighty mints a fresh one — writing that id
  // back is what makes the job adopt it. Without this the job re-mints EVERY run and
  // never accumulates history, silently, forever.
  let landedSessionId = job.sessionId
  try {
    if (job.target) {
      const { startCodeSession } = await import('../ipc/agent-relay')
      const started = await startCodeSession({
        project: job.target.project,
        cwd: job.target.cwd,
        inApp: true,
        message
      })
      notifyJobDone(job, started.ok, started.ok ? `Coding agent started in ${job.target.project}.` : started.reason)
      return
    }
    const res = await runMighty({
      message,
      sessionId: job.sessionId || undefined,
      source: 'job'
    })
    if (res.sessionId) landedSessionId = res.sessionId
    notifyJobDone(job, res.error ? false : true, res.answer, landedSessionId || undefined)
  } catch (err) {
    console.error(`Mighty job "${job.name}" failed:`, err)
  } finally {
    // Stamp the ATTEMPT, not the success — and in `finally` so a thrown run stamps too.
    // lastRun is the only marker isJobDue reads, so leaving it unset after a failure
    // keeps the window due and re-fires the job every tick, forever (60s apart), which
    // is exactly what happened. One attempt per window; a failure waits for the next.
    MIGHTY.upsertJob({
      ...job,
      sessionId: landedSessionId,
      lastRun: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    })
    running.delete(job.id)
  }
}

/** Native notification so the proactive output reaches the user even with the app in back. */
function notifyJobDone(job: MightyJob, ok: boolean, summary: string, sessionId?: string): void {
  if (!Notification.isSupported()) return
  try {
    const name = PREFS.getMightyName()
    const body = ok
      ? summary.slice(0, 180) || `${name} finished "${job.name}".`
      : `${name} couldn't finish "${job.name}".`
    const notification = new Notification({
      title: `${name} · ${job.name}`,
      body
    })
    // The body is a 180-char slice of the answer, so the full result is only
    // reachable by opening the job's own chat -- without this a click did
    // nothing and the rest of the output had no way in. Lazily imported: this
    // module is on the scheduler path and must not pull the window graph in at
    // load, the same constraint mac-notification.ts has.
    notification.on('click', () => {
      void import('./mighty-window').then(({ showMightyWindow }) => {
        showMightyWindow(false, sessionId)
      })
    })
    notification.show()
  } catch (err) {
    console.error('Failed to show Mighty notification:', err)
  }
}

/** Check all enabled jobs and fire any that are due. Called by the tick + once at launch. */
async function pollGithubJob(job: MightyJob, nowMs: number): Promise<void> {
  const trigger = job.trigger
  if (!trigger || running.has(job.id) || nowMs - (lastPolled.get(job.id) ?? 0) < GITHUB_POLL_MS) return
  lastPolled.set(job.id, nowMs)
  try {
    const { fetchGithubItems, splitNewItems, describeGithubItem } = await import('./github-trigger')
    const { fresh, seen } = splitNewItems(await fetchGithubItems(trigger.repoCwd, trigger.event), trigger.seen)
    const armed: MightyJob = { ...job, trigger: { ...trigger, seen } }
    MIGHTY.upsertJob(armed)
    for (const item of fresh.slice(0, GITHUB_FIRES_PER_POLL)) await fireJob(armed, describeGithubItem(trigger.event, item, job.prompt))
  } catch (err) {
    console.error(`GitHub trigger for "${job.name}" failed:`, err)
  }
}

function checkDueJobs(now: Date): void {
  for (const job of MIGHTY.listJobs()) {
    if (job.enabled && job.trigger) {
      void pollGithubJob(job, now.getTime())
      continue
    }
    if (!job.enabled || job.schedule === 'manual') continue
    const lastRun = job.lastRun ? parseTs(job.lastRun) : null
    if (isJobDue(job.schedule, job.hour, lastRun, now)) {
      void fireJob(job)
    }
  }
}

/** Start the tick loop. Idempotent. Runs an immediate catch-up pass for missed fires. */
export function startMightyScheduler(): void {
  if (timer) return
  // Catch-up: a job whose due window passed while the app was quit fires once now.
  checkDueJobs(new Date())
  timer = setInterval(() => checkDueJobs(new Date()), CONFIG.MIGHTY.TICK_MS)
}

/** Stop the tick loop (on sign-out / app-tail teardown). */
export function stopMightyScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Run a job on demand (the Jobs-tab "run now" button), bypassing the schedule. */
export async function runJobNow(jobId: string): Promise<boolean> {
  const job = MIGHTY.getJob(jobId)
  if (!job) return false
  await fireJob(job)
  return true
}
