import type { WebContents } from 'electron'
import { CONFIG } from '../../shared/config'
import type { AgentCursorKind, PageControl, PageFillResult, PageRead } from '../../shared/types'
import { flashAgentCursor, holdAgentCursor } from '../actions/computer-use/agent-cursor'
import { tabScreenCenter, tabScreenPoint, untilResumed } from '../side-browser'

// Own world: page scripts share the DOM but cannot see or patch our functions.
const WORLD_ID = 1717
const MAX_TEXT_CHARS = 6_000
const MAX_CONTROLS = 300

const PAGE_SCRIPT = String.raw`
(() => {
  if (window.__mm) return;
  const REF = 'data-mm-ref';
  let next = 1;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const refOf = (el) => {
    let r = el.getAttribute(REF);
    if (!r) { r = String(next++); el.setAttribute(REF, r); }
    return r;
  };
  const byRef = (ref) => {
    const direct = document.querySelector('[' + REF + '="' + ref + '"]');
    if (direct) return direct;
    let hit = null;
    walk(document, (el) => { if (!hit && el.getAttribute(REF) === ref) hit = el; });
    return hit;
  };
  const walk = (root, fn) => {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = it.currentNode; n; n = it.nextNode()) {
      if (n.nodeType !== 1) continue;
      fn(n);
      if (n.shadowRoot) walk(n.shadowRoot, fn);
    }
  };
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && clean(l.innerText)) return clean(l.innerText);
    }
    const wrap = el.closest('label');
    if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
    const pressable = el.matches(PRESS);
    if (pressable && clean(el.innerText || el.value)) return clean(el.innerText || el.value);
    if (!pressable) {
      let a = el.parentElement;
      for (let k = 0; a && k < 5; k++, a = a.parentElement) {
        const l = (a.id && document.querySelector('label[for="' + CSS.escape(a.id) + '"]'))
          || (a.querySelectorAll('input:not([type=hidden]),select,textarea').length === 1 && a.querySelector('label,legend'));
        if (l && clean(l.innerText)) return clean(l.innerText);
      }
    }
    const ph = el.getAttribute('placeholder') || el.getAttribute('title');
    if (ph) return clean(ph);
    let prev = el.previousElementSibling || el.parentElement?.previousElementSibling;
    if (prev && clean(prev.innerText)) return clean(prev.innerText);
    return clean(el.getAttribute('name') || el.innerText || el.value || '');
  };
  const FIELD_TYPES = new Set(['text','email','tel','url','number','search','date','month','week','time','datetime-local','password','checkbox','radio','','color','range']);
  const PRESS = 'button,a[href],[role=button],[role=link],[role=tab],[role=menuitem],[role=option],summary,input[type=submit],input[type=button],input[type=reset]';
  const kindOf = (el) => {
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'select';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'hidden' || t === 'file' || t === 'image') return null;
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      return FIELD_TYPES.has(t) ? (t || 'text') : 'text';
    }
    if (el.getAttribute('role') === 'combobox') return 'combobox';
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'editable';
    if (el.matches(PRESS)) return el.tagName === 'A' || el.getAttribute('role') === 'link' ? 'link' : 'button';
    return null;
  };
  const read = (maxControls, maxText) => {
    const controls = [];
    walk(document, (el) => {
      if (controls.length >= maxControls) return;
      const kind = kindOf(el);
      if (!kind || !visible(el)) return;
      const c = { ref: refOf(el), kind, label: labelOf(el) };
      if (kind === 'select') {
        c.value = el.options[el.selectedIndex]?.text || '';
        c.options = Array.from(el.options).map((o) => clean(o.text)).filter(Boolean).slice(0, 60);
      } else if (kind === 'checkbox' || kind === 'radio') {
        c.value = el.checked ? 'checked' : '';
        if (kind === 'radio' && el.name) c.group = el.name;
      } else if (kind === 'combobox') {
        c.value = clean(el.innerText);
        const list = document.getElementById(el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '');
        if (list) c.options = Array.from(list.querySelectorAll('[role=option]')).map((o) => clean(o.innerText)).filter(Boolean).slice(0, 60);
      } else if (kind === 'editable') {
        c.value = (el.innerText || '').slice(0, 400);
      } else if (kind !== 'button' && kind !== 'link') {
        c.value = kind === 'password' ? '' : String(el.value || '').slice(0, 400);
      }
      if (kind === 'password' || /^cc-/.test(el.getAttribute('autocomplete') || '')) c.secret = true;
      const ph = clean(el.getAttribute('placeholder'));
      if (ph && ph !== c.label) c.hint = ph;
      if (el.required || el.getAttribute('aria-required') === 'true') c.required = true;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') c.disabled = true;
      if (kind === 'link') c.href = el.href;
      controls.push(c);
    });
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, maxText);
    return { url: location.href, title: document.title, controls, text };
  };
  const setNative = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const pickOption = (items, textOf, value) => {
    const want = String(value).toLowerCase().trim();
    return items.find((o) => textOf(o).toLowerCase().trim() === want)
      || items.find((o) => want.length > 1 && textOf(o).toLowerCase().includes(want));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const invalidNear = (el) => {
    if (el.getAttribute('aria-invalid') === 'true' || (el.validity && !el.validity.valid)) return true;
    const box = el.closest('.form-group,fieldset,[role=group]') || el.parentElement?.parentElement?.parentElement;
    return /invalid/i.test(box?.innerText || '');
  };
  const dateVariants = (value) => {
    const v = String(value).trim();
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/), y, mo, d;
    if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [y, mo, d] = [+m[3], +m[1], +m[2]];
    else if (/[a-z]/i.test(v) && /\d{4}/.test(v) && !isNaN(Date.parse(v))) {
      const t = new Date(v); [y, mo, d] = [t.getFullYear(), t.getMonth() + 1, t.getDate()];
    } else return [];
    const p = (n) => String(n).padStart(2, '0');
    const mon = new Date(y, mo - 1, d).toLocaleString('en-US', { month: 'short' });
    return [...new Set([v, y + '-' + p(mo) + '-' + p(d), p(mo) + '/' + p(d) + '/' + y, p(d) + '/' + p(mo) + '/' + y, mon + ' ' + d + ', ' + y])];
  };
  const fillOne = async (ref, value) => {
    const el = byRef(ref);
    if (!el) return { ref, ok: false, reason: 'gone' };
    const kind = kindOf(el);
    if (kind === 'password' || /^cc-/.test(el.getAttribute('autocomplete') || '')) return { ref, ok: false, reason: 'secret' };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (kind === 'select') {
      const hit = pickOption(Array.from(el.options), (o) => o.text, value)
        || Array.from(el.options).find((o) => o.value.toLowerCase() === String(value).toLowerCase());
      if (!hit) return { ref, ok: false, reason: 'no option' };
      el.value = hit.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ref, ok: true, value: hit.text };
    }
    if (kind === 'combobox') {
      el.click();
      for (let i = 0; i < 20; i++) {
        await sleep(50);
        const opts = [];
        walk(document, (o) => { if (o.getAttribute('role') === 'option' && visible(o)) opts.push(o); });
        const hit = pickOption(opts, (o) => clean(o.innerText), value);
        if (hit) { hit.click(); return { ref, ok: true, value: clean(hit.innerText) }; }
      }
      el.click();
      return { ref, ok: false, reason: 'no option' };
    }
    if (kind === 'checkbox' || kind === 'radio') {
      const v = String(value).trim();
      const on = kind === 'radio' ? !/^(false|no|off|0|unchecked)$/i.test(v) : /^(true|yes|checked|on|1|x)$/i.test(v);
      if (on !== el.checked && (on || kind === 'checkbox')) el.click();
      return { ref, ok: true, value: el.checked ? 'checked' : '' };
    }
    if (kind === 'editable') {
      const sel = getSelection();
      sel.selectAllChildren(el);
      document.execCommand('insertText', false, String(value));
      return { ref, ok: true, value: (el.innerText || '').slice(0, 400) };
    }
    const dates = kind === 'text' ? dateVariants(value) : [];
    if (dates.length) {
      for (const d of dates) {
        el.focus();
        setNative(el, d);
        el.blur();
        let bad = false;
        for (let i = 0; i < 8 && !bad; i++) { await sleep(100); bad = invalidNear(el); }
        if (!bad) return { ref, ok: true, value: String(el.value) };
      }
      return { ref, ok: false, reason: 'date format not accepted' };
    }
    if (kind && kind !== 'button' && kind !== 'link') {
      setNative(el, String(value));
      el.blur();
      return { ref, ok: String(el.value) !== '' || String(value) === '', value: String(el.value).slice(0, 400) };
    }
    return { ref, ok: false, reason: 'not a field' };
  };
  const mark = (refs, color) => {
    for (const ref of refs) {
      const el = byRef(ref);
      if (!el) continue;
      el.style.setProperty('outline', '2px solid ' + color, 'important');
      el.style.setProperty('outline-offset', '1px', 'important');
      el.setAttribute('data-mm-mark', '1');
    }
  };
  const unmark = () => walk(document, (el) => {
    if (!el.hasAttribute('data-mm-mark')) return;
    el.style.removeProperty('outline');
    el.style.removeProperty('outline-offset');
    el.removeAttribute('data-mm-mark');
  });
  let clicked = null;
  const center = async (ref) => {
    const el = byRef(ref);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    clicked = { el, hit: false };
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const label = clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')).slice(0, 40);
    return { x, y, label, hit: Boolean(top && (el === top || el.contains(top))) };
  };
  window.addEventListener('click', (e) => { if (clicked && clicked.el.contains(e.target)) clicked.hit = true; }, true);
  const landed = () => { const hit = Boolean(clicked?.hit); clicked = null; return hit; };
  const clickDom = (ref) => { const el = byRef(ref); if (!el) return false; el.click(); return true; };
  const TYPABLE = new Set(['text','email','tel','url','number','search','textarea','editable']);
  const selectField = (ref) => {
    const el = byRef(ref);
    const kind = el && kindOf(el);
    if (!TYPABLE.has(kind) || /^cc-/.test(el.getAttribute('autocomplete') || '')) return null;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (kind === 'editable') getSelection().selectAllChildren(el);
    else el.select();
    return kind;
  };
  const fieldText = (ref) => {
    const el = byRef(ref);
    return String((el && (kindOf(el) === 'editable' ? el.innerText : el.value)) || '').slice(0, 400);
  };
  window.__mm = { read, fillOne, mark, unmark, center, landed, clickDom, selectField, fieldText };
})();
`

