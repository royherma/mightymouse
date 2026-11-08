import { readFile } from 'fs/promises'
import { basename, join } from 'path'
import type { EnvAccount, InfraEnvironment } from '../../shared/infra'
import { ENV_ALIASES as ALIASES } from '../../shared/surfaces'

const ORDER = ['prod', 'staging', 'preview', 'dev']
const NAMES = Object.keys(ALIASES).join('|')

const SHELL_FILE = /\.(sh|bash|zsh)$/
const WRANGLER_FILE = /(^|\/)wrangler\.toml$/
const DOTENV_FILE = new RegExp(`^\\.env\\.(${NAMES})(\\.example|\\.sample)?$`)
const CASE_LABEL = new RegExp(`^\\s*((?:${NAMES})(?:\\s*\\|\\s*(?:${NAMES}))*)\\s*\\)`)
const WRANGLER_ENV = new RegExp(`^\\s*\\[env\\.(${NAMES})(?:\\.[\\w.-]+)?\\]`)
const PKG_SCRIPT = new RegExp(`"[\\w-]+:(${NAMES})"\\s*:`, 'g')

const SUPABASE_URL = /https:\/\/([a-z]{20})\.supabase\.co/g
const SUPABASE_REF_LINE = /ref|supabase/i
const SUPABASE_REF = /(?<![\w-])([a-z]{20})(?![\w-])/g
const STRIPE_ACCT = /\bacct_[A-Za-z0-9]{16}\b/g
const URL = /https:\/\/[^\s"'`<>(){}\\]+/g
const IGNORED_HOSTS = /(^|\.)(supabase\.co|github\.com|localhost|example\.com|googleapis\.com)$/
const MAX_URLS = 5

interface Block {
  env: string
  file: string
  line: number
  text: string
}

function shellBlocks(file: string, text: string): Block[] {
  const lines = text.split('\n')
  const out: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    const label = CASE_LABEL.exec(lines[i])
    if (!label) continue
    const body: string[] = [lines[i].slice(label[0].length)]
    for (let j = i + 1; j < lines.length && !body[body.length - 1].includes(';;'); j++) {
      body.push(lines[j])
    }
    const envs = new Set(label[1].split('|').map((n) => ALIASES[n.trim()]))
    for (const env of envs) out.push({ env, file, line: i + 1, text: body.join('\n') })
  }
  return out
}

function wranglerBlocks(file: string, text: string): Block[] {
  const lines = text.split('\n')
  const out: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    const header = WRANGLER_ENV.exec(lines[i])
    if (!header) continue
    const body: string[] = []
    for (let j = i + 1; j < lines.length && !/^\s*\[(?!env\.)/.test(lines[j]); j++) {
      if (WRANGLER_ENV.test(lines[j]) && !lines[j].includes(`env.${header[1]}`)) break
      body.push(lines[j])
    }
    out.push({ env: ALIASES[header[1]], file, line: i + 1, text: body.join('\n') })
  }
  return out
}

function packageBlocks(file: string, text: string): Block[] {
  return [...text.matchAll(PKG_SCRIPT)].map((m) => ({
    env: ALIASES[m[1]],
    file,
    line: text.slice(0, m.index).split('\n').length,
    text: ''
  }))
}

function accountsIn(block: Block): EnvAccount[] {
  const at = `${block.file}:${block.line}`
  const out: EnvAccount[] = []
  for (const m of block.text.matchAll(SUPABASE_URL))
    out.push({ provider: 'supabase', id: m[1], foundIn: at })
  for (const line of block.text.split('\n')) {
    if (!SUPABASE_REF_LINE.test(line) || /key|secret|token|password/i.test(line)) continue
    for (const m of line.matchAll(SUPABASE_REF))
      out.push({ provider: 'supabase', id: m[1], foundIn: at })
  }
  for (const m of block.text.matchAll(STRIPE_ACCT))
    out.push({ provider: 'stripe', id: m[0], foundIn: at })
  return out
}

function urlsIn(block: Block): string[] {
  const out: string[] = []
  for (const m of block.text.matchAll(URL)) {
    try {
      const url = new globalThis.URL(m[0])
      if (!IGNORED_HOSTS.test(url.hostname) && !url.hostname.includes('$')) out.push(url.origin)
    } catch {
      continue
    }
  }
  return out
}

async function blocksOf(root: string, file: string): Promise<Block[]> {
  const name = basename(file)
  const dotenv = DOTENV_FILE.exec(name)
  const wanted =
    dotenv || SHELL_FILE.test(name) || WRANGLER_FILE.test(file) || name === 'package.json'
  if (!wanted || file.includes('node_modules/')) return []
  const text = await readFile(join(root, file), 'utf8').catch(() => null)
  if (text === null) return []
  if (dotenv) return [{ env: ALIASES[dotenv[1]], file, line: 1, text }]
  if (name === 'package.json') return packageBlocks(file, text)
  if (WRANGLER_FILE.test(file)) return wranglerBlocks(file, text)
  return shellBlocks(file, text)
}

export async function findEnvironments(root: string, files: string[]): Promise<InfraEnvironment[]> {
  const byName = new Map<string, InfraEnvironment>()
  for (const file of files) {
    for (const block of await blocksOf(root, file)) {
      const env = byName.get(block.env) ?? { name: block.env, foundIn: [], urls: [], accounts: [] }
      byName.set(block.env, env)
      env.foundIn.push(`${block.file}:${block.line}`)
      for (const url of urlsIn(block)) {
        if (env.urls.length < MAX_URLS && !env.urls.includes(url)) env.urls.push(url)
      }
      for (const account of accountsIn(block)) {
        const dupe = env.accounts.some(
          (a) => a.provider === account.provider && a.id === account.id
        )
        if (!dupe) env.accounts.push(account)
      }
    }
  }
  const rank = (name: string): number => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length)
  return [...byName.values()].sort((a, b) => rank(a.name) - rank(b.name))
}
