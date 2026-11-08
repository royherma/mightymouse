import { ipcMain, type WebContents } from 'electron'
import { execFile } from 'child_process'
import { appendFileSync, readFileSync, statSync } from 'fs'
import { extname, basename } from 'path'
import { promisify } from 'util'
import { CONFIG } from '../../shared/config'
import { CHANNELS } from '../../shared/ipc'
import { devLog } from '../../shared/env'
import type {
  BrowserFillResult,
  BrowserTaskControl,
  BrowserTaskModel,
  BrowserTaskProgress,
  BrowserTaskRequest,
  PageControl
} from '../../shared/types'
import { PATHS } from '../store/paths'
import { tabContents } from '../side-browser'
import { needsOwner } from '../actions/computer-use/loop'
import { clearMarks, controlLine, fillFields, markFields, pressControl, readPage } from './page-driver'
import { askTaskModel, setTaskModel, taskModelChain, taskModelName, taskModelsState } from './task-model'

const TASK = CONFIG.BROWSER_TASK
const execFileAsync = promisify(execFile)
const FILLABLE = new Set<PageControl['kind']>([
  'text', 'email', 'tel', 'url', 'number', 'search', 'date', 'month', 'week', 'time',
  'datetime-local', 'checkbox', 'radio', 'textarea', 'select', 'combobox', 'editable'
])
const PLAIN = new Set(['.txt', '.md', '.csv', '.json', '.tsv', '.yaml', '.yml', '.log'])
const TEXTUTIL = new Set(['.docx', '.doc', '.rtf', '.rtfd', '.odt', '.html', '.htm', '.webarchive', '.pages'])

const PDF_JXA = `function run(argv){ObjC.import('PDFKit');const d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));return d.isNil()?'':ObjC.unwrap(d.string);}`

async function readDocument(path: string): Promise<string> {
  if (statSync(path).size > TASK.MAX_FILE_BYTES) throw new Error(`${basename(path)} is too big`)
  const ext = extname(path).toLowerCase()
  if (PLAIN.has(ext)) return readFileSync(path, 'utf-8')
  if (ext === '.pdf') {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', PDF_JXA, path], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: TASK.DOC_TIMEOUT_MS
    })
    return stdout
  }
  if (TEXTUTIL.has(ext)) {
    const { stdout } = await execFileAsync('textutil', ['-convert', 'txt', '-stdout', path], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: TASK.DOC_TIMEOUT_MS
    })
    return stdout
  }
  throw new Error(`Can't read ${ext || 'this kind of'} file yet`)
}

const SYSTEM_PROMPT =
  'You fill in a web form for the user from their own documents and notes. ' +
  'You get the form as numbered fields and the source text. Reply with ONLY a JSON object: ' +
  '{"fields": {"<field number>": {"v": "<value>", "c": <confidence 0-1>}}, "press": ["<button number>"]}. ' +
  'Rules: take facts from the source text or the instruction - never make up a fact the source does not support. ' +
  'The source was written without seeing this form, so fit it to the form the way the user would: ' +
  'reword or shorten to fit a field, pick the option closest to what the source means, split or merge items to match the rows the form has, ' +
  'and move a date that is already past or too soon to the nearest sensible future date, keeping the gaps between dates. ' +
  'Leave a field out when the source gives nothing to base it on. ' +
  'For a select field, "v" must be one of its options, copied exactly. For a checkbox, "v" is "yes" or "no". ' +
  'For a radio button, include only the one button to pick, with "v": "yes". ' +
  'Match the format the field asks for (dates as the field shows them, phone with country code if the field has one). ' +
  'Keep a field\'s current value unless the source clearly gives a different one; leave out fields that already hold the right value. ' +
  'Count rows: when the source lists more items than the form has rows for (3 milestones, 1 milestone row), fill the rows you have ' +
  'and add "press": ["<button number>", ...] with the add button once per missing row. The new rows come to you next round. ' +
  'Never press a button that submits, sends or cancels.'

interface ModelAnswer {
  values: Record<string, { v: string; c: number }>
  press: string[]
  model: string
  ms: number
  costUsd: number
}

function parseAnswer(
  raw: string,
  known: Set<string>,
  pressable: Set<string>
): Pick<ModelAnswer, 'values' | 'press'> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { fields?: Record<string, unknown>; press?: unknown }
    const out: ModelAnswer['values'] = {}
    for (const [ref, entry] of Object.entries(parsed.fields ?? {})) {
      if (!known.has(ref) || !entry || typeof entry !== 'object') continue
      const { v, c } = entry as { v?: unknown; c?: unknown }
      if (typeof v !== 'string' && typeof v !== 'number') continue
      out[ref] = { v: String(v), c: typeof c === 'number' ? c : 0.5 }
    }
    const press = Array.isArray(parsed.press) ? parsed.press.map(String).filter((r) => pressable.has(r)) : []
    return { values: out, press }
  } catch {
    return null
  }
}

