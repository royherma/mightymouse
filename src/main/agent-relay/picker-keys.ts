/**
 * Types a tapped `ask` answer into the terminal picker it came from. Resolving
 * the relay request is only half: the picker is a separate blocker still
 * waiting on its own keyboard read.
 *
 * Two transports. `tmux send-keys -t <pane>` is preferred wherever the origin
 * carries a pane id — addressed by id, so it lands in the right pane regardless
 * of focus and the terminal is never raised: whatever is in front stays in
 * front. Otherwise focus + synthetic CGEvent keys, which go to the FRONTMOST
 * window and are therefore only as good as the focus that preceded them.
 *
 * Arrows, not numbers: Down×N + Enter selects a row without depending on a
 * numeric binding this code cannot verify from a 306MB compiled CLI.
 */

import { execFile } from 'child_process'
import { writeFile } from 'fs'
import { devLog } from '../../shared/env'
import { resolveBinary, input } from '../platform'
import { resolveOrigin } from './origin-resolver'
import { streamCommand } from './pane-stream'
import type { RelayRequest } from './store'
import type { AgentOrigin, StartupPeek, StartupPrompt } from '../../shared/types'
import { CONFIG } from '../../shared/config'

/** Same bound as the origin resolver's: a hung tmux server must never wedge the
 *  resolution feed this runs on. */
const SEND_TIMEOUT_MS = 3000

/** Homebrew's bin is not on a GUI-launched app's PATH — a bare execFile('tmux')
 *  throws ENOENT in a packaged build while working fine from a dev terminal. */
function tmuxPath(): string | null {
  return resolveBinary('tmux')
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: SEND_TIMEOUT_MS }, (err) => {
      if (err) devLog.warn(`[agent-relay] picker key step failed: ${cmd}`, err.message)
      resolve(!err)
    })
  })
}

function capture(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: SEND_TIMEOUT_MS }, (err, stdout) => resolve(err ? null : stdout))
  })
}

/** `❯` marks the selected row, so the prefix has to allow it -- matching only
 *  whitespace made every SELECTED row invisible to the row readers below. */
const ROW_PREFIX = String.raw`[\s│|❯>]*`
const TEXT_ROW = new RegExp(`^${ROW_PREFIX}\\d+\\.\\s*Type something`, 'im')

/** Read off the pane, since the payload cannot say (see pickerPlan). Only tmux
 *  can: it reads a pane by id without touching it. Unknown counts as absent. */
async function hasTextRow(tmux: string, socket: string[], pane: string): Promise<boolean> {
  const screen = await capture(tmux, [...socket, 'capture-pane', '-p', '-t', pane])
  return screen !== null && TEXT_ROW.test(screen)
}

/** Which row the human picked, or -1 when the answer is free text rather than
 *  one of the offered options. -1 is NOT a failure: the picker's own
 *  "Type something." row takes it (see pickerPlan). */
export function optionIndex(options: string[] | undefined, answer: string | undefined): number {
  if (!options?.length || !answer) return -1
  const exact = options.indexOf(answer)
  if (exact !== -1) return exact
  const norm = (s: string): string => s.trim().toLowerCase()
  return options.findIndex((o) => norm(o) === norm(answer))
}

/** What to do with an answer: land on a row, and for free text also type it.
 *  `rowIndex` is 0-based from the first option. */
export interface PickerPlan {
  rowIndex: number
  text?: string
}

/** Free text goes to the "Type something." row, below the last option. It is
 *  not always drawn and no payload field says so, so the caller measures it —
 *  without that row, row N is some other option, so send nothing. */
export function pickerPlan(
  options: string[] | undefined,
  answer: string | undefined,
  hasTextRow: boolean
): PickerPlan | null {
  if (!options?.length || !answer?.trim()) return null
  const index = optionIndex(options, answer)
  if (index !== -1) return { rowIndex: index }
  if (!hasTextRow) return null
  return { rowIndex: options.length, text: answer }
}

/** The transports do NOT share a key vocabulary, and getting it wrong is
 *  silent: `send-keys … return` types the literal word and exits 0. */
