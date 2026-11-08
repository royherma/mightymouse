const GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'WebTransport',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'MessageChannel',
  'postMessage',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'cookieStore',
  'open',
  'Image',
  'Audio',
  'DOMParser',
  'CSSStyleSheet',
  'parent',
  'frames',
  'opener',
  'frameElement',
  'eval',
  'Function',
  'fetchLater',
  'FontFace',
  'XSLTProcessor',
  'SpeechRecognition',
  'webkitSpeechRecognition',
  'MediaRecorder'
]

const PROTOTYPES: Record<string, string[]> = {
  Navigation: ['navigate'],
  Worklet: ['addModule'],
  ShadowRoot: ['setHTML', 'setHTMLUnsafe'],
  Navigator: ['sendBeacon', 'serviceWorker', 'credentials', 'geolocation', 'mediaDevices', 'bluetooth', 'usb', 'serial', 'hid'],
  Clipboard: ['read', 'readText'],
  Document: ['cookie', 'defaultView', 'write', 'writeln', 'domain', 'styleSheets', 'adoptedStyleSheets', 'implementation', 'fonts'],
  HTMLIFrameElement: ['contentWindow', 'contentDocument', 'srcdoc'],
  HTMLFrameElement: ['contentWindow', 'contentDocument'],
  HTMLObjectElement: ['contentWindow', 'contentDocument', 'getSVGDocument'],
  HTMLEmbedElement: ['getSVGDocument'],
  HTMLFormElement: ['submit', 'requestSubmit'],
  HTMLStyleElement: ['sheet'],
  HTMLLinkElement: ['sheet'],
  HTMLElement: ['attributeStyleMap'],
  SVGElement: ['attributeStyleMap'],
  Element: ['insertAdjacentHTML', 'setHTMLUnsafe', 'setHTML', 'setAttributeNS', 'setAttributeNode', 'attributes'],
  Range: ['createContextualFragment'],
  UIEvent: ['view'],
  MessageEvent: ['source']
}

const WRITE_ONLY: Record<string, string[]> = {
  Element: ['innerHTML', 'outerHTML'],
  ShadowRoot: ['innerHTML'],
  HTMLImageElement: ['src', 'srcset', 'lowsrc'],
  HTMLSourceElement: ['src', 'srcset'],
  HTMLMediaElement: ['src', 'srcObject'],
  HTMLVideoElement: ['poster'],
  HTMLTrackElement: ['src'],
  HTMLIFrameElement: ['src'],
  HTMLFrameElement: ['src'],
  HTMLEmbedElement: ['src'],
  HTMLObjectElement: ['data'],
  HTMLLinkElement: ['href'],
  HTMLScriptElement: ['src', 'text'],
  HTMLMetaElement: ['httpEquiv', 'content'],
  HTMLBaseElement: ['href'],
  HTMLInputElement: ['src', 'formAction'],
  HTMLButtonElement: ['formAction'],
  HTMLFormElement: ['action'],
  HTMLAnchorElement: ['ping', 'attributionSrc'],
  HTMLAreaElement: ['ping'],
  HTMLBodyElement: ['background'],
  SVGAnimatedString: ['baseVal'],
  Attr: ['value']
}

const TAGS = ['script', 'style', 'link', 'iframe', 'frame', 'object', 'embed', 'img', 'image', 'picture', 'video', 'audio', 'source', 'track', 'form', 'base', 'meta', 'portal', 'fencedframe', 'svg', 'use', 'feimage']
const ATTRS = ['src', 'srcset', 'srcdoc', 'action', 'formaction', 'data', 'poster', 'ping', 'background', 'style', 'xlink:href', 'http-equiv', 'attributionsrc']

