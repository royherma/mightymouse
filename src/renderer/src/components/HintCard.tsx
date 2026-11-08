import type { CSSProperties, JSX, ReactNode } from 'react'
import { Lightbulb, TriangleAlert } from 'lucide-react'

/**
 * An inline callout — a leading icon, a bold title, and an optional quieter
 * subtitle. Replaces the 12px muted line the tour used for its "no luck?"
 * escalation, which rendered the one moment the tour needs to be HEARD at the
 * smallest type size on screen.
 *
 * Two severities on purpose, preserving the tour's existing two-tier
 * escalation: the first timeout is `info` (soft, accent) because one miss is
 * probably hesitation, and only the repeated-failure case goes `warn` amber.
 * A card that always shouted would over-signal failure to users whose hotkeys
 * are working fine.
 */
export type HintSeverity = 'info' | 'warn'

// The *-bg-subtle / *-border-subtle tokens exist as CSS vars but NOT as Tailwind
// color classes (see tailwind.config.js — only the base hues are mapped), so the
// tinted surface goes through `style` like every other subtle-tinted surface in
// the app (SettingsApp does the same).
const TONE: Record<HintSeverity, { wrap: string; icon: string; style?: CSSProperties }> = {
  info: { wrap: 'bg-surface1 border-surface3', icon: 'text-accent-text' },
  warn: {
    wrap: '',
    icon: 'text-amber',
    style: { background: 'var(--amber-bg-subtle)', borderColor: 'var(--amber-border-subtle)' }
  }
}

const ICON: Record<HintSeverity, typeof Lightbulb> = {
  info: Lightbulb,
  warn: TriangleAlert
}

export function HintCard({
  title,
  subtitle,
  severity = 'info',
  action
}: {
  title: string
  subtitle?: string
  severity?: HintSeverity
  action?: ReactNode
}): JSX.Element {
  const tone = TONE[severity]
  const Icon = ICON[severity]

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-left ${tone.wrap}`}
      style={tone.style}
      role="status"
    >
      <Icon size={20} strokeWidth={2.25} className={`shrink-0 mt-0.5 ${tone.icon}`} />
      <div className="min-w-0 flex-1">
        <div className="text-md font-semibold text-on-surface leading-snug">{title}</div>
        {subtitle && <div className="text-sm text-muted leading-snug mt-0.5">{subtitle}</div>}
      </div>
      {action}
    </div>
  )
}