function keysFor(index: number, transport: 'tmux' | 'cgevent'): string[] {
  const [down, enter] = transport === 'tmux' ? ['Down', 'Enter'] : ['down', 'return']
  return [...Array<string>(index).fill(down), enter]
}

/** Space toggles in place; Down advances; Submit sits one row past the options (verified live, 2026-09-26). */
export function multiSelectKeys(
  optionsLength: number,
  picks: readonly number[],
  hasTextRow: boolean
): string[] {
  if (optionsLength <= 0 || picks.length === 0) return []
  const submitRow = optionsLength + (hasTextRow ? 1 : 0)
  const sorted = [...new Set(picks)].sort((a, b) => a - b)
  const keys: string[] = []
  let row = 0
  for (const target of sorted) {
    keys.push(...Array<string>(target - row).fill('Down'))
    keys.push('Space')
    row = target
  }
  keys.push(...Array<string>(submitRow - row).fill('Down'))
  keys.push('Enter')
  return keys
}

/** Has the picker moved off the question we just answered? Keyed on the question
 *  TEXT being gone, not on "the screen changed" -- a spinner redraws while the
 *  same question still blocks. Absent capture counts as NOT advanced. */
async function advancedPast(
  tmux: string,
  socket: string[],
  pane: string,
  question: string
): Promise<boolean> {
  // The pane wraps, so a long question never appears whole; the first few words
  // survive a wrap and still identify the row.
  const needle = question.trim().split(/\s+/).slice(0, 5).join(' ')
  if (needle.length < 8) return false
  for (let attempt = 0; attempt < ADVANCE_POLLS; attempt++) {
    await delay(ADVANCE_POLL_MS)
    const screen = await capture(tmux, [...socket, 'capture-pane', '-p', '-t', pane])
    if (screen === null) return false
    // Collapse the pane's own wrapping before matching -- a question broken
    // across two lines contains no substring of the original.
    if (!screen.replace(/\s+/g, ' ').includes(needle)) return true
  }
  return false
}

/** 25 × 120ms = a 3s give-up bound per question, not the expected wait: the
 *  redraw normally lands in one or two polls. Giving up costs the REST of the
 *  burst, never a wrong answer. */
const ADVANCE_POLL_MS = 120
const ADVANCE_POLLS = 25

/** The picker is a TABBED FORM, not a wizard: answering one question can check
 *  every box at once and jump straight here (verified against a live 2-question
 *  picker, 2026-08-15). So the burst cannot assume Q2 follows Q1 -- it has to
 *  look for this screen after every answer. */
const REVIEW_ROW = new RegExp(`^${ROW_PREFIX}\\d+\\.\\s*Submit answers`, 'im')

/** Which row "Submit answers" is on, 0-based, or -1. Read rather than assumed:
 *  it has been row 1 of 2 in every capture, but a picker that adds a row above
 *  it would otherwise send Enter on Cancel. */
function submitRowIndex(screen: string): number {
  const row = new RegExp(`^${ROW_PREFIX}(\\d+)\\.\\s*(.+?)\\s*$`)
  const rows = screen.split('\n').flatMap((line) => {
    const found = row.exec(line)
    return found ? [found[2]] : []
  })
  return rows.findIndex((label) => /^Submit answers/i.test(label))
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Rejects `??` and anything that is not a macOS pty slave. */
const PTY_SLAVE = /^ttys\d+$/

async function ptyOf(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const raw = await capture('/bin/ps', ['-p', String(pid), '-o', 'tty='])
  const name = raw?.trim()
  if (!name || !PTY_SLAVE.test(name)) return null
  return `/dev/${name}`
}

function writeTty(device: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), SEND_TIMEOUT_MS)
    writeFile(device, `${body}\r`, (err) => {
      clearTimeout(timer)
      if (err) devLog.warn('[agent-relay] tty write failed', err.message)
      resolve(!err)
    })
  })
}

/** Returns which transport carried the answer. Every failure is a no-op rather
 *  than a throw: this runs on the store's resolution feed. */