// Fast model first; an unreadable or empty answer goes up one model, never down.
async function mapFields(
  prompt: string,
  known: Set<string>,
  pressable: Set<string>
): Promise<ModelAnswer | string> {
  let spent = 0
  let lastReason = 'no answer'
  for (const pick of taskModelChain(TASK.FILL_MODELS)) {
    const model = taskModelName(pick)
    const res = await askTaskModel(pick, {
      system: SYSTEM_PROMPT,
      userPrompt: prompt,
      feature: TASK.FEATURE,
      timeoutMs: TASK.FILL_TIMEOUT_MS,
      maxTokens: TASK.FILL_MAX_TOKENS
    })
    spent += res.ms
    if (!res.ok) {
      lastReason = res.reason
      continue
    }
    const answer = parseAnswer(res.text, known, pressable)
    if (answer && (Object.keys(answer.values).length > 0 || answer.press.length > 0)) {
      return { ...answer, model, ms: spent, costUsd: res.trail.costUsdMicros / 1_000_000 }
    }
    lastReason = answer ? 'nothing in your files matches this form' : 'unreadable answer'
  }
  return lastReason
}

function logRun(row: Record<string, unknown>): void {
  try {
    appendFileSync(
      PATHS.COMPUTER_USE_LOG,
      JSON.stringify({ at: new Date().toISOString(), driver: 'page', type: 'fill', ...row }) + '\n'
    )
  } catch (err) {
    devLog.warn('[browser-task] log failed:', (err as Error).message)
  }
}

