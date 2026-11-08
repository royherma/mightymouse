// Mirrored byte-for-byte at supabase/functions/_shared/site-mod-check.ts (site-mod-check.test.ts fails on drift).

export type ModKind = 'look' | 'code'
export type ModLevel = 'safe' | 'ask' | 'refuse'

export interface ModVerdict {
  kind: ModKind
  level: ModLevel
  refused: string[]
  asks: string[]
  css: string
  cssRemoved: number
}

interface AstNode {
  type: string
  [key: string]: unknown
}

interface CssNode {
  type: string
  name?: string
  prop?: string
  value?: string
  params?: string
  selector?: string
  remove(): void
}

interface CssRoot {
  walk(visit: (node: CssNode) => void): void
  toString(): string
}

export interface ModParsers {
  parseJs: (code: string) => unknown
  parseCss: (css: string) => CssRoot
}

const NET = 'talks to the internet'
const DATA = 'reads saved data'
const HIDDEN = 'runs hidden code'
const OUTSIDE = 'loads outside files'
const WINDOWS = 'reaches into other windows'
const FORMS = 'submits forms by itself'
const LEAVES = 'sends you to another page'
const DEVICES = 'uses your location, camera or devices'
const PASSWORDS = 'touches password fields'
const CARDS = 'touches card fields'
const OURS = 'reaches into MightyMouse'
const CLIPBOARD = 'reads your clipboard'
const BROKEN = 'has an error in its code'

const PRESSES = 'presses buttons on the site for you'
const TYPES = 'types into the site for you'
const WRITES = 'asks the AI to write text from the page'
const LINKS = 'adds or changes links'
const POPUPS = 'shows pop-up questions'
const UNCLEAR = 'does things the check cannot follow'

const REFUSED_GLOBALS: Record<string, string> = {
  fetch: NET,
  XMLHttpRequest: NET,
  WebSocket: NET,
  EventSource: NET,
  RTCPeerConnection: NET,
  webkitRTCPeerConnection: NET,
  WebTransport: NET,
  fetchLater: NET,
  Worker: NET,
  SharedWorker: NET,
  BroadcastChannel: NET,
  MessageChannel: NET,
  postMessage: NET,
  importScripts: HIDDEN,
  eval: HIDDEN,
  Function: HIDDEN,
  execScript: HIDDEN,
  DOMParser: HIDDEN,
  XSLTProcessor: HIDDEN,
  CSSStyleSheet: OUTSIDE,
  FontFace: OUTSIDE,
  navigation: LEAVES,
  SpeechRecognition: DEVICES,
  webkitSpeechRecognition: DEVICES,
  MediaRecorder: DEVICES,
  localStorage: DATA,
  sessionStorage: DATA,
  indexedDB: DATA,
  caches: DATA,
  cookieStore: DATA,
  globalThis: WINDOWS,
  self: WINDOWS,
  top: WINDOWS,
  parent: WINDOWS,
  frames: WINDOWS,
  opener: WINDOWS,
  frameElement: WINDOWS,
  open: LEAVES,
  Image: OUTSIDE,
  Audio: OUTSIDE,
  __mm: OURS,
  require: HIDDEN,
  process: HIDDEN
}

const ASK_GLOBALS: Record<string, string> = {
  Reflect: UNCLEAR,
  Proxy: UNCLEAR,
  atob: UNCLEAR,
  btoa: UNCLEAR,
  unescape: UNCLEAR,
  escape: UNCLEAR,
  prompt: POPUPS,
  Notification: POPUPS
}