export async function sendPickerAnswer(
  request: RelayRequest
): Promise<'tmux' | 'cgevent' | 'skipped'> {
  if (request.verb !== 'ask') return 'skipped'
  // A drill must never touch a real keyboard.
  if (request.params.test) return 'skipped'

  // A multi-question ask types its whole buffered burst, one question at a
  // time, confirming the picker advanced between each.
  if (request.params.questions && request.params.questions.length > 1) {
    return sendPickerBurst(request)
  }

  const options = request.params.options
  const answer = request.response?.answer
  // Cheap exit before any shell-out: a chip answer needs no screen read, and
  // nothing at all is sendable without options and an answer.
  if (!pickerPlan(options, answer, true)) return 'skipped'

  const origin = request.params.origin

  const tmux = origin?.tmuxPane ? tmuxPath() : null
  if (tmux && origin?.tmuxPane) {
    const socket = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
    // Read the pane BEFORE typing into it: this is the only transport that can
    // check whether the free-text row is really there.
    const plan = pickerPlan(options, answer, await hasTextRow(tmux, socket, origin.tmuxPane))
    if (!plan) {
      devLog.warn('[agent-relay] picker has no "Type something" row — not typing a free answer')
      return 'skipped'
    }
    // One send-keys per key: tmux takes key NAMES as separate arguments, and a
    // single call with several would still be one atomic write, but splitting
    // keeps a partial failure visible in the log rather than silent.
    let sent = true
    for (const key of keysFor(plan.rowIndex, 'tmux')) {
      sent = (await run(tmux, [...socket, 'send-keys', '-t', origin.tmuxPane, key])) && sent
    }
    if (sent && plan.text) {
      // -l is literal: without it tmux reads an answer like "Enter" or "C-c" as
      // a key name instead of the words the human typed.
      sent = await run(tmux, [...socket, 'send-keys', '-t', origin.tmuxPane, '-l', plan.text])
      if (sent) sent = await run(tmux, [...socket, 'send-keys', '-t', origin.tmuxPane, 'Enter'])
    }
    if (sent) return 'tmux'
    devLog.warn('[agent-relay] tmux send-keys failed, falling back to synthetic keys')
  }

  // No pane id (or tmux refused it): the frontmost window is the only target,
  // so focus is load-bearing rather than a courtesy. Nothing here reads the
  // screen, so free text is refused outright rather than counted down blind.
  const blindPlan = pickerPlan(options, answer, false)
  if (!blindPlan) {
    devLog.warn('[agent-relay] no tmux pane to read — free-text answers need one')
    return 'skipped'
  }
  const focused = await resolveOrigin(origin)
  if (focused === 'none') {
    devLog.warn('[agent-relay] no resolvable origin — not typing a picker answer blind')
    return 'skipped'
  }
  await input.pressKeys(keysFor(blindPlan.rowIndex, 'cgevent'))
  return 'cgevent'
}

/** TUI chrome the phone preview must not show. Matched per line so reply text
 *  between chrome rows survives. */
const PANE_CHROME: RegExp[] = [
  /^[\s─━—╌╎╭╮╰╯│]+$/, // separator / border-only rows
  /[─━—]{4,}/, // input-box header, label anywhere: "──── dev-23 ──"
  /^\s*│?\s*[❯>]\s*│?\s*$/, // empty prompt row
  /[¦╎]/, // statusline segments ("Fresh ╎ Opus 5 ╎ …") -- ╎ is U+254E, not a broken bar
  /^\s*[✱✳✶✻✽·∗*]\s*\S+\s+for\s+\d+[smh]?\b/, // spinner row -- the verb rotates ("Worked"/"Cogitated"/"Sautéed"/…), the glyph+shape does not
  /^\s*[\d,]+\s+tokens\s*$/,
  /esc to interrupt/,
  /\? for shortcuts/,
  /⏵⏵/, // permission-mode footer ("bypass permissions on · ← 3 agents")
  /^\s*(?:erm|rm|perm)issions\b/, // its wrap remainder, glyph and leading chars lost
  /^\s*clear\s*$/, // wrap remainder of the launch/clear shell line
  /⚠\s.*\/(mcp|doctor|login)\b/, // startup warnings ("5 MCP servers need authentication")
  /\b\d+\s+MCP\s+servers?\s+need\s+authentication/, // same warning, wrapped off its ⚠
  /^\s*(▐▛|▝▜|▘▘).*|Claude Code v\d/, // launch banner block + version row
  /says: \[\d{1,2}:\d{2}:\d{2} local\]/, // Stop/UserPromptSubmit hook echoes
  /^\s*[%$]\s*$/, // bare shell prompt
  /^\S+@\S+\s.*\s[%$]\s/, // shell prompt line ("user@host dir % clear")
  /^\s*claude\b.*(--|&&)/, // the launch command itself
  /^\s*\/rc\s*$/, // right-aligned statusline remnant on its own row
  /current: \d+\.\d+\.\d+ ·/, // updater row ("current: 2.1.233 · ✘ Auto-update failed")
  /\/clear to save [\d.]+k tokens/, // context-budget hint
  /\d+% until auto-compact/,
  /\(disable recaps/, // recap footer, and its two wrap remainders below
  /^\s*(recaps\s+)?in\s+\/config\)\s*$/,
  /^\s*\/config\)\s*$/
]

