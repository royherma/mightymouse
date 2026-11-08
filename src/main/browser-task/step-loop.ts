import type { WebContents } from 'electron'
import { appendFileSync } from 'fs'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import type {
  BrowserStepsResult,
  BrowserTaskFailure,
  BrowserTaskProgress,
  BrowserTaskRequest,
  PageRead
} from '../../shared/types'
import { needsOwner } from '../actions/computer-use/loop'
import { PATHS } from '../store/paths'
import { siblingTabs } from '../side-browser'
import { controlLine, fillFields, pressControl, readPage } from './page-driver'
import { fillFromDocuments } from './form-fill'
import { askTaskModel, taskModelChain, taskModelName } from './task-model'

const TASK = CONFIG.BROWSER_TASK

type Say = (progress: Omit<BrowserTaskProgress, 'tabId'>) => void

type Action = { tab?: string } & (
  | { do: 'press'; ref: string }
  | { do: 'fill'; values: Record<string, string> }
  | { do: 'fill_from_files' }
  | { do: 'open'; url: string }
  | { do: 'back' }
  | { do: 'scroll'; dir: 'up' | 'down' }
  | { do: 'wait' }
  | { do: 'ask'; question: string }
  | { do: 'done'; answer: string }
)

type TabView = { id: string; wc: WebContents; page: PageRead }

export class StepControl {
  paused = false
  stopped = false
  private notes: string[] = []
  private wake: (() => void) | null = null

  command(cmd: 'pause' | 'resume' | 'stop', note?: string): void {
    if (note?.trim()) this.notes.push(note.trim())
    if (cmd === 'pause') this.paused = true
    if (cmd === 'resume') this.paused = false
    if (cmd === 'stop') this.stopped = true
    if (!this.paused || this.stopped) this.wake?.()
  }

  async gate(): Promise<void> {
    while (this.paused && !this.stopped) await new Promise<void>((r) => (this.wake = r))
    this.wake = null
  }

  takeNotes(): string[] {
    return this.notes.splice(0)
  }
}

const SYSTEM_PROMPT =
  'You operate a web browser for the user, one action at a time, until their goal is done. ' +
  'Each turn you get the goal, what you did so far, and EVERY open tab at once: its text and numbered controls. ' +
  'You see all tabs already - never switch just to look. Add "tab":"<tab id>" to any action to do it in that tab (default: the current tab, marked *). ' +
  'Reply with ONLY one JSON object, one of:\n' +
  '{"do":"press","ref":"<n>","say":"..."} click a button or link\n' +
  '{"do":"fill","values":{"<n>":"<text>"},"say":"..."} type into fields (several at once is fine; for a select use one of its options exactly; checkbox "yes"/"no")\n' +
  '{"do":"fill_from_files","say":"..."} fill this page\'s form from the files the user attached\n' +
  '{"do":"open","url":"https://...","say":"..."} go to an address in this tab\n' +
  '{"do":"back","say":"..."}  {"do":"scroll","dir":"down","say":"..."}  {"do":"wait","say":"..."}\n' +
  '{"do":"ask","question":"..."} you need the user: a choice only they can make, a login, a missing fact\n' +
  '{"do":"done","answer":"..."} goal reached; answer = what you did or what you found, 1-3 short sentences\n' +
  '"say" is a short plain line for the user, like "Opening the newest thread" or "Writing the reply". ' +
  'Rules: never invent facts about the user. Never fill passwords or card numbers - ask instead. ' +
  'The user presses buttons that post, send, submit, pay or delete: when that is the last step left, fill everything, then "done" and say it is ready for them to press. ' +
  'When writing text for the user (a reply, a message), write it in full, the way they would, and put it straight into the field. ' +
  'If an action did not change anything, try something different. Links that open a new tab become the current tab.'

