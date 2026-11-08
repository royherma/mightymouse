import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  ChevronRight,
  Eye,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  MessageCircleQuestion,
  PackageSearch,
  Pencil,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { AgentToolUse } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import { RailSection } from './agent-context-rail'
import { Button } from './Button'
import { SegmentedControl } from './SegmentedControl'
import { getFavicon } from './AppIcon'
import { shortWhen } from './session-facts'
import './tools-used.css'

const APP_SITES: ReadonlyArray<[RegExp, string, string?]> = [
  [/gmail/i, 'Gmail', 'mail.google.com'],
  [/calendar/i, 'Google Calendar', 'calendar.google.com'],
  [/drive/i, 'Google Drive', 'drive.google.com'],
  [/^gsc$|search.?console/i, 'Search Console', 'search.google.com'],
  [/gcloud/i, 'Google Cloud', 'cloud.google.com'],
  [/sentry/i, 'Sentry', 'sentry.io'],
  [/supabase/i, 'Supabase', 'supabase.com'],
  [/stripe/i, 'Stripe', 'stripe.com'],
  [/mercury/i, 'Mercury', 'mercury.com'],
  [/meta.?ads|facebook/i, 'Meta Ads', 'facebook.com'],
  [/cloudflare/i, 'Cloudflare', 'cloudflare.com'],
  [/amplitude/i, 'Amplitude', 'amplitude.com'],
  [/zoho/i, 'Zoho Mail', 'zoho.com'],
  [/postsyncer/i, 'PostSyncer', 'postsyncer.com'],
  [/xcode/i, 'Xcode', 'developer.apple.com'],
  [/github/i, 'GitHub', 'github.com'],
  [/slack/i, 'Slack', 'slack.com'],
  [/linear/i, 'Linear', 'linear.app'],
  [/notion/i, 'Notion', 'notion.so'],
  [/figma/i, 'Figma', 'figma.com'],
  [/claude.?docs/i, 'Claude Docs', 'claude.ai'],
  [/mightymouse/i, CONFIG.PRODUCT_NAME, CONFIG.WEB_URL],
  [/^cua/i, 'Computer use']
]
const BUILTINS: Record<string, [string, LucideIcon]> = {
  Bash: ['Runs commands', SquareTerminal],
  exec: ['Runs commands', SquareTerminal],
  shell: ['Runs commands', SquareTerminal],
  Read: ['Reads files', FileText],
  Edit: ['Edits files', Pencil],
  MultiEdit: ['Edits files', Pencil],
  NotebookEdit: ['Edits notebooks', Pencil],
  Write: ['Writes new files', FilePlus],
  Grep: ['Searches inside files', Search],
  Glob: ['Finds files by name', FolderSearch],
  WebFetch: ['Opens web pages', Globe],
  WebSearch: ['Searches the web', Globe],
  TaskCreate: ['Updates its checklist', ListTodo],
  TaskUpdate: ['Updates its checklist', ListTodo],
  TodoWrite: ['Updates its checklist', ListTodo],
  ToolSearch: ['Loads more tools', PackageSearch],
  AskUserQuestion: ['Asks you a question', MessageCircleQuestion],
  Monitor: ['Watches a running command', Eye]
}
const LIVE_MS = 90_000
const BUMP_MS = 900
type Order = 'recent' | 'most'

function siteUrl(site: string | undefined): string | undefined {
  return site && (site.startsWith('http') ? site : `https://${site}`)
}

function look(use: AgentToolUse): { label: string; what: string; icon: LucideIcon; site?: string } {
  if (use.kind === 'skill') return { label: use.name, what: 'Skill', icon: Sparkles }
  if (use.kind === 'helper') return { label: use.name, what: 'Helper agent', icon: Bot }
  if (use.kind === 'builtin') {
    const [what, icon] = BUILTINS[use.name] ?? ['Built-in tool', Wrench]
    return { label: use.name, what, icon }
  }
  const tools = Object.keys(use.tools).length
  const what = `Connected app${tools ? ` · ${tools} ${tools === 1 ? 'tool' : 'tools'}` : ''}`
  return { ...appLook(use.name), what, icon: Plug }
}