/** Last content lines of a pane, chrome stripped. Used by the session sheet
 *  when this agent has not sent a relay card. */
export async function capturePaneTail(
  origin: AgentOrigin | undefined,
  lines = CONFIG.AGENT_RELAY.PANE_PREVIEW_LINES,
  maxChars = CONFIG.AGENT_RELAY.PANE_PREVIEW_MAX_CHARS
): Promise<string | null> {
  const tmux = origin?.tmuxPane ? tmuxPath() : null
  if (!tmux || !origin?.tmuxPane) return null
  const socket = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
  // -S reaches into scrollback: on an idle pane the visible screen is mostly
  // input-box chrome, so the reply worth previewing has often scrolled off.
  const screen = await capture(tmux, [
    ...socket,
    'capture-pane',
    '-p',
    // -J rejoins soft-wrapped rows: without it a footer wraps into fragments
    // ("…clear" / "ermissions") that no ^-anchored chrome rule can match.
    '-J',
    '-S',
    `-${CONFIG.AGENT_RELAY.PANE_PREVIEW_SCROLLBACK}`,
    '-t',
    origin.tmuxPane
  ])
  if (!screen?.trim()) return null
  const kept: string[] = []
  for (const raw of screen.split('\n')) {
    const line = raw.replace(/\s+$/g, '')
    if (line.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1].length > 0) kept.push('')
      continue
    }
    if (PANE_CHROME.some((re) => re.test(line))) continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1].length === 0) kept.pop()
  const tail = kept
    .slice(-Math.max(1, lines))
    .join('\n')
    .replace(/^\n+/, '')
  if (!tail) return null
  // Truncate from the front: the newest lines are the ones being previewed.
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail
}

/** tmux pane first; else the shim pid's pty. Never the frontmost window. */
export async function sendPaneText(
  origin: AgentOrigin | undefined,
  text: string,
  pid?: number
): Promise<'tmux' | 'tty' | 'skipped'> {
  const body = text.trim()
  if (!body) return 'skipped'
  const tmux = origin?.tmuxPane ? tmuxPath() : null
  if (tmux && origin?.tmuxPane) {
    const socket = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
    const typed = await run(tmux, [...socket, 'send-keys', '-t', origin.tmuxPane, '-l', body])
    if (!typed) return 'skipped'
    const entered = await run(tmux, [...socket, 'send-keys', '-t', origin.tmuxPane, 'Enter'])
    return entered ? 'tmux' : 'skipped'
  }
  const device = pid === undefined ? null : await ptyOf(pid)
  if (!device) return 'skipped'
  return (await writeTty(device, body)) ? 'tty' : 'skipped'
}

/** Types every buffered answer into one picker, in question order. tmux only
 *  each question needs the pane read back to prove the picker moved
 *  on, and tmux is the only transport that can read. Stops at the first question
 *  that does not advance -- a half-typed burst leaves the human at a real picker
 *  they can finish; a blind one leaves wrong answers. */
