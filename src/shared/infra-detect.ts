import { KEY_PROVIDERS, keyProvider } from './key-providers'
import { keyNameFromCode } from './key-owner'
import {
  BUSINESS_TYPES,
  INFRA_KINDS,
  type AppKind,
  type BusinessType,
  type InfraEntry,
  type InfraProvider
} from './infra'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  'worktrees',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.output',
  '.cache',
  'coverage',
  'vendor',
  '.wrangler',
  '.expo',
  'Pods',
  '.claude',
  'docs',
  'research',
  'notes',
  'design',
  'fixtures',
  '.venv',
  '__pycache__',
  'playwright-report',
  'test-results',
  'tmp',
  'DerivedData',
  'artifacts',
  '_media'
])
const KEEP_HIDDEN = new Set(['.github', '.eas'])
const NOT_PRODUCT_CODE = /(^|\/)(scripts|tools|ops)\//
const CODE_EXT = /\.(m?[jt]sx?|cjs|astro|vue|svelte|html|liquid|swift|kt|py|toml|jsonc|ya?ml|plist)$/
const ENV_FILE = /(^|\/)(\.dev\.vars|\.env[^/]*|wrangler\.json)$/
const PACKAGE_JSON = /(^|\/)package\.json$/
const TEST_FILE = /(\.(test|spec)\.|(^|\/)(__tests__|tests?|e2e)\/)/
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
const CATALOG_KIND_HITS = 6
const WRANGLER_ROUTE = /["']?pattern["']?\s*[:=]\s*["']([^"'/*]+?\.[a-z]{2,})(?:\/[^"']*)?["']/g
const MAX_ROUTE_HOSTS = 4
const POSTS_FOR_CONTENT_SITE = 5
const POST_FILE = /(^|\/)(content|posts|_posts|blog|articles)\/.*\.mdx?$/
const EXTENSION_MANIFEST = /(^|\/)manifest\.json$/
const EXTENSION_SCRIPT = /^(content|background|popup|service[-_]worker)\.(js|ts|html)$/
const SLICE_MS = 12
const INTERNAL_NAME = /(^|[-_/])(admin|backoffice|internal)([-_]|$)/

interface BusinessSignal {
  deps?: string[]
  files?: string[]
  code?: string[]
}

// the [l], [t], [a] endings stop this file matching its own rules when the scan reads it
const BUSINESS_SIGNALS: Partial<Record<BusinessType, BusinessSignal>> = {
  store: {
    deps: [
      '@shopify/hydrogen',
      '@shopify/hydrogen-react',
      '@shopify/storefront-api-client',
      '@shopify/cli',
      'shopify-buy',
      '@medusajs/',
      '@bigcommerce/',
      '@commercetools/',
      '@woocommerce/',
      '@saleor/',
      '@vendure/',
      'swell-js',
      'use-shopping-cart'
    ],
    files: [
      '(^|/)(sections|templates|snippets|layout)/[^/]+\\.liquid$',
      '(^|/)shopify\\.theme\\.toml$'
    ]
  },
  saas: {
    deps: ['@lemonsqueezy/', '@paddle/', '@polar-sh/'],
    code: [
      'mode:\\s*[\'"]subscription[\'"]',
      'customer\\.subscription\\.',
      'billing_porta[l]|billingPorta[l]'
    ]
  },
  marketplace: {
    deps: ['sharetribe-flex-sdk', '@sharetribe/', 'mangopay2-nodejs-sdk'],
    code: ['application_fee_amoun[t]', 'transfer_dat[a]', 'accountLinks\\.create']
  },
  extension: {
    deps: [
      'wxt',
      'plasmo',
      '@crxjs/vite-plugin',
      'vite-plugin-web-extension',
      'webextension-polyfill'
    ],
    code: ['\\b(chrome|browser)\\.(runtime|tabs|storage|action|scripting)\\.']
  },
  devtool: {
    deps: ['@modelcontextprotocol/sdk', '@oclif/core'],
    files: ['(^|/)openapi\\.(ya?ml|json)$']
  },
  content: {
    deps: [
      '@astrojs/rss',
      '@astrojs/starlight',
      '@docusaurus/',
      '@tryghost/content-api',
      '@11ty/eleventy',
      '@content-collections/core',
      'contentlayer',
      'fumadocs-core',
      'gatsby-transformer-remark',
      'hexo',
      'nextra',
      'velite',
      'vitepress'
    ],
    files: ['(^|/)(_config\\.yml|hugo\\.(toml|ya?ml)|mkdocs\\.ya?ml)$']
  },
  internal: { deps: ['react-admin', '@refinedev/', 'adminjs'] }
}

export const MAX_SCAN_FILE_BYTES = 400_000
export const MAX_SCAN_FILES = 25_000
export const SCAN_TEXT_PATTERNS = [CODE_EXT.source, ENV_FILE.source, PACKAGE_JSON.source]
export const SCAN_SKIP_PATTERN = `(^|/)(${[...SKIP_DIRS].map((d) => d.replace(/\./g, '\\.')).join('|')})/|(^|/)\\.(?!(${[...KEEP_HIDDEN].map((d) => d.slice(1)).join('|')})/)[^/]*/`

export interface RepoText {
  path: string
  text: string
}

export interface DetectedStack {
  appKinds: AppKind[]
  business: BusinessType[]
  services: Record<string, InfraEntry[]>
  names?: string[]
  routeHosts: string[]
}

interface CodeFile extends RepoText {
  isTest: boolean
}

export function skippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith('.') && !KEEP_HIDDEN.has(name))
}