async function run<T>(wc: WebContents, expr: string): Promise<T> {
  return (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [
    { code: `${PAGE_SCRIPT};${expr}` }
  ])) as T
}

export async function readPage(wc: WebContents): Promise<PageRead> {
  const started = Date.now()
  const page = await run<Omit<PageRead, 'ms'>>(
    wc,
    `window.__mm.read(${MAX_CONTROLS}, ${MAX_TEXT_CHARS})`
  )
  return { ...page, ms: Date.now() - started }
}

type Target = { x: number; y: number; label?: string; hit: boolean }

async function glideCursorTo(wc: WebContents, at: Target, kind: AgentCursorKind): Promise<void> {
  const point = tabScreenPoint(wc, at.x, at.y)
  if (!point) return
  const ms = flashAgentCursor({ ...point, kind, label: at.label || undefined })
  await new Promise((resolve) => setTimeout(resolve, ms + (kind === 'click' ? CONFIG.AGENT_CURSOR.PRESS_MS : 0)))
}

export function holdCursor(wc: WebContents, label: string): void {
  const center = tabScreenCenter(wc)
  if (center) holdAgentCursor(center, label)
}

export async function fillFields(
  wc: WebContents,
  values: Record<string, string>
): Promise<PageFillResult[]> {
  const out: PageFillResult[] = []
  for (const [ref, value] of Object.entries(values)) {
    if (!(await untilResumed(wc))) break
    const at = await run<Target | null>(wc, `window.__mm.center(${JSON.stringify(ref)})`).catch(() => null)
    if (at) await glideCursorTo(wc, at, 'type')
    out.push(
      (value.includes('\n') && (await typeText(wc, ref, value))) ||
        (await run<PageFillResult>(wc, `window.__mm.fillOne(${JSON.stringify(ref)}, ${JSON.stringify(value)})`))
    )
  }
  return out
}