async function sendPickerBurst(request: RelayRequest): Promise<'tmux' | 'skipped'> {
  const questions = request.params.questions
  const origin = request.params.origin
  if (!questions || !origin?.tmuxPane) return 'skipped'
  const tmux = tmuxPath()
  if (!tmux) return 'skipped'
  const socket = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
  const pane = origin.tmuxPane

  const answerFor = new Map(request.buffered.map((a) => [a.index, a.answer]))
  const picksFor = new Map(request.buffered.map((a) => [a.index, a.picks]))
  if (answerFor.size < questions.length) {
    devLog.warn('[agent-relay] picker burst has fewer answers than questions — not typing')
    return 'skipped'
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const textRowUp = await hasTextRow(tmux, socket, pane)
    let sent = true
    if (q.multiSelect) {
      const picks = picksFor.get(i)
      if (!picks?.length) {
        devLog.warn(`[agent-relay] picker burst stopped at question ${i + 1}: no picks to toggle`)
        return i === 0 ? 'skipped' : 'tmux'
      }
      for (const key of multiSelectKeys(q.options?.length ?? 0, picks, textRowUp)) {
        sent = (await run(tmux, [...socket, 'send-keys', '-t', pane, key])) && sent
      }
    } else {
      const plan = pickerPlan(q.options, answerFor.get(i), textRowUp)
      if (!plan) {
        // Which of the three refusals fired -- without these it's a guess (cost a session).
        devLog.warn(`[agent-relay] picker burst stopped at question ${i + 1}: no usable row`, {
          options: q.options?.length ?? 0,
          hasAnswer: Boolean(answerFor.get(i)?.trim()),
          matchedOption: optionIndex(q.options, answerFor.get(i)) !== -1,
          textRow: textRowUp
        })
        return i === 0 ? 'skipped' : 'tmux'
      }
      for (const key of keysFor(plan.rowIndex, 'tmux')) {
        sent = (await run(tmux, [...socket, 'send-keys', '-t', pane, key])) && sent
      }
      if (sent && plan.text) {
        sent = await run(tmux, [...socket, 'send-keys', '-t', pane, '-l', plan.text])
        if (sent) sent = await run(tmux, [...socket, 'send-keys', '-t', pane, 'Enter'])
      }
    }
    if (!sent) {
      devLog.warn(`[agent-relay] picker burst send failed at question ${i + 1}`)
      return i === 0 ? 'skipped' : 'tmux'
    }
    // Answering ONE question can fill in every tab and jump straight to review,
    // so this is checked after each answer rather than only after the last.
    // Short wait while questions remain (review is the surprise case there, and
    // a long poll would stall a picker that IS advancing); full wait on the last,
    // where review is the expected next screen.
    const last = i === questions.length - 1
    if (await submitIfReviewing(tmux, socket, pane, last ? ADVANCE_POLLS : 3)) return 'tmux'

    if (last) break
    if (!(await advancedPast(tmux, socket, pane, q.question))) {
      devLog.warn(
        `[agent-relay] picker did not advance past question ${i + 1} — stopping the burst`
      )
      return 'tmux'
    }
  }
  return 'tmux'
}

/** Lands on "Submit answers" once the review screen is up, which is the step
 *  that actually returns the answers -- without it the picker sits fully filled
 *  in and the agent keeps waiting. Returns false when review never appeared. */
async function submitIfReviewing(
  tmux: string,
  socket: string[],
  pane: string,
  polls: number
): Promise<boolean> {
  for (let attempt = 0; attempt < polls; attempt++) {
    const screen = await capture(tmux, [...socket, 'capture-pane', '-p', '-t', pane])
    if (screen !== null && REVIEW_ROW.test(screen)) {
      const row = submitRowIndex(screen)
      if (row === -1) return false
      for (const key of keysFor(row, 'tmux')) {
        await run(tmux, [...socket, 'send-keys', '-t', pane, key])
      }
      return true
    }
    await delay(ADVANCE_POLL_MS)
  }
  return false
}