const REFUSED_MEMBERS: Record<string, string> = {
  fetch: NET,
  sendBeacon: NET,
  XMLHttpRequest: NET,
  WebSocket: NET,
  EventSource: NET,
  postMessage: NET,
  fetchLater: NET,
  addModule: NET,
  Worker: NET,
  SharedWorker: NET,
  RTCPeerConnection: NET,
  webkitRTCPeerConnection: NET,
  WebTransport: NET,
  BroadcastChannel: NET,
  MessageChannel: NET,
  Function: HIDDEN,
  DOMParser: HIDDEN,
  XSLTProcessor: HIDDEN,
  Image: OUTSIDE,
  Audio: OUTSIDE,
  CSSStyleSheet: OUTSIDE,
  FontFace: OUTSIDE,
  serviceWorker: NET,
  cookie: DATA,
  cookieStore: DATA,
  localStorage: DATA,
  sessionStorage: DATA,
  indexedDB: DATA,
  caches: DATA,
  credentials: DATA,
  contentWindow: WINDOWS,
  contentDocument: WINDOWS,
  defaultView: WINDOWS,
  frameElement: WINDOWS,
  opener: WINDOWS,
  constructor: HIDDEN,
  __proto__: HIDDEN,
  eval: HIDDEN,
  execScript: HIDDEN,
  importScripts: HIDDEN,
  insertAdjacentHTML: HIDDEN,
  createContextualFragment: HIDDEN,
  setHTMLUnsafe: HIDDEN,
  parseHTMLUnsafe: HIDDEN,
  setHTML: HIDDEN,
  parseHTML: HIDDEN,
  write: HIDDEN,
  writeln: HIDDEN,
  httpEquiv: LEAVES,
  registerProperty: OUTSIDE,
  fonts: OUTSIDE,
  adoptedStyleSheets: OUTSIDE,
  styleSheets: OUTSIDE,
  insertRule: OUTSIDE,
  addRule: OUTSIDE,
  replaceSync: OUTSIDE,
  sheet: OUTSIDE,
  srcdoc: HIDDEN,
  setAttributeNS: HIDDEN,
  setAttributeNode: HIDDEN,
  createAttribute: HIDDEN,
  submit: FORMS,
  requestSubmit: FORMS,
  geolocation: DEVICES,
  mediaDevices: DEVICES,
  getUserMedia: DEVICES,
  getDisplayMedia: DEVICES,
  bluetooth: DEVICES,
  usb: DEVICES,
  serial: DEVICES,
  hid: DEVICES,
  readText: CLIPBOARD,
  __mm: OURS
}

const ASK_MEMBERS: Record<string, string> = {
  click: PRESSES,
  dispatchEvent: PRESSES,
  execCommand: TYPES,
  prototype: UNCLEAR,
  getOwnPropertyDescriptor: UNCLEAR,
  getOwnPropertyDescriptors: UNCLEAR,
  getPrototypeOf: UNCLEAR,
  setPrototypeOf: UNCLEAR,
  defineProperty: UNCLEAR,
  defineProperties: UNCLEAR,
  __defineGetter__: UNCLEAR,
  __defineSetter__: UNCLEAR,
  __lookupGetter__: UNCLEAR,
  __lookupSetter__: UNCLEAR,
  attributes: UNCLEAR,
  read: CLIPBOARD,
  fromCharCode: UNCLEAR,
  fromCodePoint: UNCLEAR,
  createObjectURL: UNCLEAR,
  requestFullscreen: POPUPS,
  pushState: LINKS,
  replaceState: LINKS
}

