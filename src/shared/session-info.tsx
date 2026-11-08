import { useState, type JSX, type ReactNode } from 'react'
import { Check, Circle, CircleDot, Loader2 } from 'lucide-react'
import type { PhoneRemoteEvent } from './phone-remote-protocol'
import { relativeAge, type SessionRow } from './relay-status'
import type { AgentRelaySessionInfo } from './types'

export type SessionInfoData = Omit<Extract<PhoneRemoteEvent, { type: 'relayInfo' }>, 'type'>

const APP_DOMAINS: [string, string][] = [
  ['gmail', 'mail.google.com'],
  ['calendar', 'calendar.google.com'],
  ['drive', 'drive.google.com'],
  ['gcloud', 'cloud.google.com'],
  ['gsc', 'search.google.com'],
  ['xcode', 'developer.apple.com'],
  ['meta', 'meta.com'],
  ['claude', 'claude.ai'],
  ['mightymouse', 'getmightymouse.com'],
  ['amplitude', 'amplitude.com'],
  ['mercury', 'mercury.com'],
  ['postsyncer', 'postsyncer.com'],
  ['runway', 'runwayml.com'],
  ['sentry', 'sentry.io'],
  ['stripe', 'stripe.com'],
  ['supabase', 'supabase.com'],
  ['upwork', 'upwork.com'],
  ['zoho', 'zoho.com'],
  ['github', 'github.com'],
  ['cloudflare', 'cloudflare.com'],
  ['vercel', 'vercel.com'],
  ['linear', 'linear.app'],
  ['notion', 'notion.so'],
  ['slack', 'slack.com'],
  ['figma', 'figma.com'],
  ['playwright', 'playwright.dev'],
  ['posthog', 'posthog.com'],
  ['atlassian', 'atlassian.com'],
  ['jira', 'atlassian.com'],
  ['asana', 'asana.com'],
  ['hubspot', 'hubspot.com'],
  ['intercom', 'intercom.com'],
  ['shopify', 'shopify.com'],
  ['twilio', 'twilio.com'],
  ['resend', 'resend.com'],
  ['openai', 'openai.com'],
  ['google', 'google.com']
]

const CARD = 'flex flex-col rounded-[14px] border border-surface3 bg-surface1 px-3.5 py-1'
const TOOL_WORDS: Record<string, string> = { Read: 'Read files', Bash: 'Ran commands', Edit: 'Edited files' }

const TITLE =
  'flex items-baseline justify-between gap-2 pb-1 pt-2.5 text-[13px] font-bold uppercase tracking-[0.02em] text-muted'

function appName(name: string): string {
  return (
    name
      .replace(/^claude_ai_/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\bmcp\b/i, '')
      .trim()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase()) || name
  )
}

function AppLogo({ name }: { name: string }): JSX.Element {
  const key = name.toLowerCase()
  const domain = APP_DOMAINS.find(([k]) => key.includes(k))?.[1]
  const [broken, setBroken] = useState(false)
  return domain && !broken ? (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      className="box-border h-5 w-5 flex-none rounded-full bg-white object-contain p-0.5"
      onError={() => setBroken(true)}
    />
  ) : (
    <i className="box-border inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-white text-[11px] not-italic text-muted">
      {appName(name).charAt(0).toUpperCase()}
    </i>
  )
}

function AppChip({ name }: { name: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface2 py-1 pl-1 pr-2.5 text-[13.5px] font-semibold">
      <AppLogo name={name} />
      {appName(name)}
    </span>
  )
}

export function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }): JSX.Element | null {
  if (children === undefined || children === null || children === '') return null
  return (
    <div className="flex justify-between gap-3 border-b border-surface3 py-[9px] text-[15px] last:border-b-0">
      <span className="flex-none text-muted">{label}</span>
      <b className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{children}</b>
    </div>
  )
}

export function InfoCard({ children }: { children: ReactNode }): JSX.Element {
  return <div className={CARD}>{children}</div>
}

