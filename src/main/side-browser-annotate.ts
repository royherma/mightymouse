import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { PATHS } from './store/paths'
import type { SideBrowserAnnotation } from '../shared/types'

interface PageHit {
  comment: string
  kind: 'element' | 'region'
  rect: { x: number; y: number; w: number; h: number }
  url: string
  label?: string
  selector?: string
  component?: string
  source?: string
}

const MAX_SHOT_W = 1600

// Runs in the page's main world; CSSOM and adoptedStyleSheets only, so a strict style-src CSP can't block it.
const OVERLAY = `(() => {
  if (window.__mmAnnotate) window.__mmAnnotate.end(null)
  const BLUE = '#2D7DFF', RED = '#FF2D2D'
  const host = document.createElement('div')
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' })
  const root = host.attachShadow({ mode: 'closed' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(\`
    .box { position: fixed; pointer-events: none; border: 2px dashed \${BLUE}; background: rgba(45,125,255,.08); border-radius: 3px; display: none }
    .box.mark { border: 3px solid \${RED}; background: transparent }
    .tag { position: fixed; pointer-events: none; font: 600 11px -apple-system, system-ui, sans-serif; color: #fff; background: \${BLUE}; padding: 2px 6px; border-radius: 4px; display: none; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis }
    .card { position: fixed; pointer-events: auto; display: none; width: 300px; background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.08); padding: 8px; font: 14px -apple-system, system-ui, sans-serif }
    .card textarea { width: 100%; box-sizing: border-box; border: 0; outline: 0; resize: none; font: inherit; color: #111; background: transparent; min-height: 40px }
    .hint { font-size: 11px; color: #888; padding: 2px 2px 0 }
    .toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); font: 600 13px -apple-system, system-ui, sans-serif; color: #fff; background: rgba(20,20,20,.92); padding: 8px 14px; border-radius: 999px }
  \`)
  root.adoptedStyleSheets = [sheet]
  const box = document.createElement('div'); box.className = 'box'
  const tag = document.createElement('div'); tag.className = 'tag'
  const card = document.createElement('div'); card.className = 'card'
  const input = document.createElement('textarea'); input.placeholder = 'What should change here?'; input.rows = 2
  const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Enter to add to chat · Esc to cancel'
  card.append(input, hint)
  root.append(box, tag, card)
  document.documentElement.appendChild(host)
  const cursor = new CSSStyleSheet()
  cursor.replaceSync('*, *::before, *::after { cursor: crosshair !important }')
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, cursor]

  let hover = null, down = null, picked = null, done
  const result = new Promise((r) => { done = r })

  const describe = (el) => {
    const name = el.tagName.toLowerCase()
    const words = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('alt') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ')
    return words ? name + ' "' + words.slice(0, 60) + (words.length > 60 ? '…' : '') + '"' : name
  }
  const selectorOf = (el) => {
    const parts = []
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break }
      const cls = [...n.classList].filter((c) => /^[a-zA-Z][\\w-]*$/.test(c)).slice(0, 2)
      parts.unshift(n.tagName.toLowerCase() + cls.map((c) => '.' + c).join(''))
      if (n === document.body) break
    }
    return parts.join(' > ')
  }
  const reactOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    let fiber = key ? el[key] : null, source
    const names = []
    for (; fiber && names.length < 3; fiber = fiber.return) {
      source = source || fiber._debugSource
      const t = fiber.type
      const name = t && typeof t !== 'string' ? t.displayName || t.name : null
      if (name && !names.includes(name)) names.push(name)
    }
    return {
      component: names.length ? names.map((n) => '<' + n + '>').join(' in ') : undefined,
      source: source ? source.fileName.replace(/^.*?\\/(src|app|components|pages)\\//, '$1/') + ':' + source.lineNumber : undefined
    }
  }
  const under = (x, y) => document.elementsFromPoint(x, y).find((el) => el !== host && el !== document.documentElement) || null
  const place = (el, r) => {
    Object.assign(el.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' })
  }
  const rectOf = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } }
  const showTag = (text, r) => {
    tag.textContent = text
    Object.assign(tag.style, { display: 'block', left: Math.max(4, r.x) + 'px', top: (r.y > 22 ? r.y - 22 : r.y + r.h + 4) + 'px' })
  }
  const ours = (e) => e.composedPath().includes(host)
  const block = (e) => { if (ours(e)) return; e.preventDefault(); e.stopImmediatePropagation() }

  const openCard = (r) => {
    picked.rect = r
    box.classList.remove('mark')
    place(box, r)
    const top = r.y + r.h + 8 + 90 < innerHeight ? r.y + r.h + 8 : Math.max(8, r.y - 98)
    Object.assign(card.style, { display: 'block', left: Math.min(Math.max(8, r.x), innerWidth - 308) + 'px', top: top + 'px' })
    input.value = ''
    input.focus()
  }
  const closeCard = () => { picked = null; card.style.display = 'none'; box.style.display = 'none'; tag.style.display = 'none' }

  const onMove = (e) => {
    if (ours(e) || picked) return
    if (down) {
      const r = { x: Math.min(down.x, e.clientX), y: Math.min(down.y, e.clientY), w: Math.abs(e.clientX - down.x), h: Math.abs(e.clientY - down.y) }
      if (r.w > 6 || r.h > 6) { down.drag = true; place(box, r); showTag(Math.round(r.w) + ' × ' + Math.round(r.h), r) }
      return
    }
    const el = under(e.clientX, e.clientY)
    if (!el || el === hover) return
    hover = el
    const r = rectOf(el)
    place(box, r)
    showTag(describe(el), r)
  }
  const onDown = (e) => {
    if (ours(e)) return
    block(e)
    if (picked) return closeCard()
    down = { x: e.clientX, y: e.clientY, drag: false }
  }
  const onUp = (e) => {
    if (ours(e) || !down) return
    block(e)
    const d = down
    down = null
    if (d.drag) {
      const r = { x: Math.min(d.x, e.clientX), y: Math.min(d.y, e.clientY), w: Math.abs(e.clientX - d.x), h: Math.abs(e.clientY - d.y) }
      picked = { kind: 'region', label: 'area ' + Math.round(r.w) + '×' + Math.round(r.h) }
      return openCard(r)
    }
    const el = hover || under(e.clientX, e.clientY)
    if (!el) return
    picked = { kind: 'element', label: describe(el), selector: selectorOf(el), ...reactOf(el) }
    openCard(rectOf(el))
  }
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault(); e.stopImmediatePropagation()
    if (picked) closeCard()
    else end(null)
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); closeCard(); return }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    const comment = input.value.trim()
    if (!comment) return
    card.style.display = 'none'
    tag.style.display = 'none'
    box.classList.add('mark')
    requestAnimationFrame(() => requestAnimationFrame(() =>
      done({ ...picked, comment, url: location.href })
    ))
  })
  const onScroll = () => { if (picked || down) return; hover = null; box.style.display = 'none'; tag.style.display = 'none' }
  const events = [['scroll', onScroll], ['pointermove', onMove], ['pointerdown', onDown], ['mousedown', block], ['pointerup', onUp], ['mouseup', block], ['click', block], ['dblclick', block], ['contextmenu', block], ['keydown', onKey]]
  for (const [type, fn] of events) window.addEventListener(type, fn, true)

  const end = (note) => {
    for (const [type, fn] of events) window.removeEventListener(type, fn, true)
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== cursor)
    root.replaceChildren()
    if (note) {
      const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = note
      root.append(toast)
      setTimeout(() => host.remove(), 1400)
    } else host.remove()
    if (window.__mmAnnotate === api) delete window.__mmAnnotate
    done(null)
  }
  const api = { end }
  window.__mmAnnotate = api
  return result
})()`

