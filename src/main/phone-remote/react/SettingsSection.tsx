import { ChevronDown, type LucideIcon } from 'lucide-react'
import { Button } from '@shared/ui/Button'

// One titled, collapsible group inside the settings sheet. The sheet carries
// ~15 rows; flat, that's a wall you scroll past rather than read. Grouping
// alone would still leave every row rendered at once, so sections collapse --
// which also lets the portrait sheet hug its content and sit centered instead
// of stretching top-to-bottom (see .settingsPanel in theme.css).
//
// Open/closed state is owned by the parent (SettingsBody), which holds a set
// of open ids -- sections toggle independently, so opening one never shuts
// another you were mid-way through adjusting.
// Every section carries an icon, not just the ones with an obvious glyph: a
// single decorated header among five plain ones reads as a highlight or an
// error state rather than as a category mark. Collapsed, the icon is also the
// only thing distinguishing one closed row from the next at a glance.
export default function SettingsSection(props: {
  title: string
  icon: LucideIcon
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const { title, icon: Icon, open, onToggle, children } = props

  return (
    <div className={`settingsSection${open ? ' open' : ''}`}>
      <Button
        variant="bare"
        type="button"
        className="settingsSectionToggle"
        onClick={onToggle}
        aria-expanded={open}
      >
        {/* Decorative: the adjacent title already names the section, so a
            screen reader announcing the glyph too would just stutter. */}
        <Icon size={15} className="settingsSectionIcon" aria-hidden="true" />
        <span className="settingsSectionTitle">{title}</span>
        <ChevronDown size={16} className={`settingsSectionChevron${open ? ' open' : ''}`} />
      </Button>
      {open && <div className="settingsSectionBody">{children}</div>}
    </div>
  )
}