export function wantsText(path: string): boolean {
  return CODE_EXT.test(path) || ENV_FILE.test(path) || PACKAGE_JSON.test(path)
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function depsOf(texts: RepoText[]): Map<string, string> {
  const deps = new Map<string, string>()
  for (const { path, text } of texts.filter((t) => PACKAGE_JSON.test(t.path))) {
    const json = parseJson(text) as { dependencies?: object; devDependencies?: object } | null
    for (const name of Object.keys({ ...json?.dependencies, ...json?.devDependencies })) {
      if (!deps.has(name)) deps.set(name, path)
    }
  }
  return deps
}

function depHit(deps: Map<string, string>, patterns: string[] = []): string | null {
  for (const pattern of patterns) {
    for (const [name, file] of deps) {
      if (pattern.endsWith('/') ? name.startsWith(pattern) : name === pattern) return file
    }
  }
  return null
}

function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

function slicer(): () => Promise<void> | null {
  let sliceStart = performance.now()
  return () => {
    if (performance.now() - sliceStart < SLICE_MS) return null
    return new Promise((resolve) =>
      setTimeout(() => {
        sliceStart = performance.now()
        resolve()
      }, 0)
    )
  }
}

function productCode(code: CodeFile[], kindId: string): CodeFile[] {
  return code.filter((f) => !(f.isTest && kindId !== 'tests') && !NOT_PRODUCT_CODE.test(f.path))
}

async function catalogFiles(
  code: CodeFile[],
  rest: () => Promise<void> | null
): Promise<Set<string>> {
  const kinds = INFRA_KINDS.map((k) =>
    k.providers.flatMap((p) => (p.code ?? []).map((r) => new RegExp(r, 'm')))
  )
  const docHosts = [...new Set(KEY_PROVIDERS.map((p) => new URL(p.docsUrl).host))]
  const out = new Set<string>()
  for (const file of productCode(code, '')) {
    await rest()
    const hits = kinds.filter((regexes) => regexes.some((r) => r.test(file.text))).length
    const docs = docHosts.filter((h) => file.text.includes(h)).length
    if (hits >= CATALOG_KIND_HITS || docs >= CATALOG_KIND_HITS) out.add(file.path)
  }
  return out
}

async function codeHit(
  code: CodeFile[],
  provider: InfraProvider,
  rest: () => Promise<void> | null
): Promise<string | null> {
  const regexes = (provider.code ?? []).map((r) => new RegExp(r, 'm'))
  if (!regexes.length) return null
  const scope = (provider.codeIn ?? []).map((r) => new RegExp(r))
  for (const file of code) {
    if (scope.length && !scope.some((r) => r.test(file.path))) continue
    await rest()
    for (const r of regexes) {
      const m = r.exec(file.text)
      if (m) return `${file.path}:${lineOf(file.text, m.index)}`
    }
  }
  return null
}

function detectAppKinds(deps: Map<string, string>, files: string[], code: CodeFile[]): AppKind[] {
  const has = (n: string): boolean => deps.has(n)
  const kinds = new Set<AppKind>()
  if (
    has('expo') ||
    has('react-native') ||
    files.some((f) => /\.xcodeproj\//.test(f) && !/macos/i.test(f)) ||
    files.some((f) => /(^|\/)src\/main\/AndroidManifest\.xml$/.test(f))
  )
    kinds.add('mobile')
  if (
    has('electron') ||
    code.some(
      (t) =>
        t.path.endsWith('.swift') &&
        !NOT_PRODUCT_CODE.test(t.path) &&
        /^import (AppKit|Cocoa)/m.test(t.text)
    )
  )
    kinds.add('desktop')
  if (
    ['astro', 'next', 'react-dom', 'vue', 'svelte'].some(has) ||
    files.some((f) => /(^|\/)(public\/)?index\.html$/.test(f)) ||
    code.some((t) => !t.isTest && /\.[jt]sx?$/.test(t.path) && /<!doctype html/i.test(t.text))
  )
    kinds.add('web')
  if (
    files.some((f) => /(^|\/)wrangler\.(toml|jsonc?)$/.test(f)) ||
    ['hono', 'express', 'fastify'].some(has)
  )
    kinds.add('worker')
  if (
    kinds.has('mobile') &&
    !['astro', 'next'].some(has) &&
    !files.some((f) => /(^|\/)(apps|packages)\/(web|site|landing|marketing)\//.test(f))
  ) {
    if (!files.some((f) => /\.html$/.test(f) && !/ios|android/.test(f))) kinds.delete('web')
  }
  return [...kinds]
}

function detectBusiness(
  deps: Map<string, string>,
  files: string[],
  code: CodeFile[],
  rootPackage: Record<string, unknown> | null,
  appKinds: AppKind[],
  services: Record<string, InfraEntry[]>
): BusinessType[] {
  const product = productCode(code, '')
  const hit = (type: BusinessType, part?: keyof BusinessSignal): boolean => {
    const signal = BUSINESS_SIGNALS[type] ?? {}
    const want = (key: keyof BusinessSignal): string[] =>
      !part || part === key ? (signal[key] ?? []) : []
    return (
      depHit(deps, want('deps')) !== null ||
      want('files').some((r) => files.some((f) => new RegExp(r).test(f))) ||
      want('code').some((r) => product.some((f) => new RegExp(r, 'm').test(f.text)))
    )
  }
  const uses = (kindId: string): boolean => (services[kindId] ?? []).length > 0
  const extensionFolder = files.some((manifest) => {
    if (!EXTENSION_MANIFEST.test(manifest)) return false
    const folder = manifest.slice(0, -'manifest.json'.length)
    return (
      hit('extension', 'code') ||
      files.some((f) => f.startsWith(folder) && EXTENSION_SCRIPT.test(f.slice(folder.length)))
    )
  })
  const found = new Set<BusinessType>()
  if (hit('store') || services.hosting?.some((e) => e.provider === 'shopify_theme'))
    found.add('store')
  if (hit('marketplace')) found.add('marketplace')
  const sellsToVisitors = found.has('store') || found.has('marketplace')
  if (uses('auth') && (hit('saas') || (appKinds.includes('web') && !sellsToVisitors)))
    found.add('saas')
  if (hit('extension', 'deps') || extensionFolder) found.add('extension')
  if (appKinds.includes('mobile') || appKinds.includes('desktop')) found.add('app')
  if (hit('devtool') || rootPackage?.bin || (appKinds.length === 1 && appKinds[0] === 'worker'))
    found.add('devtool')
  if (hit('content') || files.filter((f) => POST_FILE.test(f)).length >= POSTS_FOR_CONTENT_SITE)
    found.add('content')
  if (hit('internal') || INTERNAL_NAME.test(String(rootPackage?.name ?? ''))) found.add('internal')
  if (!found.size && appKinds.includes('web')) found.add('landing')
  return BUSINESS_TYPES.filter((type) => found.has(type))
}

function namesIn(texts: RepoText[], code: CodeFile[]): string[] {
  const names = new Set<string>()
  for (const f of code) for (const m of f.text.matchAll(ENV_NAME)) names.add(m[0])
  for (const { path, text } of texts.filter((t) => ENV_FILE.test(t.path))) {
    const re = path.endsWith('.json') ? ENV_NAME : /^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm
    for (const m of text.matchAll(re)) names.add(m[1] ?? m[0])
  }
  return [...names]
}

function keyNameFor(
  provider: InfraProvider,
  code: CodeFile[],
  foundIn: string,
  names: string[]
): Pick<InfraEntry, 'key' | 'keyGuessed'> {
  const def =
    !provider.noKey && provider.keyProvider ? keyProvider(provider.keyProvider) : undefined
  if (!def) return {}
  const text = code.find((f) => f.path === foundIn.split(':')[0])?.text ?? ''
  const hit = keyNameFromCode(def, names, text, KEY_PROVIDERS)
  return hit ? { key: hit.key, ...(hit.guessed ? { keyGuessed: true } : {}) } : {}
}

function routeHosts(code: CodeFile[]): string[] {
  const hosts = new Set<string>()
  for (const file of code) {
    if (!/wrangler\.(toml|jsonc?)$/.test(file.path)) continue
    for (const m of file.text.matchAll(WRANGLER_ROUTE)) hosts.add(m[1].toLowerCase())
  }
  const notProd = (h: string): number =>
    /(^|\.)(staging|stage|dev|preview|test)\./.test(h) ? 1 : 0
  return [...hosts].sort((a, b) => notProd(a) - notProd(b)).slice(0, MAX_ROUTE_HOSTS)
}

export async function detectStack(files: string[], texts: RepoText[]): Promise<DetectedStack> {
  const rest = slicer()
  const allCode = texts
    .filter((t) => CODE_EXT.test(t.path))
    .map((t) => ({ ...t, isTest: TEST_FILE.test(t.path) }))
  const deps = depsOf(texts)
  const catalogs = await catalogFiles(allCode, rest)
  const code = allCode.filter((f) => !catalogs.has(f.path))
  const product = productCode(code, '')
  const productAndTests = productCode(code, 'tests')
  const names = namesIn(texts, code)
  const services: Record<string, InfraEntry[]> = {}
  for (const kind of INFRA_KINDS) {
    const found: InfraEntry[] = []
    for (const provider of kind.providers) {
      const dep = depHit(deps, provider.deps)
      const inCode = await codeHit(kind.id === 'tests' ? productAndTests : product, provider, rest)
      const fileRes = (provider.files ?? []).map((r) => new RegExp(r))
      const file = fileRes.length ? files.find((f) => fileRes.some((r) => r.test(f))) : undefined
      const wired = inCode || file || !(provider.code ?? []).length
      const foundIn = inCode ?? file ?? dep
      if (!foundIn || !wired) continue
      found.push({ provider: provider.id, foundIn, ...keyNameFor(provider, code, foundIn, names) })
    }
    const real = found.filter((e) => !kind.providers.find((p) => p.id === e.provider)?.fallback)
    services[kind.id] = real.length ? real : found
  }
  for (const kind of INFRA_KINDS) {
    for (const e of services[kind.id]) {
      for (const covered of kind.providers.find((p) => p.id === e.provider)?.covers ?? []) {
        if (!services[covered]?.length) services[covered] = [{ ...e }]
      }
    }
  }
  const rootPackage = parseJson(texts.find((t) => t.path === 'package.json')?.text)
  const productName = rootPackage?.name
  const appKinds = detectAppKinds(deps, files, code)
  return {
    appKinds,
    business: detectBusiness(deps, files, code, rootPackage, appKinds, services),
    services,
    ...(typeof productName === 'string' && productName ? { names: [productName] } : {}),
    routeHosts: routeHosts(code)
  }
}