const LOADING_PROPS = new Set([
  'src',
  'srcset',
  'action',
  'formAction',
  'data',
  'poster',
  'ping',
  'background',
  'lowsrc',
  'manifest',
  'codeBase',
  'srcObject',
  'attributionSrc',
  'baseVal'
])
const LOADING_ATTRS = new Set([...LOADING_PROPS].map((p) => p.toLowerCase()).concat(['formaction', 'xlink:href', 'style']))
const URL_PARTS = new Set(['host', 'hostname', 'port', 'protocol', 'pathname', 'search', 'username', 'password'])
const READ_LOCATION = new Set(['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'toString'])
const CALLEE_ONLY = new Set(['createElement', 'createElementNS', 'setAttribute', 'toggleAttribute', 'setProperty', 'setTimeout', 'setInterval'])
const RAW_HTML_PROPS = new Set(['innerHTML', 'outerHTML'])
const STYLE_PROPS = new Set(['cssText', 'background', 'backgroundImage', 'content', 'listStyle', 'listStyleImage', 'borderImage', 'borderImageSource', 'mask', 'maskImage', 'cursor', 'webkitMaskImage', 'webkitMask', 'webkitMaskBoxImage', 'webkitBorderImage', 'maskBorder', 'maskBorderSource', 'shapeOutside', 'offsetPath'])
const REFUSED_TAGS = new Set(['script', 'iframe', 'frame', 'object', 'embed', 'link', 'form', 'base', 'meta', 'portal', 'fencedframe', 'style', 'img', 'audio', 'video', 'source', 'track', 'svg', 'image', 'use'])
const MATH_CALLS = new Set(['floor', 'ceil', 'round', 'min', 'max', 'abs', 'trunc'])
const ARITHMETIC = new Set(['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>'])
const KEPT_AT_RULES = new Set(['media', 'supports', 'container', 'keyframes', '-webkit-keyframes', 'layer', 'property', 'starting-style', 'scope'])

const WEB_ADDRESS = /(?:https?:|wss?:|ftp:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i
const CSS_LOADS = /(?:url|image-set|-webkit-image-set|image|src|cross-fade|element|paint)\s*\(/i
const CSS_DATA_IMAGE = /url\(\s*["']?data:image\//gi

const BLOCKED_HOSTS = [
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'stripe.com',
  'paypal.com',
  'wise.com',
  'mercury.com',
  'coinbase.com',
  '1password.com',
  'bitwarden.com'
]
const BLOCKED_HOST_WORDS = /bank|banking|wallet|pay\b/i

export function modHostBlocked(host: string): boolean {
  const name = host.toLowerCase().replace(/^www\./, '')
  return BLOCKED_HOSTS.some((h) => name === h || name.endsWith(`.${h}`)) || BLOCKED_HOST_WORDS.test(name)
}

const SHARED_HOSTING = new Set([
  'github.io', 'gitlab.io', 'vercel.app', 'pages.dev', 'workers.dev', 'netlify.app', 'herokuapp.com', 'blogspot.com', 'web.app',
  'firebaseapp.com', 'appspot.com', 'glitch.me', 'repl.co', 'onrender.com', 'azurewebsites.net', 'amazonaws.com', 'cloudfront.net',
  'wixsite.com', 'myshopify.com', 'notion.site', 'fly.dev', 'ngrok.io', 'ngrok-free.app'
])

export function modHostTooBroad(host: string): boolean {
  const name = host.toLowerCase().replace(/^www\./, '')
  return SHARED_HOSTING.has(name) || /^(?:co|com|org|net|gov|edu|ac|or|ne|go|gob|nom|mil)\.[a-z]{2}$/.test(name) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(name)
}

const isNode = (v: unknown): v is AstNode => Boolean(v) && typeof (v as AstNode).type === 'string'
const nameOf = (v: unknown): string | null => (isNode(v) && v.type === 'Identifier' ? (v.name as string) : null)

function staticText(node: unknown): string | null {
  if (!isNode(node)) return null
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null
  if (node.type !== 'TemplateLiteral' || (node.expressions as unknown[]).length) return null
  return (node.quasis as Array<{ value: { cooked: string | null } }>).map((q) => q.value.cooked ?? '').join('')
}

function unescapeCss(text: string): string {
  return text
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)))
    .replace(/\\([^\n])/g, '$1')
}

function loadsFromWeb(cssText: string): boolean {
  return CSS_LOADS.test(unescapeCss(cssText).replace(CSS_DATA_IMAGE, ''))
}

export function cleanModCss(css: string, parseCss: ModParsers['parseCss']): { css: string; removed: number; error: boolean } {
  if (!css.trim()) return { css: '', removed: 0, error: false }
  let removed = 0
  const drop = (node: CssNode): void => {
    removed += 1
    node.remove()
  }
  try {
    const root = parseCss(css)
    root.walk((node) => {
      if (node.type === 'atrule') {
        if (!KEPT_AT_RULES.has((node.name ?? '').toLowerCase()) || loadsFromWeb(node.params ?? '')) drop(node)
      } else if (node.type === 'decl') {
        const prop = unescapeCss(node.prop ?? '').toLowerCase()
        if (prop === 'behavior' || prop === '-moz-binding' || loadsFromWeb(node.value ?? '')) drop(node)
      } else if (node.type === 'rule' && loadsFromWeb(node.selector ?? '')) drop(node)
    })
    return { css: root.toString(), removed, error: false }
  } catch {
    return { css: '', removed: 1, error: true }
  }
}

interface Scope {
  names: Set<string>
  parent: Scope | null
}

function bindNames(pattern: unknown, into: Set<string>): void {
  if (!isNode(pattern)) return
  if (pattern.type === 'Identifier') into.add(pattern.name as string)
  else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties as AstNode[]) bindNames(p.type === 'RestElement' ? p.argument : p.value, into)
  else if (pattern.type === 'ArrayPattern') for (const el of pattern.elements as unknown[]) bindNames(el, into)
  else if (pattern.type === 'AssignmentPattern') bindNames(pattern.left, into)
  else if (pattern.type === 'RestElement') bindNames(pattern.argument, into)
}

function hoistedVars(node: AstNode, into: Set<string>): void {
  eachChild(node, (child) => {
    if (child.type === 'VariableDeclaration' && child.kind === 'var') for (const d of child.declarations as AstNode[]) bindNames(d.id, into)
    if (!child.type.includes('Function')) hoistedVars(child, into)
  })
}

function lexicalNames(statements: unknown[], into: Set<string>): void {
  for (const s of statements) {
    if (!isNode(s)) continue
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations as AstNode[]) bindNames(d.id, into)
    else if (s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration') bindNames(s.id, into)
  }
}

function scopeNames(node: AstNode): Set<string> | null {
  const names = new Set<string>()
  const body = node.body as AstNode
  switch (node.type) {
    case 'Program':
      hoistedVars(node, names)
      lexicalNames(node.body as unknown[], names)
      break
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      for (const p of node.params as unknown[]) bindNames(p, names)
      if (node.type === 'FunctionExpression') bindNames(node.id, names)
      hoistedVars(body, names)
      if (body.type === 'BlockStatement') lexicalNames(body.body as unknown[], names)
      break
    case 'BlockStatement':
    case 'StaticBlock':
      lexicalNames(node.body as unknown[], names)
      break
    case 'SwitchStatement':
      for (const c of node.cases as AstNode[]) lexicalNames(c.consequent as unknown[], names)
      break
    case 'ForStatement':
      lexicalNames([node.init], names)
      break
    case 'ForInStatement':
    case 'ForOfStatement':
      lexicalNames([node.left], names)
      break
    case 'CatchClause':
      bindNames(node.param, names)
      break
    case 'ClassDeclaration':
    case 'ClassExpression':
      bindNames(node.id, names)
      break
    default:
      return null
  }
  return names
}

function isLocal(name: string, scope: Scope | null): boolean {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true
  return false
}

function writeTargets(pattern: unknown, out: AstNode[]): AstNode[] {
  if (!isNode(pattern)) return out
  if (pattern.type === 'ObjectPattern') for (const p of pattern.properties as AstNode[]) writeTargets(p.type === 'RestElement' ? p.argument : p.value, out)
  else if (pattern.type === 'ArrayPattern') for (const el of pattern.elements as unknown[]) writeTargets(el, out)
  else if (pattern.type === 'AssignmentPattern') writeTargets(pattern.left, out)
  else if (pattern.type === 'RestElement') writeTargets(pattern.argument, out)
  else out.push(pattern)
  return out
}

const isPattern = (node: AstNode): boolean => node.type === 'ObjectPattern' || node.type === 'ArrayPattern'

function eachChild(node: AstNode, visit: (child: AstNode, key: string) => void): void {
  for (const key in node) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item, key)
    } else if (isNode(value)) visit(value, key)
  }
}