const PANE_ID = /^%\d+$/
const PROMPT_FOOTER = /(?:press )?enter to (confirm|select|continue)|esc to cancel . tab to amend/i
const HOOKS_MENU_FOOTER = /Press t to trust all; enter to review hooks; esc to close/i
const HOOKS_MENU_TITLE = 'Hooks'
const OPTION_MARK = /^[❯›>]\s*/
const NUMBER = /^\d+\.\s+/
const RULE = /^[─━-]{8,}/
const DASHED_RULE = /^╌{8,}/

const indentOf = (line: string): number => line.replace(/[❯›>]/, ' ').search(/\S/)

export function parseStartupPrompt(lines: string[]): StartupPrompt | null {
  const hooksFooter = lines.findIndex((line) => HOOKS_MENU_FOOTER.test(line))
  if (hooksFooter !== -1) {
    const title = lines.findIndex((line) => line.trim() === HOOKS_MENU_TITLE)
    if (title === -1) return null
    return {
      question: HOOKS_MENU_TITLE,
      detail: lines.slice(title + 1, hooksFooter).join('\n').trim(),
      options: ['Review hooks', 'Trust all and continue', 'Back'],
      selected: 0,
      keys: ['Enter', 't', 'Escape']
    }
  }
  let footer = lines.length - 1
  while (footer >= 0 && !PROMPT_FOOTER.test(lines[footer])) footer--
  if (footer === -1) return null
  let i = footer - 1
  while (i >= 0 && lines[i].trim() === '') i--
  const block: string[] = []
  for (; i >= 0 && lines[i].trim() !== ''; i--) block.unshift(lines[i])
  const isNumbered = (l: string): boolean => NUMBER.test(l.trim().replace(OPTION_MARK, ''))
  const firstNumbered = block.findIndex(isNumbered)
  let rows: string[]
  if (block.filter(isNumbered).length >= 2) {
    rows = block.filter(isNumbered).map((l) => l.trim())
    i += firstNumbered
  } else {
    const indent = Math.min(...block.map(indentOf))
    rows = block.filter((l) => indentOf(l) === indent).map((l) => l.trim())
  }
  if (rows.length < 2) return null
  const selected = Math.max(0, rows.findIndex((l) => OPTION_MARK.test(l)))
  const options = rows.map((l) => l.replace(OPTION_MARK, '').replace(NUMBER, '').trim())

  const paragraphs: string[] = []
  let para: string[] = []
  for (; i >= -1; i--) {
    const line = i >= 0 ? lines[i].replace(/^[\s│|]+/, '').trim() : ''
    if (line.startsWith('Tip:')) continue
    if (i === -1 || line === '' || RULE.test(line) || DASHED_RULE.test(line)) {
      if (para.length > 0) paragraphs.unshift(para.join(' '))
      para = []
      if (i === -1 || RULE.test(line)) break
    } else para.unshift(line)
  }
  const askingAt = paragraphs.findIndex((p) => p.includes('?'))
  // The title scrolled off the top: a mid-sentence fragment is not the question.
  if (askingAt === -1 && i === -1 && lines[0]?.trim()) return { question: '', detail: paragraphs.join(' '), options, selected }
  const asking = Math.max(0, askingAt)
  const para0 = paragraphs[asking] ?? ''
  const cut = para0.indexOf('?') + 1
  const question = cut > 0 ? para0.slice(0, cut).trim() : para0
  const rest = [cut > 0 ? para0.slice(cut).trim() : '', ...paragraphs.filter((_, n) => n !== asking)]
  return { question, detail: rest.filter(Boolean).join(' '), options, selected }
}

export async function peekStartup(pane: string): Promise<StartupPeek> {
  const tmux = tmuxPath()
  if (!tmux || !PANE_ID.test(pane)) return { alive: false, prompt: null, tail: [] }
  const screen = await capture(tmux, ['capture-pane', '-p', '-J', '-t', pane])
  if (screen === null) return { alive: false, prompt: null, tail: [] }
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/g, ''))
  const tail = lines.filter((l) => l.trim() !== '' && !/^[─━]+$/.test(l.trim())).slice(-6)
  return { alive: true, prompt: parseStartupPrompt(lines), tail }
}

const answering = new Set<string>()

