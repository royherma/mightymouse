import type { WebContents } from 'electron'
import { Script } from 'vm'
import { parse } from 'acorn'
import postcss from 'postcss'
import { CONFIG } from '../../shared/config'
import { checkMod, type ModParsers, type ModVerdict } from '../../shared/site-mod-check'
import { askTaskModel, taskModelChain } from './task-model'

const TASK = CONFIG.BROWSER_TASK

export interface ModCode {
  name: string
  summary: string
  css: string
  js: string
}

const PARSERS: ModParsers = {
  parseJs: (code) => parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }),
  parseCss: (css) => postcss.parse(css)
}

export const verdictOf = (code: { css: string; js: string }): ModVerdict => checkMod(code, PARSERS)

export function syntaxError(js: string): string | null {
  try {
    new Script(`(() => { 'use strict'\n${js}\n})`)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
}

const PAGE_OUTLINE = `(() => {
  const out = []
  const seen = new Set()
  const sig = (el) => {
    let s = el.tagName.toLowerCase()
    if (el.id) s += '#' + el.id.slice(0, 40)
    const cls = [...el.classList].filter((c) => c.length < 40 && !/\\d{3,}|^css-|^x[0-9a-z]{6,}$/.test(c)).slice(0, 4)
    if (cls.length) s += '.' + cls.join('.')
    for (const a of ['data-testid', 'role', 'aria-label', 'type', 'name', 'is-shorts']) {
      const v = el.getAttribute(a)
      if (v !== null) s += '[' + a + (v ? '="' + v.slice(0, 50) + '"' : '') + ']'
    }
    if (el.tagName === 'A') s += '[href^="' + (el.getAttribute('href') || '').split(/[?#]/)[0].split('/').slice(0, 2).join('/') + '"]'
    return s
  }
  const add = (line) => {
    if (seen.has(line) || out.length >= ${TASK.MOD_PAGE_LINES}) return
    seen.add(line)
    out.push(line)
  }
  const walk = (el, depth) => {
    for (const c of el.children) {
      const r = c.getBoundingClientRect()
      if (r.width < 200 || r.height < 40 || depth > 7) continue
      add('  '.repeat(depth) + sig(c) + ' {' + Math.round(r.width) + 'x' + Math.round(r.height) + '}')
      walk(c, depth + 1)
    }
  }
  out.push('LAYOUT (boxes 200px+ wide, {width x height}, window ' + innerWidth + 'x' + innerHeight + '):')
  walk(document.body, 0)
  out.push('CONTROLS AND CONTENT:')
  const pick = '[data-testid],[role],[aria-label],button,a[href],input,textarea,[contenteditable="true"],article,nav,header,main,aside,h1,h2,h3,h4'
  const custom = [...document.querySelectorAll('*')].filter((e) => e.tagName.includes('-'))
  for (const el of custom) {
    const r = el.getBoundingClientRect()
    if (r.width || r.height) add(sig(el))
  }
  for (const el of document.querySelectorAll(pick)) {
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) continue
    const text = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 50)
    add(sig(el) + (text ? ' "' + text + '"' : ''))
  }
  return out.join('\\n')
})()`

const SYSTEM_PROMPT = `You write a "site mod": CSS plus JavaScript that changes one website the way the user asks, and runs on every visit to that site.
Reply with ONLY a JSON object: {"name": "2-4 word label", "summary": "one plain sentence saying what changes for the user", "css": "...", "js": "..."}.
Rules for js:
- It runs once per page load in an isolated world: it shares the DOM with the page but not its JS variables. Many sites are single-page apps that swap content without reloading, so watch with a MutationObserver and handle elements that appear later and URL changes.
- Prefer CSS alone when hiding or restyling is enough; then js is "".
- Cover every place the thing appears: all the element types, shelves, menu entries and links listed for it, not just the first one. For width changes, lift max-width on every wrapping box in LAYOUT that is narrower than the window.
- The js runs inside a plain (not async) function: put any await inside your own async function.
- Build any UI with document.createElement and addEventListener, and set text with textContent. Never set innerHTML or outerHTML. No inline on* attributes, no eval, no network requests, no cookies or storage, never touch password fields. Never create script, style, img, iframe, form or link elements and never set src: all styling goes in css, and icons are text or CSS shapes.
- Your code runs in strict mode. Never use window as a value, bare this, or names built from pieces (obj['a' + b]); call browser functions by their plain name.
- Prefix every id and class you add with "mm-mod-". Mark page elements with data-mm-* attributes, never by adding classes (sites re-render and drop them).
- Find elements by stable hooks first: data-testid, aria-label, role, custom element tag names, then structure. Never generated class names like "css-1dbjc4n" or "x1n2onr6".
- Never submit, post, buy, delete or send unless the user's request asks for it AND the user pressed a key or clicked something of yours to trigger it.
- To type into a rich text editor: focus it, then document.execCommand('insertText', false, text).
- Two helpers exist: await mm.ask(prompt) returns a short AI-written text (use only when the user's request needs writing); mm.broken(reason) says the mod can't find what it needs. If the elements your mod depends on never appear within 10 seconds on a page where they should be, call mm.broken('<what is missing>') once.
Rules for css: target stable hooks, use !important when overriding the site. Empty string when not needed.
If you are given an existing mod, return the full updated mod, not a diff.
If the request cannot be done within these rules, reply ONLY {"refuse": "one short plain sentence the user will read, e.g. mods can't send data to other websites"}.`

function parseMod(text: string): ModCode | { refuse: string } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Partial<ModCode> & { refuse?: unknown }
    if (typeof raw.refuse === 'string' && raw.refuse.trim()) return { refuse: raw.refuse.trim().replace(/\.$/, '') }
    if (typeof raw.js !== 'string' && typeof raw.css !== 'string') return null
    return {
      name: String(raw.name || 'Site change').slice(0, 40),
      summary: String(raw.summary || '').slice(0, 200),
      css: typeof raw.css === 'string' ? raw.css : '',
      js: typeof raw.js === 'string' ? raw.js : ''
    }
  } catch {
    return null
  }
}

