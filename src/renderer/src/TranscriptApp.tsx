import React, { useEffect, useRef, useState } from 'react'
import { X, Wrench, Brain, MessageSquareText, Gauge, ChevronRight, CircleAlert } from 'lucide-react'
import { useIpcSubscriptions } from './hooks/useIpcSubscriptions'
import { RUN_EVENT } from '../../shared/types'
import type { RunEvent, RunUsageEvent } from '../../shared/types'
import { foldRunEvent, stringifyToolValue, toolInputPreview, type TimelineItem } from './lib/run-events'
import { Button } from './components/Button'

const PLAIN_TOOL_NAMES: Record<string, string> = {
  bash: 'Ran a command',
  read: 'Read a file',
  write: 'Wrote a file',
  edit: 'Changed a file',
  multiedit: 'Changed a file',
  notebookedit: 'Changed a notebook',
  glob: 'Looked for files',
  grep: 'Searched the files',
  ls: 'Listed a folder',
  webfetch: 'Opened a web page',
  websearch: 'Searched the web',
  task: 'Handed work to a helper',
  agent: 'Handed work to a helper',
  todowrite: 'Updated its to-do list',
  exitplanmode: 'Finished planning'
}

function plainToolName(raw: string): string {
  return PLAIN_TOOL_NAMES[raw.toLowerCase()] ?? (raw.startsWith('mcp__') ? 'Used a connected app' : 'Used a tool')
}

// ── TranscriptApp ─────────────────────────────────────────────────────────────
// The Run Transcript Inspector — a full-screen overlay (?window=transcript, built
// by transcript-window.ts) showing the LIVE, ordered timeline of one agentic run:
// every tool call with its full input + output, the model's thinking, assistant
// text, and a final token-usage/cost footer. Lives in its own window (not the
// 320px HUD) so it centers on the display and never clips (fixed-can't-escape).
//
// Events arrive over CHANNELS.transcriptEvent (main replays the run's buffered
// history on open, then streams live). Tool starts and ends are paired by id into
// one collapsible row (via lib/run-events, shared with Mighty chat's inline steps).
// The window IS the modal: ✕ / Esc / backdrop closes it, telling main to tear the
// window down.