export async function answerStartup(pane: string, index: number): Promise<boolean> {
  const tmux = tmuxPath()
  if (!tmux || !PANE_ID.test(pane) || !Number.isInteger(index) || index < 0) return false
  // A second click lands on the NEXT question with the first one's index.
  if (answering.has(pane)) return false
  answering.add(pane)
  try {
    const prompt = (await peekStartup(pane)).prompt
    if (!prompt || index >= prompt.options.length) return false
    const delta = index - prompt.selected
    const step = delta < 0 ? 'Up' : 'Down'
    const keys = prompt.keys
      ? [prompt.keys[index]]
      : [...Array<string>(Math.abs(delta)).fill(step), 'Enter']
    if (!(await run(tmux, ['send-keys', '-t', pane, ...keys]))) return false
    for (let n = 0; n < ADVANCE_POLLS; n++) {
      await delay(ADVANCE_POLL_MS)
      const next = await peekStartup(pane)
      if (!next.alive || next.prompt?.question !== prompt.question) break
    }
    return true
  } finally {
    answering.delete(pane)
  }
}

export interface PaneScreen {
  text: string
  cols: number
  rows: number
  cursor?: { x: number; y: number }
  history: number
  alt: boolean
  streamed: boolean
}

/** The pane's visible screen with its SGR colour codes, as the terminal shows it, `back` lines up its history. */
export async function capturePaneScreen(origin: AgentOrigin | undefined, back = 0): Promise<PaneScreen | null> {
  const tmux = origin?.tmuxPane ? tmuxPath() : null
  if (!tmux || !origin?.tmuxPane) return null
  const socket = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
  const stream = streamCommand(origin)
  const ask = (args: string[]): Promise<string | null> => (stream ? stream(args) : capture(tmux, [...socket, ...args]))
  const grab = (range: string[]): Promise<string | null> =>
    ask(['capture-pane', '-p', '-e', '-N', ...range, '-t', origin.tmuxPane!])
  const [size, live] = await Promise.all([
    ask(['display-message', '-p', '-t', origin.tmuxPane, '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{history_size} #{alternate_on}']),
    back > 0 ? null : grab([])
  ])
  if (!size) return null
  const [cols, rows, x, y, shown, history, alt] = size.trim().split(' ').map(Number)
  if (!cols || !rows) return null
  const offset = alt ? 0 : Math.min(Math.max(0, Math.floor(back)), history)
  const text = offset > 0 ? await grab(['-S', String(-offset), '-E', String(rows - 1 - offset)]) : live ?? (await grab([]))
  if (!text) return null
  return {
    text: text.replace(/\n$/, ''),
    cols,
    rows,
    cursor: shown && offset === 0 ? { x, y } : undefined,
    history,
    alt: alt === 1,
    streamed: stream !== null
  }
}

export type PaneKey = { text: string } | { key: string } | { paste: string }

const PANE_KEY_NAMES = new Set([
  'Enter', 'BSpace', 'DC', 'Tab', 'BTab', 'Escape', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PPage', 'NPage', 'M-Enter', 'Space'
])
const CTRL_KEY = /^C-[a-z]$/

export async function sendPaneKeys(origin: AgentOrigin | undefined, keys: PaneKey[]): Promise<boolean> {
  const tmux = origin?.tmuxPane ? tmuxPath() : null
  if (!tmux || !origin?.tmuxPane || keys.length === 0) return false
  const args = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
  for (const k of keys) {
    const step =
      'text' in k && typeof k.text === 'string' && k.text !== ''
        ? ['send-keys', '-t', origin.tmuxPane, '-l', k.text]
        : 'key' in k && (PANE_KEY_NAMES.has(k.key) || CTRL_KEY.test(k.key))
          ? ['send-keys', '-t', origin.tmuxPane, k.key]
          : 'paste' in k && typeof k.paste === 'string' && k.paste !== ''
            ? ['set-buffer', '-b', 'mm-paste', '--', k.paste, ';', 'paste-buffer', '-p', '-d', '-b', 'mm-paste', '-t', origin.tmuxPane]
            : null
    if (!step) return false
    if (args.length > (origin.tmuxSocket ? 2 : 0)) args.push(';')
    args.push(...step)
  }
  return run(tmux, args)
}
