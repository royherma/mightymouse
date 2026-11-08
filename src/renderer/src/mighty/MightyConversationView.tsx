import { JSX, memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  FolderOpen,
  Plus,
  FileText,
  FileCode,
  PanelLeft,
  Check,
  Copy,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  PanelRight,
  Sparkles,
  Image as ImageIcon,
  Music,
  File as FileIcon,
  FileInput,
  Pencil,
  RotateCcw
} from 'lucide-react'
import { Button } from '../components/Button'
import { Row } from '../components/Layout'
import { Markdown } from '../components/Markdown'
import { GlowDot } from '../components/GlowDot'
import type { HighlightToken } from './speech-highlight'
import { CONFIG } from '../../../shared/config'
import { runLabel } from '../backend-chip'
import { planName } from '../../../shared/model-label'
import { RUN_EVENT } from '../../../shared/types'
import { toolInputPreview, type TimelineItem } from '../lib/run-events'
import type { MightyTurn, ToolCallSummary, TurnUsage } from '../../../shared/types'

import { fileName, isHtml, timeAgo, formatDuration, fullTime } from './mighty-shared'
// memo: the elapsed-time tick re-renders the pane every 100ms while a run is in
// flight, and read-aloud re-renders it per animation frame. Only the LAST turn's
// props change, so every finished turn above it must compare equal and skip —
// without this, a long chat re-parses its whole markdown transcript 10x a second.
export const Message = memo(function Message({
  name,
  q,
  a,
  ts,
  artifacts,
  pending,
  phase,
  liveTimeline,
  elapsedMs,
  renderMarkup,
  detail,
  backend,
  model,
  durationMs,
  firstPhaseMs,
  toolCalls,
  usage,
  highlight,
  showSteps = true,
  onEdit,
  onRegenerate
}: {
  name: string
  q: string
  a: string
  ts: string
  artifacts?: string[]
  pending: boolean
  /** Live activity headline for the pending bubble ("Reading…"); '' → generic. */
  phase?: string
  /** Live tool-call/thinking/text steps for the in-flight run, rendered inline in the
   *  order they actually happened — same shape the Run Transcript Inspector overlay
   *  renders. Text chunks render as part of this same ordered list (see InlineSteps),
   *  not as a separate trailing block. */
  liveTimeline?: TimelineItem[]
  /** Live "how long has it been" for the pending bubble, ticking once a second while
   *  this turn is in flight (0 once settled — the bubble swaps to the final `took Xs`
   *  line instead, gated on `detail`). */
  elapsedMs?: number
  /** Render Mighty's reply as formatted Markdown vs raw source text. */
  renderMarkup: boolean
  /** Detail mode on: surface this run's final timing under the reply. */
  detail: boolean
  /** Backend that served this turn, shown in the detail line. */
  backend?: string
  /** Model that actually ran this turn. Absent on older turns → backend label only. */
  model?: string
  /** Total run time. Absent on turns recorded before timing existed → line is hidden. */
  durationMs?: number
  /** Time to the backend's first sign of life. Absent → that stat is dropped. */
  firstPhaseMs?: number
  /** Ordered tool-call trail this turn made, persisted so reopening a finished
   *  conversation still shows what Mighty did (see ToolCallSummary). Absent on turns
   *  with no tool calls or recorded before this field existed. */
  toolCalls?: ToolCallSummary[]
  usage?: TurnUsage
  /** Set only on the turn currently being read aloud, and only when the voice
   *  supplied word timings (Kokoro). Absent → the reply renders as usual. */
  highlight?: { tokens: HighlightToken[]; index: number }
  showSteps?: boolean
  /** Set only on the last turn once it's settled — live/pending can't be edited. */
  onEdit?: (newText: string) => void
  onRegenerate?: () => void
}): JSX.Element {
  return (
    <div className="space-y-2">
      <Bubble text={q} ts={ts} side="user" onEdit={onEdit} />
      {(a !== '' || pending) && (
        <div className="flex justify-start">
          <div className="min-w-0 flex-1">
            {a !== '' ? (
              <>
                {showSteps && toolCalls && toolCalls.length > 0 && (
                  <div className="mb-1.5">
                    <ToolCallTrail items={toolCalls} />
                  </div>
                )}
                <Bubble
                  text={a}
                  ts={ts}
                  side="mighty"
                  artifacts={artifacts}
                  renderMarkup={renderMarkup}
                  highlight={highlight}
                  onRegenerate={onRegenerate}
                />
                {/* Old turns carry no timing at all — showing "took 0s" would be a
                    lie, so the whole line stays hidden unless we really measured it. */}
                {detail && (durationMs !== undefined || usage) && (
                  <RunStats
                    durationMs={durationMs}
                    firstPhaseMs={firstPhaseMs}
                    backend={backend}
                    model={model}
                    usage={usage}
                  />
                )}
              </>
            ) : (
              <div className="flex flex-col gap-1.5">
                {/* Ordered trail of everything that's happened so far — tool calls,
                    thinking, and streamed text chunks all rendered in the sequence
                    they actually occurred, instead of every tool call bunched above
                    the text. */}
                {liveTimeline && liveTimeline.length > 0 && (
                  <InlineSteps
                    items={showSteps ? liveTimeline : liveTimeline.filter((it) => it.kind === RUN_EVENT.text)}
                    renderMarkup={renderMarkup}
                  />
                )}
                {/* Always-visible "still working" heartbeat while pending, whether or
                    not any steps/text have streamed in yet — a finished tool row or a
                    text chunk landing is not the same as the run being done, so this
                    pulse must never disappear once something has appeared. */}
                <div className="inline-flex w-fit items-center gap-1 rounded-full bg-surface2 text-on-surface px-4 py-2 text-md">
                  <span className="inline-flex gap-1 text-muted">
                    {phase && phase.trim() !== '' ? phase : `${name} is working`}
                    <span className="animate-pulse">…</span>
                  </span>
                </div>
                {/* Elapsed run time, BELOW the bubble — same slot the settled "took
                    Xs" line uses once the reply lands, never packed inside the pill
                    itself. tabular-nums pins digit width so the 1×/second tick
                    doesn't jitter. */}
                {!!elapsedMs && (
                  <div className="mt-1 px-1 text-micro text-muted tabular-nums">
                    {formatDuration(elapsedMs)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

function RunStats({
  durationMs,
  firstPhaseMs,
  backend,
  model,
  usage
}: {
  durationMs?: number
  firstPhaseMs?: number
  backend?: string
  model?: string
  usage?: TurnUsage
}): JSX.Element {
  const ms = usage?.genMs ?? durationMs
  const seconds = ms !== undefined ? ms / 1000 : 0
  const tokPerSec = usage && seconds > 0 ? usage.outputTokens / seconds : 0
  const parts: { text: string; title?: string }[] = []
  if (durationMs !== undefined) parts.push({ text: `took ${formatDuration(durationMs)}` })
  if (firstPhaseMs !== undefined)
    parts.push({ text: `first move ${formatDuration(firstPhaseMs)}`, title: 'Time until Mighty started working on it' })
  if (backend) parts.push({ text: runLabel(backend, model) })
  if (usage) {
    parts.push({ text: `${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens` })
    if (usage.free) parts.push({ text: 'free' })
    else if (usage.costUsd !== undefined && backend && planName(backend))
      parts.push({ text: planName(backend)!, title: `$${usage.costUsd.toFixed(4)} at API prices - your plan covers it` })
    else if (usage.costUsd !== undefined) parts.push({ text: `$${usage.costUsd.toFixed(4)}` })
    if (tokPerSec > 0) parts.push({ text: `${tokPerSec.toFixed(1)} tok/s` })
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-micro leading-snug text-muted tabular-nums">
      {parts.map((p, i) => (
        <span key={p.text} title={p.title} className="inline-flex items-center gap-x-1.5">
          {i > 0 && <span className="opacity-40">·</span>}
          {p.text}
        </span>
      ))}
    </div>
  )
}

// Compact inline rendering of the in-flight run's tool calls, thinking, AND streamed
// text, in the order they happened — the ChatGPT-style "reading file X / here's what
// I found / running Y" trail, shown where each step occurs instead of every tool call
// bunched above the text. Reuses lib/run-events' fold + formatting helpers (same as
// the Run Transcript Inspector overlay) so the two surfaces never fork their own
// copies of this logic.
export function InlineSteps({
  items,
  renderMarkup
}: {
  items: TimelineItem[]
  renderMarkup: boolean
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((it) => {
        if (it.kind === RUN_EVENT.thinking) {
          return (
            <div key={it.key} className="flex items-start gap-1.5 text-xs text-muted italic px-1">
              <Sparkles size={12} className="mt-0.5 shrink-0" />
              <span className="line-clamp-2">{it.text}</span>
            </div>
          )
        }
        if (it.kind === RUN_EVENT.text) {
          if (it.text.trim() === '') return null
          return (
            <div
              key={it.key}
              className="rounded-lg rounded-bl-sm bg-surface1 text-on-surface px-4 py-2.5 text-mlg leading-relaxed shadow-bubble"
            >
              {renderMarkup ? <Markdown>{it.text}</Markdown> : it.text}
            </div>
          )
        }
        const row = it.row
        return (
          <div
            key={row.key}
            className="flex items-center gap-1.5 text-xs text-muted px-2 py-1 rounded-lg bg-surface1/60 w-fit max-w-full"
          >
            {row.done ? (
              <Check size={12} className={row.isError ? 'text-red-400' : 'shrink-0'} />
            ) : (
              <GlowDot color="var(--accent)" size="w-1.5 h-1.5" />
            )}
            <span className="font-medium text-on-surface shrink-0">{row.name}</span>
            <span className="truncate font-mono">{toolInputPreview(row.input)}</span>
          </div>
        )
      })}
    </div>
  )
}

// The settled-turn counterpart to InlineSteps: a compact, ordered trail of the tool
// calls a finished run made, persisted on the turn itself (ToolCallSummary — no raw
// output) so reopening a conversation still shows what Mighty did, not just its
// final answer.
export function ToolCallTrail({ items }: { items: ToolCallSummary[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {items.map((row, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 text-xs text-muted px-2 py-1 rounded-lg bg-surface1/60 w-fit max-w-full"
        >
          <Check size={12} className={row.ok ? 'shrink-0' : 'text-red-400'} />
          <span className="font-medium text-on-surface shrink-0">{row.name}</span>
          <span className="truncate font-mono">{row.inputPreview}</span>
        </div>
      ))}
    </div>
  )
}

/** The reply as plain tokens with the spoken one lit. Only mounted while a voice
 *  is actually reading this bubble — see Bubble's `highlight` prop. */
export function SpokenText({
  tokens,
  index
}: {
  tokens: HighlightToken[]
  index: number
}): JSX.Element {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} className={i === index ? 'spokenWordActive' : undefined}>
          {t.text}
        </span>
      ))}
    </>
  )
}

export function Bubble({
  text,
  ts,
  side,
  artifacts,
  renderMarkup,
  highlight,
  onEdit,
  onRegenerate
}: {
  text: string
  ts: string
  side: 'user' | 'mighty'
  artifacts?: string[]
  /** Render as formatted Markdown vs raw source text. Only applies to Mighty's own replies. */
  renderMarkup?: boolean
  /** Read-aloud in progress on THIS bubble. Markdown is bypassed while it plays —
   *  per-word spans can't be injected into rendered markup without breaking code
   *  blocks and links — so the text goes plain, then snaps back when the voice stops. */
  highlight?: { tokens: HighlightToken[]; index: number }
  /** Set only on the last user turn — edit-and-resend replaces the tail of turns[]. */
  onEdit?: (newText: string) => void
  /** Set only on the last Mighty reply — regenerate replaces the tail of turns[]. */
  onRegenerate?: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [text])

  const user = side === 'user'

  if (editing) {
    return (
      <div className={`flex ${user ? 'justify-end' : 'justify-start'}`}>
        <div className="flex flex-col items-end max-w-[80%] w-full gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            className="w-full resize-none rounded-lg bg-surface2 border border-surface3 px-4 py-3 text-mlg leading-relaxed outline-none focus:border-blue focus:shadow-focus"
            autoFocus
          />
          <Row gap={1}>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {CONFIG.UI_LABELS.CHAT_EDIT_CANCEL}
            </Button>
            <Button
              variant="primary"
              disabled={draft.trim() === ''}
              onClick={() => {
                setEditing(false)
                onEdit?.(draft.trim())
              }}
            >
              {CONFIG.UI_LABELS.CHAT_EDIT_SAVE}
            </Button>
          </Row>
        </div>
      </div>
    )
  }

  return (
    <div className={`group flex ${user ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex flex-col ${user ? 'items-end max-w-[80%]' : 'items-stretch w-full'}`}>
        <div
          className={
            user
              ? 'rounded-lg rounded-br-sm bg-surface3 text-on-surface px-4 py-2.5 text-mlg leading-relaxed whitespace-pre-wrap'
              : `rounded-lg rounded-bl-sm bg-surface1 text-on-surface px-4 py-2.5 text-mlg leading-relaxed shadow-bubble ${
                  !user && renderMarkup && !highlight ? '' : 'whitespace-pre-wrap'
                }`
          }
        >
          {highlight ? (
            <SpokenText tokens={highlight.tokens} index={highlight.index} />
          ) : !user && renderMarkup ? (
            <Markdown>{text}</Markdown>
          ) : (
            text
          )}
          {artifacts && artifacts.length > 0 && (
            <Row gap={1.5} className="mt-2 flex-wrap">
              {artifacts.map((p) => (
                <ArtifactChip key={p} path={p} />
              ))}
            </Row>
          )}
        </div>
        <div
          className={`mt-1 flex h-7 items-center gap-0.5 px-0.5 text-micro text-muted ${user ? 'flex-row-reverse' : ''}`}
        >
          <span title={fullTime(ts)} className="px-1 opacity-70">
            {timeAgo(ts)}
          </span>
          <BubbleAction label={copied ? 'Copied' : 'Copy'} onClick={copy} pinned={copied}>
            {copied ? <Check size={14} className="text-green" /> : <Copy size={14} />}
          </BubbleAction>
          {onEdit && (
            <BubbleAction
              label={CONFIG.UI_LABELS.CHAT_EDIT}
              onClick={() => {
                setDraft(text)
                setEditing(true)
              }}
            >
              <Pencil size={14} />
            </BubbleAction>
          )}
          {onRegenerate && (
            <BubbleAction label={CONFIG.UI_LABELS.CHAT_REGENERATE} onClick={onRegenerate}>
              <RotateCcw size={14} />
            </BubbleAction>
          )}
        </div>
      </div>
    </div>
  )
}

function BubbleAction({
  label,
  onClick,
  pinned,
  children
}: {
  label: string
  onClick: () => void
  pinned?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <Button
      variant="bare"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid h-7 w-7 place-items-center rounded-sm text-muted transition-[opacity,background-color,color] duration-150 hover:bg-surface3 hover:text-on-surface focus-visible:opacity-100 active:scale-95 group-hover:opacity-100 ${
        pinned ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {children}
    </Button>
  )
}

// A clickable artifact pill. HTML opens in the in-app viewer; everything else
// reveals in Finder. An "open in app" icon hints HTML is viewable inline.
export function ArtifactChip({ path }: { path: string }): JSX.Element {
  const html = isHtml(path)
  return (
    <Button
      variant="ghost"
      onClick={() => void window.api.mighty.openArtifact(path)}
      className="inline-flex items-center gap-1"
      title={html ? 'Open in app' : 'Reveal in Finder'}
    >
      {html ? <FileCode size={12} /> : <FileText size={12} />}
      {fileName(path)}
      {html && <ExternalLink size={11} className="opacity-60" />}
    </Button>
  )
}

// A grouped, joined pane-visibility control (the pattern in Notion / Linear / most
// three-pane apps): one pill, two segments, each an independent toggle for its rail.
// Active segment reads filled; inactive stays quiet. Sits top-right of the chat header.
export function PaneToggleGroup({
  leftOn,
  rightOn,
  onToggleLeft,
  onToggleRight,
  leftLabel = 'chats (⌘\\)',
  rightLabel = 'outputs & sources'
}: {
  leftOn: boolean
  rightOn: boolean
  onToggleLeft: () => void
  onToggleRight: () => void
  leftLabel?: string
  rightLabel?: string
}): JSX.Element {
  const seg = (on: boolean): string =>
    `grid place-items-center px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
      on ? 'bg-accent-wash text-accent-text' : 'text-muted hover:text-on-surface hover:bg-surface2/60'
    }`
  return (
    <div className="flex items-center rounded-lg border border-surface3 overflow-hidden divide-x divide-surface3">
      <Button variant="bare"
        onClick={onToggleLeft}
        aria-pressed={leftOn}
        className={seg(leftOn)}
        title={`${leftOn ? 'Hide' : 'Show'} ${leftLabel}`}
      >
        <PanelLeft size={15} />
      </Button>
      <Button variant="bare"
        onClick={onToggleRight}
        aria-pressed={rightOn}
        className={seg(rightOn)}
        title={`${rightOn ? 'Hide' : 'Show'} ${rightLabel} (⌘⌥B)`}
      >
        <PanelRight size={15} />
      </Button>
    </div>
  )
}

// ── Context rail (Outputs / Sources) ─────────────────────────────────────────────

// Pick a glyph for a source file from its extension. Sources are the user's own
// attachments (images, audio, docs), so kind-at-a-glance beats a generic file icon.
function sourceIcon(path: string): typeof FileIcon {
  const p = path.toLowerCase()
  if (/\.(png|jpe?g|gif|webp|heic|bmp|svg|tiff?)$/.test(p)) return ImageIcon
  if (/\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/.test(p)) return Music
  if (/\.(md|markdown|txt|rtf|pdf|docx?)$/.test(p)) return FileText
  if (/\.(html?|css|jsx?|tsx?|json|ya?ml|py|rb|sh|go|rs)$/.test(p)) return FileCode
  return FileIcon
}

// One row in either section: an icon, the filename, and a hover-revealed open hint.
// The whole row is the click target — outputs open (HTML in-app, else Finder),
// sources reveal in Finder. A hairline accent edge fades in on hover so the list
// feels alive without a busy always-on treatment.
function RailRow({
  path,
  icon: Icon,
  accent,
  onClick,
  hint
}: {
  path: string
  icon: typeof FileIcon
  accent: boolean
  onClick: () => void
  hint: string
}): JSX.Element {
  return (
    <Button variant="bare"
      onClick={onClick}
      title={`${fileName(path)} - ${hint}`}
      className="group/row relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface2 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-accent before:opacity-0 before:transition-opacity hover:before:opacity-100"
    >
      <Icon
        size={14}
        strokeWidth={1.75}
        className={`shrink-0 ${accent ? 'text-accent-text' : 'text-muted'}`}
      />
      <span className="flex-1 truncate text-sm text-on-surface">{fileName(path)}</span>
      <ExternalLink
        size={12}
        className="shrink-0 text-muted opacity-0 transition-opacity group-hover/row:opacity-70"
      />
    </Button>
  )
}

// A titled, count-badged, collapsible group of rows with a quiet empty state.
// The whole header is the expand/collapse target (a chevron alone is too small a
// hit area for a rail this narrow). Sections stay visible even when empty — the
// empty copy is an invitation, and a disappearing section would make the rail feel
// like it's flickering between conversations. `action` renders a trailing control
// (e.g. Sources' + button) that must not toggle the section, so it stops propagation.
function RailSection({
  icon: Icon,
  title,
  count,
  empty,
  open,
  onToggle,
  action,
  children
}: {
  icon: typeof FileIcon
  title: string
  count: number
  empty: string
  open: boolean
  onToggle: () => void
  action?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <Row gap={1.5} className="group/sec px-2">
        <Button variant="bare"
          onClick={onToggle}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 py-1 text-left"
          title={`${open ? 'Collapse' : 'Expand'} ${title.toLowerCase()}`}
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-muted" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-muted" />
          )}
          <Icon size={13} strokeWidth={2} className="shrink-0 text-muted" />
          <span className="text-xs font-bold uppercase tracking-wide text-muted">{title}</span>
          {count > 0 && (
            <span className="ml-1 rounded-full bg-surface2 px-1.5 text-xs font-semibold text-muted">
              {count}
            </span>
          )}
        </Button>
        {action}
      </Row>
      {open &&
        (count === 0 ? (
          <p className="px-2 py-1 text-xs leading-relaxed text-muted">{empty}</p>
        ) : (
          <div className="flex flex-col">{children}</div>
        ))}
    </div>
  )
}

// The right rail. Derives per-conversation Outputs (files Mighty wrote) and Sources
// (files the user attached, newest first, de-duped) from the session's turns — no
// new store, no fetch. Mirrors the Codex-style context panel: what came out, what
// went in, both one click from opening.
export function ContextRail({
  name,
  turns,
  pendingSources = [],
  onAddSource,
  head,
  details
}: {
  head?: React.ReactNode
  details?: React.ReactNode
  name: string
  turns: MightyTurn[]
  pendingSources?: string[]
  /** Opens the native picker and stages the files in the composer (same as the
   *  paperclip) — attaching and asking stay one action. Absent in multi-pane mode:
   *  each ConversationPane owns its own attach button/composer now, and the rail
   *  has no single pane to stage a picked file into, so the action is hidden
   *  rather than left wired to nothing. */
  onAddSource?: () => void
}): JSX.Element {
  // Newest-first, de-duped. A file re-used across turns shows once, at its latest use.
  const dedupeLatest = (paths: string[]): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of paths) {
      if (seen.has(p)) continue
      seen.add(p)
      out.push(p)
    }
    return out
  }
  const outputs = dedupeLatest(
    turns
      .slice()
      .reverse()
      .flatMap((t) => t.artifacts ?? [])
  )
  const sources = dedupeLatest([
    ...pendingSources,
    ...turns
      .slice()
      .reverse()
      .flatMap((t) => t.sources ?? [])
  ])

  // A long-running chat can hold dozens of artifacts (a daily report job hits 30+
  // fast). Auto-collapse a long Outputs list on open so the rail never lands as a
  // wall of filenames that buries Sources — an explicit toggle always wins after.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, count: number): boolean =>
    openSections[key] ?? count <= CONFIG.MIGHTY.RAIL_AUTO_COLLAPSE_OVER
  const toggle = (key: string, count: number): void =>
    setOpenSections((prev) => ({ ...prev, [key]: !isOpen(key, count) }))

  return (
    <aside className="flex h-full min-w-0 flex-1 shrink-0 flex-col border-l border-surface3 bg-surface1">
      {head && (
        <div className="px-3 pt-3">{head}</div>
      )}
      <div className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        <RailSection
          icon={FolderOpen}
          title="Outputs"
          count={outputs.length}
          empty={`Nothing made yet. Ask ${name} to build something.`}
          open={isOpen('outputs', outputs.length)}
          onToggle={() => toggle('outputs', outputs.length)}
        >
          {outputs.map((p) => (
            <RailRow
              key={p}
              path={p}
              icon={isHtml(p) ? FileCode : FileText}
              accent={isHtml(p)}
              hint={isHtml(p) ? 'Open in app' : 'Reveal in Finder'}
              onClick={() => void window.api.mighty.openArtifact(p)}
            />
          ))}
        </RailSection>
        <RailSection
          icon={FileInput}
          title="Sources"
          count={sources.length}
          empty="Files you attach show up here."
          open={isOpen('sources', sources.length)}
          onToggle={() => toggle('sources', sources.length)}
          action={
            onAddSource && (
              <Button
                variant="icon"
                onClick={onAddSource}
                title="Attach files or folders"
                aria-label="Attach files or folders"
                className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/sec:opacity-100"
              >
                <Plus size={14} />
              </Button>
            )
          }
        >
          {sources.map((p) => (
            <RailRow
              key={p}
              path={p}
              icon={sourceIcon(p)}
              accent={false}
              hint="Reveal in Finder"
              onClick={() => void window.api.mighty.revealSource(p)}
            />
          ))}
        </RailSection>
        {details}
      </div>
    </aside>
  )
}

// ── Jobs tab ───────────────────────────────────────────────────────────────────

// A textarea that grows to fit its content up to a cap, then scrolls. Keeps long
// job prompts fully visible without a fixed tiny box or a page-length card. The
// cap (maxRows) stops one giant prompt from pushing the schedule controls off-screen.
export function AutoGrowTextarea({
  value,
  onChange,
  className,
  minRows = 2,
  maxRows = 10
}: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  className?: string
  minRows?: number
  maxRows?: number
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback((): void => {
    const el = ref.current
    if (!el) return
    // Measure natural content height, clamp between min and max rows.
    el.style.height = 'auto'
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20
    const pad = el.offsetHeight - el.clientHeight // borders + vertical padding
    const min = line * minRows + pad
    const max = line * maxRows + pad
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`
  }, [minRows, maxRows])

  useEffect(() => {
    resize()
  }, [value, resize])

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => {
        onChange(e)
        resize()
      }}
      rows={minRows}
      className={className}
    />
  )
}