export function appLook(name: string): { label: string; site?: string } {
  const hit = APP_SITES.find(([re]) => re.test(name))
  if (hit) return { label: hit[1], site: siteUrl(hit[2]) }
  const words = name.replace(/^(claude_ai_|claude\.ai |plugin_)/, '').replace(/[_-]+/g, ' ').trim()
  return { label: words.charAt(0).toUpperCase() + words.slice(1) }
}

export function ToolIcon(props: { site?: string; icon: LucideIcon; kind: AgentToolUse['kind'] }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (!props.site) return
    let live = true
    void getFavicon(props.site).then((path) => {
      if (live && path) setSrc(window.api.mediaUrl(path))
    })
    return () => {
      live = false
    }
  }, [props.site])
  const Icon = props.icon
  return (
    <span className="tools-used-icon" data-kind={props.kind}>
      {src ? <img src={src} alt="" /> : <Icon size={14} strokeWidth={2} />}
    </span>
  )
}

function useBumped(calls: number): boolean {
  const last = useRef(calls)
  const [bumped, setBumped] = useState(false)
  useEffect(() => {
    if (calls <= last.current) return
    last.current = calls
    setBumped(true)
    const off = setTimeout(() => setBumped(false), BUMP_MS)
    return () => clearTimeout(off)
  }, [calls])
  return bumped
}

function UseRow(props: { use: AgentToolUse; now: number }): React.JSX.Element {
  const { use, now } = props
  const [open, setOpen] = useState(false)
  const bumped = useBumped(use.calls)
  const shown = look(use)
  const tools = Object.entries(use.tools).sort((a, b) => b[1] - a[1])
  const live = now - use.lastAt < LIVE_MS
  const more = tools.length > 0 || use.lastDetail !== ''
  return (
    <li className="tools-used-item" data-open={open || undefined}>
      <Button
        variant="bare"
        className="tools-used-row"
        aria-expanded={more ? open : undefined}
        disabled={!more}
        onClick={() => setOpen((v) => !v)}
      >
        <ToolIcon site={shown.site} icon={shown.icon} kind={use.kind} />
        <span className="tools-used-text">
          <span className="tools-used-name">{shown.label}</span>
          <span className="tools-used-meta">
            {shown.what} · {live ? <span className="tools-used-live">now</span> : shortWhen(use.lastAt, now)}
          </span>
        </span>
        <span className="tools-used-count" data-bumped={bumped || undefined} title={`${use.calls} calls`}>
          {use.calls}
        </span>
        {more && <ChevronRight className="tools-used-chevron" size={12} strokeWidth={2.5} />}
      </Button>
      {open && (
        <div className="tools-used-more">
          {use.lastDetail && (
            <p className="tools-used-last">
              <span>Last call</span>
              {use.lastDetail}
            </p>
          )}
          {tools.length > 0 && (
            <ul className="tools-used-tools">
              {tools.map(([tool, calls]) => (
                <li key={tool}>
                  <span className="tools-used-tool">{tool.replace(/_/g, ' ')}</span>
                  <span className="tools-used-tool-count">{calls}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

export function ToolsSection(props: {
  sessionRef: string
  refreshKey: string
  now: number
  open: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const [state, setState] = useState<{ ref: string; uses: AgentToolUse[] }>({ ref: props.sessionRef, uses: [] })
  const [order, setOrder] = useState<Order>('recent')
  useEffect(() => {
    let live = true
    void window.api.agentRelaySessionTools(props.sessionRef).then(
      (uses) => {
        if (live) setState({ ref: props.sessionRef, uses })
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [props.sessionRef, props.refreshKey])
  const uses = state.ref === props.sessionRef ? state.uses : []
  if (uses.length === 0) return null
  const total = uses.reduce((n, u) => n + u.calls, 0)
  const sorted = [...uses].sort((a, b) => (order === 'recent' ? b.lastAt - a.lastAt : b.calls - a.calls))
  return (
    <RailSection title="Tools used" icon={Wrench} open={props.open} onToggle={props.onToggle} badge={String(total)}>
      <SegmentedControl<Order>
        items={[
          { id: 'recent', label: 'Last used' },
          { id: 'most', label: 'Most calls' }
        ]}
        active={order}
        onChange={setOrder}
        textSize="text-xs"
        className="tools-used-order"
      />
      <ul className="tools-used-list">
        {sorted.map((use) => (
          <UseRow key={`${use.kind}:${use.name}`} use={use} now={props.now} />
        ))}
      </ul>
    </RailSection>
  )
}