const running = new Map<number, () => void>()

function navigated(wc: Electron.WebContents): { wait: Promise<'navigated'>; off: () => void } {
  let off = (): void => undefined
  const wait = new Promise<'navigated'>((resolve) => {
    const go = (_e: unknown, _url: string, inPage: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && !inPage) resolve('navigated')
    }
    wc.on('did-start-navigation', go)
    wc.once('destroyed', () => resolve('navigated'))
    off = () => wc.off('did-start-navigation', go)
  })
  return { wait, off }
}

function loaded(wc: Electron.WebContents): Promise<void> {
  return new Promise((resolve) => {
    if (wc.isDestroyed() || !wc.isLoading()) return resolve()
    wc.once('dom-ready', () => resolve())
    wc.once('destroyed', () => resolve())
  })
}

function noteOf(hit: PageHit): string {
  const where = [hit.label, hit.component, hit.source, hit.selector && `\`${hit.selector}\``].filter(Boolean).join(' · ')
  return `On ${hit.url} - ${where}:\n${hit.comment}`
}

async function save(wc: Electron.WebContents, hit: PageHit): Promise<string> {
  let shot = await wc.capturePage()
  if (shot.getSize().width > MAX_SHOT_W) shot = shot.resize({ width: MAX_SHOT_W, quality: 'best' })
  await mkdir(PATHS.MARKUPS, { recursive: true })
  const host = (() => {
    try {
      return new URL(hit.url).host.replace(/[^\w.-]/g, '-')
    } catch {
      return 'page'
    }
  })()
  const path = join(PATHS.MARKUPS, `${host}-annotate-${Date.now()}.png`)
  await writeFile(path, shot.toPNG())
  return path
}

export async function annotate(wc: Electron.WebContents): Promise<SideBrowserAnnotation | null> {
  running.get(wc.id)?.()
  let stopped = false
  const stop = new Promise<null>((resolve) => running.set(wc.id, () => {
    stopped = true
    resolve(null)
  }))
  wc.focus()
  while (!stopped && !wc.isDestroyed()) {
    const nav = navigated(wc)
    const hit = await Promise.race([
      wc.executeJavaScript(OVERLAY, true).catch(() => null) as Promise<PageHit | null>,
      nav.wait,
      stop
    ])
    nav.off()
    if (hit === 'navigated') {
      await loaded(wc)
      continue
    }
    if (!hit || stopped || wc.isDestroyed()) break
    return { path: await save(wc, hit), note: noteOf(hit) }
  }
  return null
}

export function endAnnotate(wc: Electron.WebContents, note: string | null): void {
  running.get(wc.id)?.()
  running.delete(wc.id)
  if (!wc.isDestroyed()) void wc.executeJavaScript(`window.__mmAnnotate?.end(${JSON.stringify(note)})`).catch(() => undefined)
}