export const MOD_WORLD_LOCK = `if (!window.__mmLocked) {
  const no = (what) => { throw new Error('Mods cannot ' + what) }
  const lock = (owner, name) => {
    try { Object.defineProperty(owner, name, { configurable: false, get: () => no('use ' + name), set: () => no('use ' + name) }) } catch (e) {}
  }
  for (const name of ${JSON.stringify(GLOBALS)}) lock(window, name)
  const prototypes = ${JSON.stringify(PROTOTYPES)}
  for (const owner in prototypes) if (window[owner]) for (const name of prototypes[owner]) lock(window[owner].prototype, name)
  const writeOnly = ${JSON.stringify(WRITE_ONLY)}
  for (const owner in writeOnly) if (window[owner]) for (const name of writeOnly[owner]) {
    const real = Object.getOwnPropertyDescriptor(window[owner].prototype, name)
    try { Object.defineProperty(window[owner].prototype, name, { configurable: false, get: real && real.get, set: () => no('set ' + name) }) } catch (e) {}
  }
  for (const fn of [function () {}, async function () {}, function* () {}, async function* () {}]) lock(Object.getPrototypeOf(fn), 'constructor')
  for (const name of ['parseHTML', 'parseHTMLUnsafe']) lock(window.Document, name)
  if (window.CSS) for (const name of ['registerProperty', 'paintWorklet']) lock(window.CSS, name)

  const badScheme = (value) => /^(javascript|data|vbscript|blob):/i.test(String(value).replace(/[\\t\\n\\r]/g, '').replace(/^[\\u0000-\\u0020]+/, ''))
  for (const owner of [HTMLAnchorElement, HTMLAreaElement]) {
    const real = Object.getOwnPropertyDescriptor(owner.prototype, 'href')
    if (real) try { Object.defineProperty(owner.prototype, 'href', { configurable: false, get: real.get, set(value) {
      if (badScheme(value)) no('point a link at code')
      real.set.call(this, value)
    } }) } catch (e) {}
  }
  const realExec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) {
    if (/html/i.test(String(command))) no('insert html')
    return realExec.call(this, command, ...rest)
  }

  const inStyle = (node) => {
    for (let n = node, i = 0; n && i < 2; n = n.parentNode, i++) if (n instanceof HTMLStyleElement || (window.SVGStyleElement && n instanceof SVGStyleElement)) return true
    return false
  }
  const guardStyle = (owner, names, where) => {
    if (!owner) return
    for (const name of names) {
      const real = Object.getOwnPropertyDescriptor(owner.prototype, name)
      const key = real && (real.value ? 'value' : 'set')
      if (!key || !real[key]) continue
      const original = real[key]
      real[key] = function (...args) {
        if (inStyle(where ? where(this) : this)) no('change styles')
        return original.apply(this, args)
      }
      try { Object.defineProperty(owner.prototype, name, { ...real, configurable: false }) } catch (e) {}
    }
  }
  guardStyle(Node, ['appendChild', 'insertBefore', 'replaceChild'])
  guardStyle(Element, ['append', 'prepend', 'replaceChildren', 'before', 'after', 'replaceWith', 'insertAdjacentText', 'insertAdjacentElement'])
  guardStyle(CharacterData, ['data', 'appendData', 'insertData', 'replaceData', 'before', 'after', 'replaceWith'])
  guardStyle(Range, ['insertNode', 'surroundContents'], (range) => range.commonAncestorContainer)

  const tags = ${JSON.stringify(TAGS)}
  for (const maker of ['createElement', 'createElementNS']) {
    const real = Document.prototype[maker]
    Document.prototype[maker] = function (...args) {
      const tag = String(args[maker === 'createElement' ? 0 : 1]).toLowerCase().split(':').pop()
      if (tags.includes(tag)) no('create ' + tag)
      return real.apply(this, args)
    }
  }
  const attrs = ${JSON.stringify(ATTRS)}
  const realSetAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name, value) {
    const attr = String(name).toLowerCase()
    const loadsHref = attr === 'href' && !(this instanceof HTMLAnchorElement)
    if (attr.startsWith('on') || attrs.includes(attr) || loadsHref) no('set ' + attr)
    if (attr === 'content' && this instanceof HTMLMetaElement) no('set ' + attr)
    if (attr === 'href' && badScheme(value)) no('point a link at code')
    return realSetAttribute.call(this, name, value)
  }
  for (const name of ['textContent', 'nodeValue', 'innerText']) {
    const owner = name === 'innerText' ? HTMLElement.prototype : Node.prototype
    const real = Object.getOwnPropertyDescriptor(owner, name)
    if (!real) continue
    Object.defineProperty(owner, name, { configurable: false, get: real.get, set(value) {
      if (this instanceof Attr || this instanceof HTMLScriptElement || inStyle(this)) no('rewrite this')
      return real.set.call(this, value)
    } })
  }

  const loads = (value) => /\\\\|url\\s*\\(|image-set\\s*\\(|image\\s*\\(|src\\s*\\(/i.test(String(value))
  const guarded = new WeakMap()
  for (const owner of [HTMLElement.prototype, SVGElement.prototype, window.MathMLElement && MathMLElement.prototype].filter(Boolean)) {
    const real = Object.getOwnPropertyDescriptor(owner, 'style')
    if (!real) continue
    Object.defineProperty(owner, 'style', { configurable: false, set: () => no('replace style'), get() {
      const style = real.get.call(this)
      if (!guarded.has(style)) guarded.set(style, new Proxy(style, {
        set(target, prop, value) {
          if (loads(value)) no('load files from styles')
          target[prop] = value
          return true
        },
        get(target, prop) {
          if (prop === 'setProperty') return (name, value, priority) => {
            if (loads(value)) no('load files from styles')
            return target.setProperty(name, value, priority)
          }
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        }
      }))
      return guarded.get(style)
    } })
  }

  for (const timer of ['setTimeout', 'setInterval']) {
    const real = window[timer]
    window[timer] = function (work, ...rest) {
      if (typeof work !== 'function') no('run text as code')
      return real.call(window, work, ...rest)
    }
  }
  window.__mmLocked = true
}`