export async function writeModCode(
  wc: WebContents,
  host: string,
  instruction: string,
  before: ModCode | undefined
): Promise<{ code: ModCode | null; reason: string; costUsd: number }> {
  const outline = await readOutline(wc)
  const base = [
    `Site: ${host}`,
    `Page: ${wc.getURL()} - ${wc.getTitle()}`,
    `User wants: ${instruction}`,
    before ? `Existing mod to change:\n${JSON.stringify(before)}` : '',
    `The page (tag#id.class[attributes] {size} "text"):\n${outline}`
  ]
    .filter(Boolean)
    .join('\n\n')
  let reason = 'no answer'
  let costUsd = 0
  let prompt = base
  const chain = taskModelChain(TASK.MOD_MODELS)
  for (const model of [...chain, ...chain]) {
    const res = await askTaskModel(model, {
      system: SYSTEM_PROMPT,
      userPrompt: prompt,
      feature: TASK.FEATURE,
      timeoutMs: TASK.MOD_TIMEOUT_MS,
      maxTokens: TASK.MOD_MAX_TOKENS
    })
    costUsd += res.trail.costUsdMicros / 1_000_000
    if (!res.ok) {
      reason = res.reason
      continue
    }
    const code = parseMod(res.text)
    if (code && 'refuse' in code) return { code: null, reason: code.refuse, costUsd }
    if (!code) {
      reason = 'unreadable answer'
      continue
    }
    const broken = syntaxError(code.js)
    if (broken) {
      reason = 'the code it wrote had an error'
      prompt = `${base}\n\nYour last js did not parse (${broken}). Return the full mod with valid JavaScript.`
      continue
    }
    const verdict = verdictOf(code)
    if (verdict.level !== 'refuse') return { code: { ...code, css: verdict.css }, reason: '', costUsd }
    const bad = verdict.refused.join(' and ')
    reason = `it ${bad}, which mods may not do`
    prompt = `${base}\n\nYour last answer was refused because it ${bad}. Do it without that.`
  }
  return { code: null, reason, costUsd }
}

async function readOutline(wc: WebContents): Promise<string> {
  return withTimeout(
    wc.executeJavaScriptInIsolatedWorld(TASK.MOD_WORLD_ID, [{ code: PAGE_OUTLINE }]) as Promise<string>,
    TASK.MOD_PAGE_CALL_MS,
    ''
  )
}

export async function recheckModCode(
  wc: WebContents,
  instruction: string,
  code: ModCode
): Promise<{ code: ModCode | null; costUsd: number }> {
  const after = await readOutline(wc)
  const res = await askTaskModel(taskModelChain(TASK.MOD_MODELS)[0], {
    system: SYSTEM_PROMPT,
    userPrompt: [
      `User wants: ${instruction}`,
      `This mod is running on the page now:\n${JSON.stringify(code)}`,
      `The page WITH the mod applied (tag#id.class[attributes] {size} "text"):\n${after}`,
      'Check the page above. If the mod fully does what the user wants, reply ONLY {"ok": true}. Otherwise reply with the full corrected mod.'
    ].join('\n\n'),
    feature: TASK.FEATURE,
    timeoutMs: TASK.MOD_TIMEOUT_MS,
    maxTokens: TASK.MOD_MAX_TOKENS
  })
  const costUsd = res.trail.costUsdMicros / 1_000_000
  if (!res.ok || /^\s*\{\s*"ok"\s*:\s*true/.test(res.text)) return { code: null, costUsd }
  const fixed = parseMod(res.text)
  if (!fixed || 'refuse' in fixed || syntaxError(fixed.js)) return { code: null, costUsd }
  const verdict = verdictOf(fixed)
  return { code: verdict.level === 'refuse' ? null : { ...fixed, css: verdict.css }, costUsd }
}

const DRAFT_SYSTEM = `You write short text for a browser mod on the user's behalf. Reply with only the text itself: no quotes, no preamble, no hashtags, no emoji unless asked. Plain, specific, human.`

export async function draftText(prompt: string): Promise<{ text: string | null; costUsd: number }> {
  let costUsd = 0
  for (const model of taskModelChain([TASK.MOD_DRAFT_MODEL, ...TASK.MOD_MODELS])) {
    const res = await askTaskModel(model, {
      system: DRAFT_SYSTEM,
      userPrompt: prompt.slice(0, 4_000),
      feature: TASK.FEATURE,
      timeoutMs: TASK.MOD_DRAFT_TIMEOUT_MS,
      maxTokens: TASK.MOD_DRAFT_MAX_TOKENS
    })
    costUsd += res.trail.costUsdMicros / 1_000_000
    const text = res.ok ? res.text.trim().replace(/^["']|["']$/g, '') : ''
    if (text) return { text, costUsd }
  }
  return { text: null, costUsd }
}