function numericKey(node: unknown, counters: Set<string>, scope: Scope | null): boolean {
  if (!isNode(node)) return false
  if (node.type === 'Literal') return typeof node.value === 'number'
  if (node.type === 'Identifier') return counters.has(node.name as string)
  if (node.type === 'UpdateExpression') return true
  if (node.type === 'UnaryExpression') return node.operator === '-' || node.operator === '+' || node.operator === '~'
  if (node.type === 'BinaryExpression') {
    if (ARITHMETIC.has(node.operator as string)) return true
    return node.operator === '+' && numericKey(node.left, counters, scope) && numericKey(node.right, counters, scope)
  }
  if (node.type === 'CallExpression') {
    const callee = node.callee as AstNode
    return callee.type === 'MemberExpression' && !callee.computed && nameOf(callee.object) === 'Math' && !isLocal('Math', scope) && MATH_CALLS.has(nameOf(callee.property) ?? '')
  }
  return false
}

function functionNames(root: AstNode): Set<string> {
  const names = new Set<string>()
  const visit = (node: AstNode): void => {
    const init = node.init as AstNode | null
    if (node.type === 'FunctionDeclaration') names.add(nameOf(node.id) ?? '')
    else if (node.type === 'VariableDeclarator' && init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression'))
      names.add(nameOf(node.id) ?? '')
    eachChild(node, visit)
  }
  visit(root)
  return names
}

function loopCounters(root: AstNode): Set<string> {
  const counters = new Set<string>()
  const spoiled = new Set<string>()
  const spoilWrites = (left: unknown, plain: boolean): void => {
    for (const t of writeTargets(left, [])) if (t.type === 'Identifier' && !plain) spoiled.add(t.name as string)
  }
  const visit = (node: AstNode): void => {
    const init = node.init as AstNode | null
    if (node.type === 'VariableDeclarator') {
      if (nameOf(node.id) && init?.type === 'Literal' && typeof init.value === 'number') counters.add(nameOf(node.id) as string)
      else bindNames(node.id, spoiled)
    } else if (node.type === 'CatchClause') bindNames(node.param, spoiled)
    else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') bindNames(node.id, spoiled)
    else if (node.type.includes('Function')) {
      bindNames(node.id, spoiled)
      for (const p of node.params as unknown[]) bindNames(p, spoiled)
    } else if (node.type === 'AssignmentExpression') {
      const right = node.right as AstNode
      const numeric = node.operator !== '=' && node.operator !== '+=' ? true : right.type === 'Literal' && typeof right.value === 'number'
      spoilWrites(node.left, numeric && !isPattern(node.left as AstNode))
    } else if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') spoilWrites(node.left, false)
    eachChild(node, visit)
  }
  visit(root)
  for (const name of spoiled) counters.delete(name)
  return counters
}

export function checkModJs(js: string, parseJs: ModParsers['parseJs']): { refused: string[]; asks: string[] } {
  if (!js.trim()) return { refused: [], asks: [] }
  try {
    return readJs(parseJs(js) as AstNode)
  } catch {
    return { refused: [BROKEN], asks: [] }
  }
}

function readJs(root: AstNode): { refused: string[]; asks: string[] } {
  const refused = new Set<string>()
  const asks = new Set<string>()
  const counters = loopCounters(root)
  const functions = functionNames(root)

  const text = (value: string): void => {
    if (/passw(or)?d/i.test(value)) refused.add(PASSWORDS)
    if (/cc-(number|csc|exp)|\bcvv\b|\bcvc\b|card-?number/i.test(value)) refused.add(CARDS)
    if (/url\s*\(|image-set\s*\(/i.test(value.replace(CSS_DATA_IMAGE, ''))) refused.add(OUTSIDE)
    if (/^\s*(javascript|vbscript):|data:text\/html/i.test(value)) refused.add(HIDDEN)
    const address = WEB_ADDRESS.exec(value)
    if (address) asks.add(`mentions a web address (${address[1].toLowerCase()})`)
  }

  const globalName = (name: string, isDeclaration: boolean, scope: Scope | null): void => {
    if (name === 'window') return
    const why = REFUSED_GLOBALS[name]
    if (why) (isDeclaration || isLocal(name, scope) ? asks.add(UNCLEAR) : refused.add(why))
    else if (ASK_GLOBALS[name]) asks.add(ASK_GLOBALS[name])
  }

  const memberName = (name: string, onWindow: boolean): void => {
    if (REFUSED_MEMBERS[name]) refused.add(REFUSED_MEMBERS[name])
    else if (ASK_MEMBERS[name]) asks.add(ASK_MEMBERS[name])
    if (onWindow) globalName(name, false, null)
  }

  const readsLocation = (parent: AstNode | null, key: string): boolean => {
    if (parent?.type === 'MemberExpression' && key === 'object') {
      const prop = parent.computed ? staticText(parent.property) : nameOf(parent.property)
      return prop !== null && READ_LOCATION.has(prop)
    }
    const pattern = parent?.type === 'VariableDeclarator' && key === 'init' ? (parent.id as AstNode) : null
    return pattern?.type === 'ObjectPattern' && (pattern.properties as AstNode[]).every((p) => p.type === 'Property' && !p.computed && READ_LOCATION.has(nameOf(p.key) ?? '') && nameOf(p.value) !== null)
  }

  const calleeOnly = (name: string, parent: AstNode | null, key: string): void => {
    if (CALLEE_ONLY.has(name) && !(parent?.type === 'CallExpression' && key === 'callee')) asks.add(UNCLEAR)
  }

  const assigned = (target: AstNode, value: AstNode, scope: Scope | null): void => {
    if (target.type === 'Identifier' && target.name === 'name' && !isLocal('name', scope)) asks.add(UNCLEAR)
    if (target.type !== 'MemberExpression') return
    const prop = target.computed ? staticText(target.property) : nameOf(target.property)
    if (!prop) return
    const object = target.object as AstNode
    const onLocation = nameOf(object) === 'location' || (object.type === 'MemberExpression' && nameOf(object.property) === 'location')
    if (onLocation || prop === 'location') refused.add(LEAVES)
    else if (RAW_HTML_PROPS.has(prop)) refused.add(HIDDEN)
    else if (LOADING_PROPS.has(prop)) refused.add(OUTSIDE)
    else if (prop === 'href' || URL_PARTS.has(prop)) asks.add(LINKS)
    else if (prop === 'name' && nameOf(object) === 'window') asks.add(UNCLEAR)
    else if (/^on[a-z]+$/.test(prop) && value.type !== 'ArrowFunctionExpression' && value.type !== 'FunctionExpression' && value.type !== 'Identifier')
      refused.add(HIDDEN)
    else if (STYLE_PROPS.has(prop) && staticText(value) === null) asks.add(UNCLEAR)
  }

  const called = (node: AstNode): void => {
    const callee = node.callee as AstNode
    const args = node.arguments as AstNode[]
    const first = args[0]
    const fn = callee.type === 'MemberExpression' ? (callee.computed ? staticText(callee.property) : nameOf(callee.property)) : nameOf(callee)
    const object = callee.type === 'MemberExpression' ? (callee.object as AstNode) : null
    if (!fn) return
    if ((fn === 'setTimeout' || fn === 'setInterval') && first) {
      const isFunction = first.type === 'ArrowFunctionExpression' || first.type === 'FunctionExpression' || functions.has(nameOf(first) ?? '')
      if (staticText(first) !== null || first.type === 'BinaryExpression' || first.type === 'TemplateLiteral') refused.add(HIDDEN)
      else if (!isFunction) asks.add(UNCLEAR)
    }
    if (fn === 'createElement' || fn === 'createElementNS') {
      const tag = staticText(args[fn === 'createElement' ? 0 : 1])
      if (tag === null) asks.add(UNCLEAR)
      else if (REFUSED_TAGS.has(tag.toLowerCase())) refused.add(OUTSIDE)
    }
    if (fn === 'setAttribute' || fn === 'toggleAttribute') {
      const attr = staticText(first)
      if (attr === null) asks.add(UNCLEAR)
      else if (/^on/i.test(attr) || attr.toLowerCase() === 'srcdoc') refused.add(HIDDEN)
      else if (LOADING_ATTRS.has(attr.toLowerCase())) refused.add(OUTSIDE)
      else if (attr.toLowerCase() === 'href') asks.add(LINKS)
      else if (attr.toLowerCase() === 'http-equiv') refused.add(LEAVES)
      else if (attr.toLowerCase() === 'content' && staticText(args[1]) === null) asks.add(UNCLEAR)
    }
    if (fn === 'setProperty' && staticText(args[1]) === null) asks.add(UNCLEAR)
    if (fn === 'open' && object && args.length) refused.add(LEAVES)
    if (fn === 'assign' && nameOf(object) === 'Object' && first?.type !== 'ObjectExpression') asks.add(UNCLEAR)
    if (fn === 'ask' && nameOf(object) === 'mm') asks.add(WRITES)
    if (fn === 'call' || fn === 'apply' || fn === 'bind') {
      if (!first || (first.type === 'Literal' && first.value === null) || nameOf(first) === 'undefined' || nameOf(first) === 'window') asks.add(UNCLEAR)
    }
  }

  const visit = (node: AstNode, parent: AstNode | null, key: string, inClass: boolean, outer: Scope | null): void => {
    const names = scopeNames(node)
    const scope = names ? { names, parent: outer } : outer
    switch (node.type) {
      case 'ImportExpression':
      case 'ImportDeclaration':
      case 'WithStatement':
        refused.add(HIDDEN)
        break
      case 'ThisExpression':
        if (!inClass) asks.add(UNCLEAR)
        break
      case 'Literal':
        if (typeof node.value === 'string') text(node.value)
        break
      case 'TemplateElement':
        text((node.value as { cooked: string | null }).cooked ?? '')
        break
      case 'TaggedTemplateExpression':
        asks.add(UNCLEAR)
        break
      case 'AssignmentExpression': {
        const left = node.left as AstNode
        for (const target of writeTargets(left, [])) assigned(target, isPattern(left) ? node : (node.right as AstNode), scope)
        break
      }
      case 'ForInStatement':
      case 'ForOfStatement':
        for (const target of writeTargets(node.left, [])) if (target.type !== 'VariableDeclaration') assigned(target, node, scope)
        break
      case 'UpdateExpression':
        assigned(node.argument as AstNode, node, scope)
        break
      case 'CallExpression':
      case 'NewExpression':
        called(node)
        break
      case 'MemberExpression': {
        const onWindow = nameOf(node.object) === 'window'
        const prop = node.computed ? staticText(node.property) : nameOf(node.property)
        if (prop !== null) {
          memberName(prop, onWindow)
          calleeOnly(prop, parent, key)
          if (prop === 'location' && !readsLocation(parent, key)) refused.add(LEAVES)
        } else if (node.computed && (onWindow || !numericKey(node.property, counters, scope))) asks.add(UNCLEAR)
        break
      }
      case 'Property':
        if (parent?.type === 'ObjectPattern') {
          const name = node.computed ? staticText(node.key) : nameOf(node.key)
          if (name) {
            memberName(name, false)
            calleeOnly(name, null, '')
            if (name === 'location') refused.add(LEAVES)
          } else asks.add(UNCLEAR)
        }
        break
      case 'Identifier': {
        const name = node.name as string
        const isMemberName = parent?.type === 'MemberExpression' && key === 'property' && !parent.computed
        const isKey = (parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed
        const isLabel = parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement'
        if (isMemberName || isLabel) break
        if (isKey && !(parent?.type === 'Property' && parent.shorthand)) break
        if (name === 'window') {
          const direct = parent?.type === 'MemberExpression' && key === 'object'
          if (!direct) asks.add(UNCLEAR)
          break
        }
        const isDeclaration =
          (parent?.type === 'VariableDeclarator' && key === 'id') ||
          (key === 'params' && Boolean(parent?.type.includes('Function'))) ||
          (key === 'id' && Boolean(parent?.type.includes('Function') || parent?.type.includes('Class')))
        if (name === 'location' && !isDeclaration && !isLocal(name, scope) && !readsLocation(parent, key)) refused.add(LEAVES)
        if (!isDeclaration && !isLocal(name, scope)) calleeOnly(name, parent, key)
        globalName(name, isDeclaration, scope)
        break
      }
    }
    const nowInClass = inClass || node.type === 'ClassBody'
    eachChild(node, (child, childKey) => visit(child, node, childKey, nowInClass, scope))
  }
  visit(root, null, '', false, null)
  return { refused: [...refused], asks: [...asks] }
}

export function checkMod(code: { css: string; js: string }, parsers: ModParsers): ModVerdict {
  const cleaned = cleanModCss(code.css, parsers.parseCss)
  const js = checkModJs(code.js, parsers.parseJs)
  const refused = cleaned.error ? [...js.refused, BROKEN] : js.refused
  return {
    kind: code.js.trim() ? 'code' : 'look',
    level: refused.length ? 'refuse' : js.asks.length ? 'ask' : 'safe',
    refused: [...new Set(refused)],
    asks: js.asks,
    css: cleaned.css,
    cssRemoved: cleaned.removed
  }
}

export async function modFingerprint(mod: { host: string; css: string; js: string }): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([mod.host, mod.css, mod.js]))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