// Real keystrokes: rich editors (Reddit's comment box) drop the line breaks of a scripted insertText.
// Shift+Enter, not Enter: chat boxes (Slack, Discord) send on Enter.
async function typeText(wc: WebContents, ref: string, value: string): Promise<PageFillResult | null> {
  const kind = await run<string | null>(wc, `window.__mm.selectField(${JSON.stringify(ref)})`)
  if (!kind) return null
  const lines = kind === 'textarea' || kind === 'editable' ? value.split(/\r?\n/) : [value.replace(/\s*\r?\n\s*/g, ' ')]
  const newline = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 }
  await withDebugger(wc, async () => {
    for (const [i, line] of lines.entries()) {
      if (i > 0) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...newline })
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...newline })
      }
      if (line) await wc.debugger.sendCommand('Input.insertText', { text: line })
    }
  })
  return { ref, ok: true, value: await run<string>(wc, `window.__mm.fieldText(${JSON.stringify(ref)})`) }
}

export async function typeInto(wc: WebContents, ref: string, text: string): Promise<PageFillResult> {
  const at = await run<Target | null>(wc, `window.__mm.center(${JSON.stringify(ref)})`).catch(() => null)
  if (at) await glideCursorTo(wc, at, 'type')
  return (await typeText(wc, ref, text)) ?? { ref, ok: false, reason: 'not a box you can type in' }
}