function parseAction(raw: string): (Action & { say?: string }) | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const a = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const say = typeof a.say === 'string' ? a.say : undefined
    const action = toAction(a, say)
    return action && a.tab != null ? { ...action, tab: String(a.tab) } : action
  } catch {
    return null
  }
}

function toAction(
  a: Record<string, unknown>,
  say: string | undefined
): (Action & { say?: string }) | null {
  switch (a.do) {
    case 'press':
      return a.ref == null ? null : { do: 'press', ref: String(a.ref), say }
    case 'fill':
      if (!a.values || typeof a.values !== 'object') return null
      return {
        do: 'fill',
        values: Object.fromEntries(Object.entries(a.values).map(([k, v]) => [k, String(v)])),
        say
      }
    case 'open':
      return typeof a.url === 'string' ? { do: 'open', url: a.url, say } : null
    case 'scroll':
      return { do: 'scroll', dir: a.dir === 'up' ? 'up' : 'down', say }
    case 'ask':
      return { do: 'ask', question: String(a.question ?? 'What should I do next?') }
    case 'done':
      return { do: 'done', answer: String(a.answer ?? 'Done.') }
    case 'fill_from_files':
    case 'back':
    case 'wait':
      return { do: a.do, say }
    default:
      return null
  }
}

async function settle(wc: WebContents): Promise<void> {
  await new Promise((r) => setTimeout(r, TASK.PRESS_SETTLE_MS))
  if (!wc.isLoading()) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TASK.LOAD_WAIT_MS)
    wc.once('did-stop-loading', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function readTab(wc: WebContents): Promise<PageRead> {
  try {
    return await readPage(wc)
  } catch {
    await settle(wc)
    return readPage(wc).catch(() => ({
      url: wc.getURL(),
      title: wc.getTitle(),
      controls: [],
      text: '',
      ms: 0
    }))
  }
}

function describeTab(t: TabView, current: boolean): string[] {
  const controls = t.page.controls.filter((c) => !c.disabled)
  return [
    `=== ${current ? '* ' : ''}Tab ${t.id}: ${t.page.title} (${t.page.url})`,
    'Text:',
    (current ? t.page.text : t.page.text.slice(0, TASK.SIDE_TAB_TEXT)) || '(no text)',
    'Controls:',
    ...(current ? controls : controls.slice(0, TASK.SIDE_TAB_CONTROLS)).map(controlLine)
  ]
}

async function newTabAfter(tabId: string, before: Set<string>): Promise<string | null> {
  const until = Date.now() + TASK.NEW_TAB_WAIT_MS
  while (Date.now() < until) {
    const fresh = siblingTabs(tabId).find((t) => !before.has(t.id))
    if (fresh) return fresh.id
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}

function logRun(row: Record<string, unknown>): void {
  try {
    appendFileSync(
      PATHS.COMPUTER_USE_LOG,
      JSON.stringify({ at: new Date().toISOString(), driver: 'page', type: 'steps', ...row }) + '\n'
    )
  } catch (err) {
    devLog.warn('[browser-task] log failed:', (err as Error).message)
  }
}

export async function runSteps(
  startTab: string,
  req: BrowserTaskRequest,
  control: StepControl,
  say: Say
): Promise<BrowserStepsResult | BrowserTaskFailure> {
  const unthrottled = new Set<WebContents>()
  try {
    return await stepLoop(startTab, req, control, say, unthrottled)
  } finally {
    for (const wc of unthrottled) if (!wc.isDestroyed()) wc.setBackgroundThrottling(true)
  }
}

async function stepLoop(
  startTab: string,
  req: BrowserTaskRequest,
  control: StepControl,
  say: Say,
  unthrottled: Set<WebContents>
): Promise<BrowserStepsResult | BrowserTaskFailure> {
  const started = Date.now()
  const done: string[] = []
  const recent: string[] = []
  let tabId = startTab
  let costUsd = 0
  let steps = 0
  let typed = false
  let used = ''
  const work =[...new Set([startTab, ...(req.tabs ?? [])])]
  const finish = (answer: string): BrowserStepsResult => {
    logRun({
      outcome: 'done',
      goal: req.instruction,
      steps,
      ms: Date.now() - started,
      costUsd,
      model: used,
      trail: done
    })
    return { ok: true, kind: 'steps', answer, steps, ms: Date.now() - started, costUsd }
  }
  const pauseFor = async (why: string): Promise<void> => {
    control.paused = true
    say({ line: why, paused: why })
    await control.gate()
  }

  for (; steps < TASK.MAX_STEPS; steps++) {
    await control.gate()
    if (control.stopped) return finish('Stopped.')
    for (const note of control.takeNotes()) done.push(`The user said: ${note}`)

    const tabs = siblingTabs(startTab)
    const live = tabs.filter((t) => work.includes(t.id))
    if (!live.length)
      return { ok: false, reason: 'The browser tab closed', ms: Date.now() - started }
    if (!live.some((t) => t.id === tabId)) tabId = live.at(-1)!.id
    const shown = [live.find((t) => t.id === tabId)!, ...live.filter((t) => t.id !== tabId)].slice(
      0,
      TASK.MAX_WORK_TABS
    )
    for (const t of shown) {
      if (unthrottled.has(t.wc)) continue
      t.wc.setBackgroundThrottling(false)
      unthrottled.add(t.wc)
    }

    say({ line: steps === 0 ? 'Reading the page' : 'Looking at the page' })
    const views: TabView[] = await Promise.all(
      shown.map(async (t) => ({ ...t, page: await readTab(t.wc) }))
    )
    const prompt = [
      `Goal: ${req.instruction}`,
      req.context ? `Notes from the user:\n${req.context}` : '',
      req.files.length
        ? `Attached files: ${req.files.map((f) => f.split('/').pop()).join(', ')}`
        : '',
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Done so far:',
      ...(done.length ? done.slice(-TASK.STEP_HISTORY) : ['(nothing yet)']),
      '',
      ...views.flatMap((v) => describeTab(v, v.id === tabId))
    ]
      .filter((l) => l !== '')
      .join('\n')

    say({ line: 'Thinking' })
    let action: (Action & { say?: string }) | null = null
    let reason = 'no answer'
    for (const model of taskModelChain(TASK.STEP_MODELS)) {
      used = taskModelName(model)
      const res = await askTaskModel(model, {
        system: SYSTEM_PROMPT,
        userPrompt: prompt,
        feature: TASK.FEATURE,
        timeoutMs: TASK.STEP_TIMEOUT_MS,
        maxTokens: TASK.STEP_MAX_TOKENS
      })
      if (!res.ok) {
        reason = res.reason
        continue
      }
      costUsd += res.trail.costUsdMicros / 1_000_000
      action = parseAction(res.text)
      if (action) break
      reason = 'unreadable answer'
    }
    if (control.stopped) return finish('Stopped.')
    if (!action) {
      logRun({ outcome: 'failed', reason, model: used, goal: req.instruction, steps, trail: done })
      return {
        ok: false,
        reason: `Could not decide the next step (${reason})`,
        ms: Date.now() - started
      }
    }

    const target = views.find((v) => v.id === (action.tab ?? tabId))
    if (!target) {
      done.push(`${steps + 1}. No tab with id ${action.tab}.`)
      continue
    }
    const { wc, page } = target
    if (target.id !== tabId) {
      tabId = target.id
      say({ line: `Working in ${page.title || 'the other tab'}`, showTab: tabId })
    }
    const signature = JSON.stringify({ ...action, say: undefined, url: page.url })
    recent.push(signature)
    if (recent.length > TASK.MAX_SAME_ACTION) recent.shift()
    if (recent.length === TASK.MAX_SAME_ACTION && recent.every((s) => s === signature)) {
      recent.length = 0
      done.push('Repeated the same action 3 times without progress.')
      await pauseFor("I'm going in circles. Tell me what to do, then Continue")
      continue
    }

    const label = (ref: string): string =>
      page.controls.find((c) => c.ref === ref)?.label || `item ${ref}`
    const step = (line: string, outcome: string): void => {
      done.push(`${steps + 1}. ${outcome}`)
      say({ line, step: true })
    }

    switch (action.do) {
      case 'done':
        return finish(action.answer)
      case 'ask':
        done.push(`${steps + 1}. Asked the user: ${action.question}`)
        await pauseFor(action.question)
        break
      case 'press': {
        const name = label(action.ref)
        if (needsOwner(name, typed)) {
          done.push(`${steps + 1}. Left "${name}" for the user to press.`)
          await pauseFor(`Your turn: press "${name}", then Continue`)
          break
        }
        const before = new Set(tabs.map((t) => t.id))
        const ok = await pressControl(wc, action.ref).catch(() => false)
        await settle(wc)
        const opened = ok ? await newTabAfter(startTab, before) : null
        if (opened) {
          tabId = opened
          work.push(opened)
          say({ line: action.say ?? `Pressed "${name}"`, step: true, showTab: opened })
          done.push(
            `${steps + 1}. Pressed "${name}" - it opened a new tab (id ${opened}), now working there.`
          )
        } else
          step(
            action.say ?? `Pressed "${name}"`,
            ok ? `Pressed "${name}". Now on ${wc.getURL()}` : `Could not press "${name}".`
          )
        break
      }
      case 'fill': {
        const safe = Object.fromEntries(
          Object.entries(action.values).filter(
            ([r]) => !page.controls.find((c) => c.ref === r)?.secret
          )
        )
        const results = await fillFields(wc, safe).catch(() => [])
        typed ||= results.some((r) => r.ok)
        const good = results.filter((r) => r.ok).map((r) => label(r.ref))
        const bad = results.filter((r) => !r.ok).map((r) => label(r.ref))
        step(
          action.say ?? `Filled ${good.join(', ')}`,
          `Filled ${good.join(', ') || 'nothing'}${bad.length ? `; could not fill ${bad.join(', ')}` : ''}.`
        )
        break
      }
      case 'fill_from_files': {
        if (!req.files.length) {
          done.push(`${steps + 1}. fill_from_files failed: no files attached.`)
          break
        }
        const r = await fillFromDocuments(wc, { ...req, instruction: req.instruction }, (line) =>
          say({ line })
        )
        typed ||= r.ok && r.filled.length > 0
        step(
          action.say ?? 'Filled the form from your files',
          r.ok
            ? `Filled from files: ${r.filled.join(', ')}`
            : `Filling from files failed: ${r.reason}`
        )
        break
      }
      case 'open': {
        const url = /^[a-z]+:\/\//i.test(action.url) ? action.url : `https://${action.url}`
        if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
          done.push(`${steps + 1}. Refused to open ${url}: only web pages.`)
          break
        }
        await wc.loadURL(url).catch(() => {})
        await settle(wc)
        step(action.say ?? `Opened ${new URL(url).host}`, `Opened ${wc.getURL()}`)
        break
      }
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
        await settle(wc)
        step(action.say ?? 'Went back', `Went back to ${wc.getURL()}`)
        break
      case 'scroll':
        await wc
          .executeJavaScript(
            `window.scrollBy(0, ${action.dir === 'up' ? -1 : 1} * innerHeight * 0.8)`
          )
          .catch(() => {})
        await settle(wc)
        step(action.say ?? `Scrolled ${action.dir}`, `Scrolled ${action.dir}.`)
        break
      case 'wait':
        await new Promise((r) => setTimeout(r, 1_500))
        await settle(wc)
        step(action.say ?? 'Waited for the page', 'Waited.')
        break
    }
  }
  return finish(`Stopped after ${TASK.MAX_STEPS} steps. Press Go to keep going.`)
}
