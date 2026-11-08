import { CONFIG } from '../../../shared/config'
import { context, input } from '../../platform'
import { devLog } from '../../../shared/env'
import { dumpElements } from './ui-dump'
import { rankElements, isTextTarget } from './ui-rank'
import type {
  ActionContextSnapshot,
  ActionDefinition,
  ActionRunInput,
  ActionRunResult,
  ActionSlotOption,
  Capability
} from '../../../shared/action-engine'

// The dump costs ~1.4s and the tree barely moves while a user is reading one
// page, so a second command against the same window reuses the first answer
// instead of paying it twice. Keyed on window title: a new tab is a new tree.
const DUMP_CACHE_MS = 20_000

// Long enough for a web app to repaint after the press, short enough that a
// control which never confirms still answers inside the run.
const PRESS_TIMEOUT_MS = 4_000

let cacheKey = ''
let cacheAt = 0
let cached: Awaited<ReturnType<typeof dumpElements>> = []
let inflight: { key: string; promise: Promise<typeof cached> } | null = null

async function elementsFor(ctx: ActionContextSnapshot): Promise<typeof cached> {
  const key = `${ctx.bundleId}\u0000${ctx.windowTitle}`
  if (key === cacheKey && Date.now() - cacheAt < DUMP_CACHE_MS) return cached
  if (inflight?.key === key) return inflight.promise
  const promise = dumpElements(ctx.bundleId)
    .then((rows) => {
      const kept = rows.filter((el) => el.offscreen !== true)
      cacheKey = key
      cacheAt = Date.now()
      cached = kept
      return kept
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
  inflight = { key, promise }
  return promise
}

function clickAction(bundleId: string, options: ReturnType<typeof rankElements>): ActionDefinition {
  return {
    id: 'ui.click',
    capabilityId: 'ui',
    title: 'Click something on screen',
    when:
      'The user wants a button, link, tab or control in the app they are looking at pressed — ' +
      'anything phrased as clicking, pressing, tapping, opening, toggling or activating a named ' +
      'thing on screen. Choose this when no more specific action fits but the thing they named ' +
      'is in the list of controls.',
    icon: 'app-window',
    appBundleId: bundleId,
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'phone'],
    slots: [
      {
        kind: 'choice',
        key: 'target',
        label: 'Control',
        ask: 'Which control on screen should be pressed?',
        options
      }
    ],
    async run(input: ActionRunInput): Promise<ActionRunResult> {
      const target = String(input.slots.target ?? '')
      if (target === '') return { ok: false, line: 'No control chosen.' }

      const result = await context.axPress({
        bundleId,
        press: [target],
        timeoutMs: PRESS_TIMEOUT_MS
      })
      devLog.log('[ui.click]', bundleId, target, result.status, `${result.ms}ms`)

      if (result.status === 'already') {
        return { ok: true, line: `${target} was already set.` }
      }
      if (result.status === 'ok') {
        return { ok: true, line: `Pressed ${target}.` }
      }
      // The press was delivered but the screen never changed. Saying "Pressed"
      // here is the lie the contract warns about on AxPressResult.verified.
      if (result.status === 'unverified') {
        return { ok: false, line: `Pressed ${target}, but nothing changed.` }
      }
      if (result.status === 'press-failed') {
        return { ok: false, line: `Could not press ${target}.` }
      }
      if (result.status === 'not-found') {
        return { ok: false, line: `Could not find ${target} any more.` }
      }
      if (result.status === 'not-running') {
        return { ok: false, line: 'That app is not open.' }
      }
      return { ok: false, line: `Could not press ${target}.` }
    }
  }
}

// Focusing a field is a press like any other, so the field's own label is the
// target; the words come from the transcript, never from Jev.
function typeIntoAction(bundleId: string, options: ActionSlotOption[]): ActionDefinition {
  return {
    id: 'ui.typeInto',
    capabilityId: 'ui',
    title: 'Type into a field',
    when:
      'The user wants words put into a NAMED box on screen — a search box, an address bar, a ' +
      'message field, a form field they identify by name.',
    icon: 'search',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'phone'],
    slots: [
      {
        kind: 'choice',
        key: 'field',
        label: 'Field',
        ask: 'Which box should the text go into?',
        options
      },
      { kind: 'transcript', key: 'text', label: 'Text' }
    ],
    async run(runInput: ActionRunInput): Promise<ActionRunResult> {
      const field = String(runInput.slots.field ?? '')
      const text = runInput.transcript.trim()
      if (field === '') return { ok: false, line: 'No box chosen.' }
      if (text === '') return { ok: false, line: 'Nothing to type.' }

      const focused = await context.axPress({
        bundleId,
        press: [field],
        timeoutMs: PRESS_TIMEOUT_MS
      })
      if (focused.status === 'not-running') return { ok: false, line: 'That app is not open.' }
      if (focused.status === 'not-found') {
        return { ok: false, line: `Could not find ${field} any more.` }
      }

      const ok = await input.typeText(text)
      devLog.log('[ui.typeInto]', field, text.length, 'chars', focused.status, ok)
      return ok
        ? { ok: true, line: `Typed into ${field}.` }
        : { ok: false, line: `Could not type into ${field}.` }
    }
  }
}

export const uiCapability: Capability = {
  id: 'ui',
  title: 'On-screen controls',
  blurb: 'Press a button, link or tab in whatever app you are looking at.',
  icon: 'app-window',
  source: 'builtin',
  async listActions(ctx: ActionContextSnapshot): Promise<ActionDefinition[]> {
    if (ctx.bundleId === '') return []
    const elements = await elementsFor(ctx)
    if (elements.length === 0) return []

    // No transcript reaches listActions, so ranking here is structural only —
    // it decides what fits in MAX_SLOT_OPTIONS. Jev does the semantic match
    // against the utterance it already has in `state`.
    const options = rankElements(elements, {
      transcript: '',
      limit: CONFIG.ACTIONS.MAX_SLOT_OPTIONS,
      recentLabels: []
    })
    const fields = rankElements(elements, {
      transcript: '',
      limit: CONFIG.ACTIONS.MAX_SLOT_OPTIONS,
      recentLabels: [],
      keep: isTextTarget
    })

    const actions: ActionDefinition[] = []
    if (options.length > 0) actions.push(clickAction(ctx.bundleId, options))
    if (fields.length > 0) actions.push(typeIntoAction(ctx.bundleId, fields))
    return actions
  }
}