export function SessionInfoBody({
  session,
  row,
  info,
  mark,
  title,
  state,
  actions,
  note,
  now
}: {
  session: AgentRelaySessionInfo
  row: SessionRow
  info: SessionInfoData | undefined
  mark: ReactNode
  title: string
  state: ReactNode
  actions: ReactNode
  note?: ReactNode
  now: number
}): JSX.Element {
  const checklist = info?.checklist
  const tools = [...(info?.tools ?? [])].sort((a, b) => b.calls - a.calls).slice(0, 6)
  const agentLine = [row.agent, row.model, row.effort].filter(Boolean).join(' · ')
  const projectLine = [session.project?.name ?? row.repo, row.branch].filter(Boolean).join(' · ')
  return (
    <>
      <div className="flex flex-col items-center gap-1 px-9 pb-3 pt-1 text-center">
        {mark}
        <h3 className="line-clamp-2 max-w-full overflow-hidden">{title}</h3>
        <span className="inline-flex items-center gap-1.5 text-[14px] text-muted">{state}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain">
        {row.tldr && (
          <div className="rounded-[14px] bg-surface2 px-3 py-2.5 text-[14.5px] leading-snug text-muted">
            <small className="mr-[7px] text-[13px] font-semibold">Recap</small>
            {row.tldr}
          </div>
        )}
        <InfoCard>
          <InfoRow label="Project">{projectLine}</InfoRow>
          <InfoRow label="Agent">{agentLine}</InfoRow>
          <InfoRow label="Running on">{session.whereLabel ?? session.hostAppName}</InfoRow>
          <InfoRow label="Started">{row.started}</InfoRow>
          <InfoRow label="Last reply">{row.lastReply}</InfoRow>
        </InfoCard>
        {checklist && checklist.items.length > 0 && (
          <InfoCard>
            <div className={TITLE}>
              {checklist.goal ?? 'Plan'}
              <small className="font-medium normal-case tracking-normal">
                {checklist.done} of {checklist.items.length} done
              </small>
            </div>
            {checklist.items.map((item, index) => (
              <div
                key={`${index}:${item.label}`}
                className={`flex items-start gap-2 py-1.5 text-[14px] leading-[1.35] ${item.status === 'completed' ? 'text-muted' : ''}`}
              >
                <span
                  className={`mt-0.5 flex-none ${item.status === 'completed' ? 'text-green' : item.status === 'in_progress' ? 'text-accent' : 'text-muted'}`}
                >
                  {item.status === 'completed' ? <Check size={14} /> : item.status === 'in_progress' ? <CircleDot size={14} /> : <Circle size={14} />}
                </span>
                <span>{item.waiting ? `Needs you: ${item.label}` : item.label}</span>
              </div>
            ))}
          </InfoCard>
        )}
        {tools.length > 0 && (
          <InfoCard>
            <div className={TITLE}>What it's been using</div>
            {tools.map((tool) => (
              <InfoRow
                key={`${tool.kind}:${tool.name}`}
                label={
                  tool.kind === 'app' ? (
                    <span className="inline-flex items-center gap-2">
                      <AppLogo name={tool.name} />
                      {appName(tool.name)}
                    </span>
                  ) : (
                    (TOOL_WORDS[tool.name] ?? tool.name)
                  )
                }
              >
                {tool.calls === 1 ? 'once' : `${tool.calls} times`}
              </InfoRow>
            ))}
          </InfoCard>
        )}
        {info && info.mcpList.length > 0 && (
          <InfoCard>
            <div className={TITLE}>Connected apps</div>
            <div className="flex flex-wrap gap-1.5 pb-3 pt-1">
              {info.mcpList.map((m) => (
                <AppChip key={`${m.scope}:${m.name}`} name={m.name} />
              ))}
            </div>
          </InfoCard>
        )}
        {info && info.helpers.length > 0 && (
          <InfoCard>
            <div className={TITLE}>Also working on</div>
            {info.helpers.map((h, i) => (
              <div key={`${i}:${h.task}`} className="flex flex-col gap-0.5 border-b border-surface3 py-[9px] text-[15px] last:border-b-0">
                <b className="font-medium">{h.task}</b>
                <span className="text-[13px] text-muted">{`${h.doing} · ${relativeAge(now - h.since).replace(' ago', '')}`}</span>
              </div>
            ))}
          </InfoCard>
        )}
        {!info && (
          <p className="my-1 flex items-center justify-center gap-1.5 text-[14px] text-muted">
            <Loader2 size={13} className="animate-spin" /> Asking your Mac for details…
          </p>
        )}
      </div>
      {actions}
      {note}
    </>
  )
}