export async function fillFromDocuments(
  wc: WebContents,
  req: BrowserTaskRequest,
  say: (line: string) => void
): Promise<BrowserFillResult> {
  const started = Date.now()
  const fail = (reason: string): BrowserFillResult => {
    logRun({ outcome: 'failed', reason, ms: Date.now() - started })
    return { ok: false, reason, ms: Date.now() - started }
  }

  say('Reading your files and the page')
  const docStarted = Date.now()
  const [firstPage, docs] = await Promise.all([
    readPage(wc),
    Promise.all(
      req.files.map(async (f) => {
        try {
          return { name: basename(f), text: (await readDocument(f)).trim() }
        } catch (err) {
          return { name: basename(f), error: (err as Error).message }
        }
      })
    )
  ])
  const docMs = Date.now() - docStarted
  let page = firstPage
  const unreadable = docs.find((d) => 'error' in d)
  if (unreadable && 'error' in unreadable) return fail(unreadable.error ?? 'unreadable file')

  const isField = (c: PageControl): boolean => FILLABLE.has(c.kind) && !c.secret && !c.disabled
  if (!page.controls.some(isField)) return fail('No form fields on this page')

  const source = [
    req.context ? `Notes from the user:\n${req.context}` : '',
    ...docs.map((d) => ('text' in d ? `File "${d.name}":\n${d.text}` : ''))
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, TASK.MAX_SOURCE_CHARS)
  if (!source && !req.instruction.trim()) return fail('Add a file or some notes to fill from')

  const labels = new Map<string, string>()
  const confidence = new Map<string, number>()
  const offered = new Set<string>()
  const filled = new Set<string>()
  const failed = new Set<string>()
  const pressedBefore = new Set<string>()
  let modelMs = 0
  let costUsd = 0
  let model = ''
  let rounds = 0
  const passes: Array<{
    model: string
    ms: number
    fields: number
    pressed: number
    failed: string[]
    shown: string[]
    answer: Record<string, string | string[]>
  }> = []
  let fields: PageControl[] = []
  for (; rounds < TASK.MAX_ROUNDS; rounds++) {
    if (rounds > 0) page = await readPage(wc)
    fields = page.controls.filter(isField)
    const fresh = fields.filter((f) => !offered.has(f.ref))
    if (fresh.length === 0) break
    const buttons = page.controls.filter(
      (c) =>
        c.kind === 'button' && !c.disabled && c.label && !pressedBefore.has(c.ref) && !needsOwner(c.label, true)
    )
    for (const c of [...fields, ...buttons]) labels.set(c.ref, c.label || `field ${c.ref}`)

    say(rounds === 0 ? `Matching ${fields.length} fields` : `Filling ${fresh.length} new fields`)
    const prompt = [
      `Instruction: ${req.instruction || 'Fill in this form.'}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      `Page: ${page.title} (${page.url})`,
      'Fields:',
      ...fields.map(controlLine),
      ...(buttons.length ? ['', 'Buttons:', ...buttons.map(controlLine)] : []),
      '',
      'Source text:',
      source || '(none - use the instruction only)'
    ].join('\n')
    const answer = await mapFields(
      prompt,
      new Set(fields.map((f) => f.ref)),
      new Set(buttons.map((b) => b.ref))
    )
    if (typeof answer === 'string') {
      if (rounds === 0) {
        logRun({ outcome: 'failed', reason: answer, url: page.url, lines: fields.map(controlLine).slice(0, 40) })
        return { ok: false, reason: answer, ms: Date.now() - started }
      }
      break
    }
    modelMs += answer.ms
    costUsd += answer.costUsd
    model = answer.model
    for (const f of fresh) offered.add(f.ref)

    const values = Object.fromEntries(Object.entries(answer.values).map(([r, a]) => [r, a.v]))
    for (const [r, a] of Object.entries(answer.values)) confidence.set(r, a.c)
    const results = await fillFields(wc, values)
    passes.push({
      model: answer.model,
      ms: answer.ms,
      fields: results.length,
      pressed: answer.press.length,
      failed: results.filter((r) => !r.ok).map((r) => `${labels.get(r.ref)}=${values[r.ref]}: ${r.reason}`),
      shown: [...fields, ...buttons].map(controlLine).map((l) => l.slice(0, 160)),
      answer: { ...values, press: answer.press }
    })
    for (const r of results) {
      if (r.ok) {
        filled.add(r.ref)
        failed.delete(r.ref)
      } else if (!filled.has(r.ref)) failed.add(r.ref)
    }
    for (const ref of answer.press) pressedBefore.add(ref)
    for (const ref of answer.press) {
      say(`Pressing ${labels.get(ref)}`)
      await pressControl(wc, ref)
      await new Promise((r) => setTimeout(r, TASK.PRESS_SETTLE_MS))
    }
  }

  const unsure = [...filled].filter((r) => (confidence.get(r) ?? 1) < TASK.UNSURE_BELOW)
  const missing = fields.filter((f) => f.required && !f.value && !filled.has(f.ref)).map((f) => f.ref)
  const labelOf = (ref: string): string => labels.get(ref) ?? `field ${ref}`

  await clearMarks(wc)
  await markFields(wc, [...filled].filter((r) => !unsure.includes(r)), TASK.MARK_FILLED)
  await markFields(wc, [...unsure, ...failed, ...missing], TASK.MARK_CHECK)

  const ms = Date.now() - started
  logRun({
    outcome: 'done',
    rounds,
    passes,
    fields: fields.length,
    filled: filled.size,
    unsure: unsure.length,
    failed: failed.size,
    missing: missing.length,
    readMs: page.ms,
    docMs,
    modelMs,
    model,
    costUsd,
    ms
  })
  return {
    ok: true,
    kind: 'fill',
    filled: [...filled].map(labelOf),
    unsure: unsure.map(labelOf),
    missing: missing.map(labelOf),
    failed: [...failed].map(labelOf),
    ms,
    readMs: page.ms,
    docMs,
    modelMs,
    costUsd
  }
}

const runs = new Map<string, import('./step-loop').StepControl>()

export function registerBrowserTaskHandlers(): void {
  ipcMain.handle(CHANNELS.browserTaskModels, () => taskModelsState())
  ipcMain.handle(CHANNELS.browserTaskSetModel, (_, choice: BrowserTaskModel) => setTaskModel(choice))
  ipcMain.handle(CHANNELS.browserTaskControl, (_, tabId: string, command: BrowserTaskControl, note?: string) => {
    runs.get(tabId)?.command(command, note)
  })
  ipcMain.handle(CHANNELS.browserTaskRun, async (event, tabId: string, req: BrowserTaskRequest) => {
    const wc = tabContents(tabId)
    if (!wc) return { ok: false, reason: 'That tab is closed', ms: 0 }
    const send = (progress: Omit<BrowserTaskProgress, 'tabId'>): void => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.browserTaskProgress, { tabId, ...progress })
    }
    wc.setBackgroundThrottling(false)
    try {
      if (!req.instruction.trim()) return await fillFromDocuments(wc, req, (line) => send({ line }))
      const mods = await import('./site-mods')
      if (!req.files.length && mods.isModRequest(wc, req.instruction, req.editMod))
        return await mods.previewSiteMod(wc, req.instruction, (line) => send({ line }), req.editMod)
      const { StepControl, runSteps } = await import('./step-loop')
      const control = new StepControl()
      runs.get(tabId)?.command('stop')
      runs.set(tabId, control)
      try {
        return await runSteps(tabId, req, control, send)
      } finally {
        if (runs.get(tabId) === control) runs.delete(tabId)
      }
    } catch (err) {
      devLog.warn('[browser-task] run failed:', (err as Error).message)
      return { ok: false, reason: (err as Error).message, ms: 0 }
    } finally {
      if (!wc.isDestroyed()) wc.setBackgroundThrottling(true)
    }
  })
}