const FIND_FILE_INPUT = String.raw`(ref, nearOnly) => {
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'INPUT' && el.type === 'file') all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  if (!ref) return all.length === 1 ? all[0] : null;
  const find = (root) => {
    const hit = root.querySelector('[data-mm-ref="' + ref + '"]');
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const h = find(el.shadowRoot); if (h) return h; }
    return null;
  };
  const target = find(document);
  if (!target) return null;
  if (target.tagName === 'INPUT' && target.type === 'file') return target;
  if (!nearOnly) return null;
  for (let a = target, hops = 0; a && a !== document.body && hops < 4; a = a.parentElement || a.getRootNode().host, hops++) {
    const near = all.filter((f) => a.contains(f) || (a.shadowRoot && a.shadowRoot.contains(f)));
    if (near.length) return near.length === 1 ? near[0] : null;
  }
  return null;
}`

// A button that opens the OS file picker gets its picker intercepted, so no dialog appears on the user's screen.
export async function attachFiles(
  wc: WebContents,
  ref: string | undefined,
  files: string[]
): Promise<{ ok: true; via: string } | { ok: false; reason: string }> {
  return withDebugger(wc, async () => {
    const send = <T>(method: string, params?: object): Promise<T> => wc.debugger.sendCommand(method, params) as Promise<T>
    const fileInput = async (nearOnly: boolean): Promise<string | undefined> =>
      (
        await send<{ result: { objectId?: string } }>('Runtime.evaluate', {
          expression: `(${FIND_FILE_INPUT})(${JSON.stringify(ref ?? '')}, ${nearOnly})`
        })
      ).result.objectId
    const direct = await fileInput(false)
    if (direct) {
      await send('DOM.setFileInputFiles', { files, objectId: direct })
      return { ok: true, via: 'upload field' }
    }
    if (!ref) return { ok: false, reason: 'Pass the number of the upload button from `browser_read`.' }
    let chooser: ((backendNodeId: number) => void) | null = null
    const opened = new Promise<number | null>((resolve) => {
      chooser = resolve
      setTimeout(() => resolve(null), CONFIG.BROWSER_TASK.FILE_CHOOSER_WAIT_MS)
    })
    const onMessage = (_e: unknown, method: string, params: { backendNodeId?: number }): void => {
      if (method === 'Page.fileChooserOpened' && params.backendNodeId) chooser?.(params.backendNodeId)
    }
    wc.debugger.on('message', onMessage)
    try {
      await send('Page.enable')
      await send('Page.setInterceptFileChooserDialog', { enabled: true })
      if (!(await pressControl(wc, ref))) return { ok: false, reason: `Nothing numbered ${ref} to press.` }
      const backendNodeId = await opened
      if (backendNodeId) {
        await send('DOM.setFileInputFiles', { files, backendNodeId })
        return { ok: true, via: 'file picker' }
      }
    } finally {
      wc.debugger.removeListener('message', onMessage)
      await send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
    }
    const near = await fileInput(true)
    if (!near) return { ok: false, reason: 'That button did not open a file picker.' }
    await send('DOM.setFileInputFiles', { files, objectId: near })
    return { ok: true, via: 'upload field' }
  })
}

export async function markFields(wc: WebContents, refs: string[], color: string): Promise<void> {
  await run(wc, `window.__mm.mark(${JSON.stringify(refs)}, ${JSON.stringify(color)})`)
}

export async function clearMarks(wc: WebContents): Promise<void> {
  await run(wc, 'window.__mm.unmark()')
}

async function withDebugger<T>(wc: WebContents, fn: () => Promise<T>): Promise<T> {
  const owned = !wc.debugger.isAttached()
  if (owned) wc.debugger.attach('1.3')
  try {
    return await fn()
  } finally {
    if (owned && wc.debugger.isAttached()) wc.debugger.detach()
  }
}

// Trusted mouse events: some sites ignore element.click() because isTrusted is false.
export async function pressControl(wc: WebContents, ref: string): Promise<boolean> {
  const at = await run<Target | null>(wc, `window.__mm.center(${JSON.stringify(ref)})`)
  if (!at) return false
  await glideCursorTo(wc, at, 'click')
  if (!(await untilResumed(wc))) return false
  if (!at.hit) return run<boolean>(wc, `window.__mm.clickDom(${JSON.stringify(ref)})`)
  try {
    await withDebugger(wc, async () => {
      const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 }
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
    })
    if (await run<boolean>(wc, 'window.__mm.landed()').catch(() => true)) return true
    return run<boolean>(wc, `window.__mm.clickDom(${JSON.stringify(ref)})`)
  } catch {
    return run<boolean>(wc, `window.__mm.clickDom(${JSON.stringify(ref)})`)
  }
}

export function controlLine(c: PageControl): string {
  const bits = [`[${c.ref}]`, c.kind, JSON.stringify(c.label)]
  if (c.options) bits.push(`options: ${c.options.join(' | ')}`)
  if (c.hint) bits.push(`shows: ${JSON.stringify(c.hint)}`)
  if (c.value) bits.push(`now: ${JSON.stringify(c.value)}`)
  if (c.required) bits.push('required')
  return bits.join(' ')
}