export default function TranscriptApp(): React.ReactElement {
  const [items, setItems] = useState<TimelineItem[]>([])
  const [usage, setUsage] = useState<RunUsageEvent | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const seq = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Track whether the user is pinned to the bottom so live events auto-scroll,
  // but a manual scroll-up (to read an earlier step) is never yanked back down.
  const pinnedBottom = useRef(true)

  const close = (): void => window.api.transcriptClose()

  // Esc closes the inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useIpcSubscriptions(() => [
    window.api.onTranscriptEvent(({ event }) => applyEvent(event))
  ])

  function applyEvent(event: RunEvent): void {
    if (event.kind === RUN_EVENT.usage) {
      setUsage(event)
      return
    }
    setItems((prev) => foldRunEvent(prev, event, () => seq.current++))
  }

  // Auto-scroll to bottom on new items when the user is pinned there.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedBottom.current) el.scrollTop = el.scrollHeight
  }, [items, usage])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <div className="tx-backdrop" onMouseDown={close}>
      <style>{TX_CSS}</style>
      <div className="tx-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tx-head">
          <div className="tx-title">What it did</div>
          <Button variant="bare" className="tx-close" onClick={close} title="Close (Esc)">
            <X size={16} />
          </Button>
        </div>

        <div className="tx-body" ref={scrollRef} onScroll={onScroll}>
          {items.length === 0 && !usage && (
            <div className="tx-empty">Starting…</div>
          )}

          {items.map((it) => {
            if (it.kind === RUN_EVENT.thinking) {
              return (
                <div key={it.key} className="tx-item tx-thinking">
                  <div className="tx-item-head">
                    <Brain size={14} />
                    <span className="tx-item-label">Working it out</span>
                  </div>
                  <div className="tx-block tx-block-dim">{it.text}</div>
                </div>
              )
            }
            if (it.kind === RUN_EVENT.text) {
              return (
                <div key={it.key} className="tx-item tx-text">
                  <div className="tx-item-head">
                    <MessageSquareText size={14} />
                    <span className="tx-item-label">Answer</span>
                  </div>
                  <div className="tx-block">{it.text}</div>
                </div>
              )
            }
            const row = it.row
            const open = expanded.has(row.key)
            return (
              <div key={row.key} className={`tx-item tx-tool ${row.isError ? 'tx-tool-error' : ''}`}>
                <Button variant="bare" className="tx-item-head tx-tool-head" onClick={() => toggle(row.key)}>
                  <ChevronRight size={14} className={`tx-chevron ${open ? 'tx-chevron-open' : ''}`} />
                  <Wrench size={14} />
                  <span className="tx-item-label">{plainToolName(row.name)}</span>
                  {row.isError && <CircleAlert size={13} className="tx-err-icon" />}
                  {!row.done && <span className="tx-running">running…</span>}
                  <span className="tx-tool-preview">{toolInputPreview(row.input)}</span>
                </Button>
                {open && (
                  <div className="tx-tool-detail">
                    <div className="tx-detail-label">Sent</div>
                    <div className="tx-block tx-code">{stringifyToolValue(row.input)}</div>
                    {row.done && (
                      <>
                        <div className="tx-detail-label">Result{row.isError ? ' (error)' : ''}</div>
                        <div className="tx-block tx-code">{stringifyToolValue(row.output)}</div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {usage && (
          <div className="tx-usage">
            <Gauge size={14} />
            <span>
              {usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out
            </span>
            {typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0 && (
              <span className="tx-usage-dim">· {usage.cacheReadTokens.toLocaleString()} cached</span>
            )}
            {typeof usage.turns === 'number' && <span className="tx-usage-dim">· {usage.turns} turns</span>}
            {typeof usage.durationMs === 'number' && (
              <span className="tx-usage-dim">· {(usage.durationMs / 1000).toFixed(1)}s</span>
            )}
            {typeof usage.costUsd === 'number' && (
              <span className="tx-usage-cost">${usage.costUsd.toFixed(4)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Self-contained styling for the inspector overlay. Uses the injected theme CSS
// vars (injectTheme() runs before mount), so it inherits the app palette and
// stays token-driven — no raw hex.
const TX_CSS = `
.tx-backdrop {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.45);
  padding: 48px;
  font-family: var(--font-sans, -apple-system, system-ui, sans-serif);
}
.tx-card {
  width: min(900px, 90vw); height: min(80vh, 900px);
  display: flex; flex-direction: column;
  background: var(--bg-elevated, var(--bg, #1c1c1e));
  color: var(--text, #f5f5f7);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: var(--radius-lg, 14px);
  box-shadow: 0 24px 64px rgba(0,0,0,0.5);
  overflow: hidden;
}
.tx-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
  flex: 0 0 auto;
}
.tx-title { font-size: var(--font-md, 14px); font-weight: 600; }
.tx-close {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-muted-dark, #9a9aa0); cursor: pointer;
}
.tx-close:hover { background: var(--red-bg-subtle, rgba(255,80,80,0.12)); color: var(--red, #ff5c5c); }
.tx-body { flex: 1 1 auto; overflow-y: auto; padding: 12px 16px; }
.tx-empty { color: var(--text-muted-dark, #8a8a90); font-size: var(--font-sm, 13px); padding: 24px 4px; }
.tx-item { margin-bottom: 10px; }
.tx-item-head { display: flex; align-items: center; gap: 7px; font-size: var(--font-sm, 13px); }
.tx-item-label { font-weight: 600; }
.tx-tool-head {
  width: 100%; background: var(--bg-subtle, rgba(255,255,255,0.04));
  border: 1px solid var(--border, rgba(255,255,255,0.07));
  border-radius: 8px; padding: 7px 10px; cursor: pointer; color: inherit; text-align: left;
}
.tx-tool-head:hover { background: var(--bg-hover, rgba(255,255,255,0.07)); }
.tx-chevron { transition: transform 0.12s; flex: 0 0 auto; }
.tx-chevron-open { transform: rotate(90deg); }
.tx-tool-preview {
  color: var(--text-muted-dark, #9a9aa0); font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--font-xs, 12px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto;
}
.tx-running { color: var(--accent-text); font-size: var(--font-xs, 12px); flex: 0 0 auto; }
.tx-err-icon { color: var(--red, #ff5c5c); flex: 0 0 auto; }
.tx-tool-error .tx-tool-head { border-color: var(--red, rgba(255,92,92,0.5)); }
.tx-tool-detail { padding: 8px 4px 2px 22px; }
.tx-detail-label {
  font-size: var(--font-xs, 11px); text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-muted-dark, #8a8a90); margin: 8px 0 4px;
}
.tx-block {
  white-space: pre-wrap; word-break: break-word; font-size: var(--font-sm, 13px);
  line-height: 1.5;
}
.tx-block-dim { color: var(--text-muted-dark, #a0a0a6); font-style: italic; }
.tx-code {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--font-xs, 12px);
  background: var(--bg-subtle, rgba(0,0,0,0.25)); border-radius: 6px; padding: 8px 10px;
  max-height: 320px; overflow: auto;
}
.tx-thinking .tx-item-head, .tx-text .tx-item-head { margin-bottom: 4px; color: var(--text-muted-dark, #a0a0a6); }
.tx-usage {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 16px; border-top: 1px solid var(--border, rgba(255,255,255,0.08));
  font-size: var(--font-sm, 13px); font-variant-numeric: tabular-nums;
}
.tx-usage-dim { color: var(--text-muted-dark, #9a9aa0); }
.tx-usage-cost { margin-left: auto; font-weight: 600; color: var(--green, #4ade80); }
`
