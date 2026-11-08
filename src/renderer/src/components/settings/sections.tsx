// The two primitives every settings section is built from. Components only --
// the registry data they read lives in registry.ts (see the note there).
import { ChevronDown } from 'lucide-react'
import type { JSX } from 'react'
import { SECTION_HEADER_CLS } from '../Card'
import {
  sectionMatches,
  isOpenSection,
  SIMPLE_SECTIONS,
  sectionDomId,
  type SectionKey,
  type CollapseCtx
} from './registry'

// A searchable, collapsible settings section: a clickable `<h2>` header
// (chevron + title) plus the card(s) below it, which collapse/expand. Renders
// nothing when the query doesn't match, so search filters the page.
// `keywords` is extra searchable text beyond the visible title (synonyms,
// related terms) — e.g. "mic camera device" for the AV section. Force-opens
// (without persisting) on an active search match or a tray deep-link, so
// collapsing can never hide the thing the user just searched/navigated for.
//
// This is the ONLY disclosure widget. A chevron in Settings always means "this
// header hides the cards below it" — never "this card hides its own text". A
// second widget (<Collapsible>) used to hide each card's description behind an
// identical-looking chevron, and a `headless` prop let cards render with no
// header at all, so they visually floated under an unrelated section and stayed
// put when that section collapsed. Both are gone: same glyph, one meaning.
export function Section({
  sectionKey,
  title,
  keywords = '',
  query,
  className,
  anchorId,
  collapse,
  children
}: {
  sectionKey: SectionKey
  title: string
  keywords?: string
  query: string
  className?: string
  // DOM id for deep-linking (SECTION_ANCHOR_ID). Without it the focusSection
  // scroll silently no-ops — getElementById returns null and only the
  // force-open takes effect, which is what happened to the phone-remote link.
  anchorId?: string
  collapse: CollapseCtx
  children: React.ReactNode
}): JSX.Element | null {
  if (collapse.simple && !SIMPLE_SECTIONS.includes(sectionKey)) return null
  if (!sectionMatches(query, title, keywords)) return null
  if (collapse.page && !collapse.page.includes(sectionKey)) return null
  if (collapse.page)
    return (
      <div id={anchorId ?? sectionDomId(sectionKey)}>
        <h2 className="text-lg font-semibold text-on-surface mt-8 mb-3">{title}</h2>
        {children}
      </div>
    )
  const isOpen = isOpenSection(sectionKey, collapse, query.trim().length > 0)
  return (
    <div id={anchorId ?? sectionDomId(sectionKey)}>
      <h2
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        className={`${className ?? SECTION_HEADER_CLS} flex items-center gap-1.5 cursor-pointer select-none`}
        onClick={() => collapse.onToggle(sectionKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            collapse.onToggle(sectionKey)
          }
        }}
      >
        <ChevronDown
          size={13}
          strokeWidth={2.5}
          className={`shrink-0 transition-transform ${isOpen ? '' : '-rotate-90'}`}
        />
        {title}
      </h2>
      {isOpen && children}
    </div>
  )
}

// One settings card: title (+ optional badges) on the left, its control on the
// right, description always visible underneath. Descriptions used to hide
// behind a per-card chevron; a one-line hint costs less room than making the
// user click to find out what a switch does, and always-visible is what makes
// every card in the list scan identically.
export function SettingRow({
  title,
  control,
  children
}: {
  title: React.ReactNode
  // The switch/input/button this row is for. Rendered top-aligned so it stays
  // put next to the title when the description wraps to a second line.
  control?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex justify-between items-start gap-3">
      <div className="max-w-[380px]">
        {title}
        {children && <div className="mt-1">{children}</div>}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  )
}
