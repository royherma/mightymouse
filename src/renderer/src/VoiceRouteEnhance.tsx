import {
  BookOpen,
  Brain,
  FileText,
  Flame,
  Hash,
  Heart,
  HelpCircle,
  Laugh,
  Layers,
  Lightbulb,
  Quote,
  TrendingUp,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { VoiceRouteEnhancePayload } from '../../shared/types'
import { Button } from './components/Button'
import { CopyButton } from './components/CopyButton'
import { SKELETON_WIDTHS } from './voice-route-labels'

const LABEL_ICONS: Array<[RegExp, LucideIcon]> = [
  [/sharp|short|direct|quick|tight/, Zap],
  [/brief|full|detail|complete|spec/, FileText],
  [/genius|deep|first principles|reframe|real/, Brain],
  [/contrarian|hot|spicy|bold|take/, Flame],
  [/story|personal|journey/, BookOpen],
  [/punch|joke|funny|humou?r/, Laugh],
  [/predict|future|trend/, TrendingUp],
  [/number|data|stat|metric/, Hash],
  [/warm|kind|friendly/, Heart],
  [/question|ask|answer/, HelpCircle],
  [/idea|pivot|club|product|business/, Lightbulb]
]
const FALLBACK_ICONS: LucideIcon[] = [Zap, Layers, Lightbulb]

function iconFor(label: string, index: number): LucideIcon {
  if (index < 0) return Quote
  const lower = label.toLowerCase()
  return (
    LABEL_ICONS.find(([re]) => re.test(lower))?.[1] ?? FALLBACK_ICONS[index % FALLBACK_ICONS.length]
  )
}

export function EnhanceBand({
  enhance,
  original,
  onSelect,
  onCopy,
  onRetry
}: {
  enhance: VoiceRouteEnhancePayload
  original: string
  onSelect: (index: number) => void
  onCopy: (index: number) => void
  onRetry: () => void
}): React.JSX.Element {
  const [nowMs, setNowMs] = useState(0)
  const running = enhance.status === 'running'
  const done = enhance.status === 'done'
  useEffect(() => {
    if (!running) return
    const tick = setInterval(() => setNowMs(Date.now()), 100)
    return () => clearInterval(tick)
  }, [running])
  const ms = running ? Math.max(0, nowMs - enhance.startedAt) : enhance.tookMs
  const rows = [{ label: 'Original', text: original }, ...enhance.variants]
  return (
    <div className="vroute-rows">
      <div className="vroute-col-title flex items-center gap-2">
        <span>{running ? 'Writing better versions…' : 'Better versions'}</span>
        <span
          className={running ? 'vroute-took is-live' : 'vroute-took'}
        >{`${(ms / 1000).toFixed(1)}s`}</span>
        {done && <span className="ml-auto normal-case tracking-normal">⌘E for 3 more</span>}
      </div>
      {rows.map((row, i) => {
        const Icon = iconFor(row.label, i - 1)
        return (
          <div
            key={`${enhance.startedAt}-${i}`}
            className={`vroute-row group${enhance.selected === i - 1 ? ' is-suggested' : ''}`}
          >
            <div className="vroute-top">
              <Button
                variant="ghost"
                className="vroute-main text-left"
                disabled={!done}
                title="Send this version"
                onClick={() => onSelect(i - 1)}
              >
                <Icon size={14} strokeWidth={2.25} className="shrink-0 text-accent-text" />
                <span className="vroute-name text-sm font-semibold">{row.label}</span>
              </Button>
              <CopyButton
                label={`Copy ${row.label} and close`}
                className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                disabled={i > 0 && !done}
                copy={() => onCopy(i - 1)}
              />
            </div>
            <div className="max-h-40 cursor-text select-text overflow-y-auto whitespace-pre-wrap px-2 pb-1.5 text-xs text-muted">
              {row.text}
            </div>
          </div>
        )
      })}
      {running &&
        Array.from({ length: 3 }, (_, i) => (
          <div key={`skel-${i}`} className="vroute-row is-skeleton">
            <div className="vroute-top">
              <span
                className="skeleton vroute-skel-name"
                style={{ width: SKELETON_WIDTHS[i % SKELETON_WIDTHS.length] }}
              />
            </div>
          </div>
        ))}
      {enhance.status === 'failed' && (
        <div className="flex items-center gap-2 px-2 py-1 text-xs">
          <span className="text-muted">{enhance.reason}</span>
          <Button variant="primary" className="ml-auto" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}
