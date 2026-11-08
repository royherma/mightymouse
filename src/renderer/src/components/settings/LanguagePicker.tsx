import { JSX, useState, useRef, useEffect, useMemo } from 'react'
import type { SettingsState } from '../../../../shared/types'
import {
  groupedLanguages,
  findLanguage,
  searchLanguages,
  needsMultilingualModel,
  AUTO_LANGUAGE,
  type WhisperLanguage
} from '../../../../shared/whisper-languages'
import { Button } from '../Button'
import { SegmentedControl } from '../SegmentedControl'

// The language a user falls back to when they switch off Automatic. Whatever
// they last picked would be better, but there is nowhere to keep it — the one
// stored value IS the mode, so a sane default beats a second setting.
const FALLBACK_LANGUAGE = 'en'

// Flag where the language maps to one country, the language's own name, then
// the English name — so the row is readable whether or not you read that script.
function label(l: WhisperLanguage): string {
  const flag = l.flag ? `${l.flag}  ` : ''
  return l.native === l.english ? `${flag}${l.native}` : `${flag}${l.native} · ${l.english}`
}

/**
 * Picks the language dictation listens for. Three things make this more than a
 * dropdown: 100 options need type-to-search, every language other than English
 * needs a 1.6GB model that may not be on disk, and that download can fail on a
 * full disk. So the picker owns the search AND states the cost in numbers
 * before the user commits.
 *
 * Built on a native button + popover rather than Radix Select because Select
 * cannot host a text input inside its content — the search field is the whole
 * point at 100 items.
 */
export function LanguagePicker({
  state,
  value,
  onChange,
  onDownloaded
}: {
  state: SettingsState
  value: string
  onChange: (code: string) => void
  onDownloaded: (s: SettingsState) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [pct, setPct] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const model = state.multilingualModel
  const auto = value === AUTO_LANGUAGE
  const current = findLanguage(value)
  const needsModel = needsMultilingualModel(value) && !model.installed

  // Flat list in display order, so arrow keys and the rendered rows agree. With
  // no query it is the two groups; with one it is the ranked matches.
  const { rows, dividerAfter } = useMemo(() => {
    if (query.trim()) return { rows: searchLanguages(query), dividerAfter: -1 }
    const { common, rest } = groupedLanguages()
    // A rule after the common languages, so the long alphabetical tail reads as
    // a separate thing rather than the list suddenly restarting at A.
    return { rows: [...common, ...rest], dividerAfter: common.length - 1 }
  }, [query])

  // Close on an outside click or Escape. Without this the popover survives a
  // click on another setting and floats over unrelated controls.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else {
      setQuery('')
      setActive(0)
    }
  }, [open])

  // Keep the keyboard-highlighted row in view — arrowing past the fold with no
  // scroll is the classic "the list looks frozen" bug.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (code: string): void => {
    onChange(code)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') return setOpen(false)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[active]) pick(rows[active].code)
    }
  }

  const download = async (): Promise<void> => {
    setError(null)
    setPct(0)
    const off = window.api.onModelDownloadProgress(({ pct: p }) => setPct(p))
    const { result, state: s } = await window.api.settingsDownloadModel(model.name)
    off()
    setPct(null)
    if (result.ok) onDownloaded(s)
    else setError(result.error || 'Download failed')
  }

  return (
    <div ref={rootRef} className="relative">
      <SegmentedControl
        items={[
          { id: 'auto', label: 'Automatic' },
          { id: 'pick', label: 'Specific language' }
        ]}
        active={auto ? 'auto' : 'pick'}
        onChange={(id) => onChange(id === 'auto' ? AUTO_LANGUAGE : FALLBACK_LANGUAGE)}
        className="mt-1 mb-2"
      />

      {auto ? (
        <div className="text-sm text-muted">
          Speak any language and MightyMouse works out which one.
        </div>
      ) : (
      <div className="relative">
      <Button
        variant="bare"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center justify-between bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-sans transition-colors hover:border-muted-dark focus:border-accent"
      >
        <span>{current ? label(current) : value}</span>
        <span className="text-muted">▾</span>
      </Button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-surface2 border border-surface3 rounded-md shadow-panel overflow-hidden">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search 100 languages…"
            className="w-full bg-surface1 border-0 border-b border-surface3 text-on-surface px-2.5 py-2 text-md font-sans outline-none placeholder:text-muted"
          />
          <div ref={listRef} className="max-h-64 overflow-y-auto p-1" role="listbox">
            {rows.map((l, i) => (
              <div key={l.code}>
                <div
                  role="option"
                  aria-selected={l.code === value}
                  data-active={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(l.code)}
                  className={`text-md px-2.5 py-1.5 rounded-sm cursor-pointer select-none ${
                    i === active ? 'bg-surface3' : ''
                  } ${l.code === value ? 'text-accent-text' : 'text-on-surface'}`}
                >
                  {label(l)}
                </div>
                {i === dividerAfter && <div className="h-px bg-surface3 my-1" />}
              </div>
            ))}
            {rows.length === 0 && (
              <div className="px-2.5 py-2 text-sm text-muted">
                No language matches “{query}”.
              </div>
            )}
          </div>
        </div>
      )}
      </div>
      )}

      {needsModel && pct === null && (
        <div className="mt-2 text-sm text-muted">
          {auto ? 'Detecting the language' : current?.english ?? value} needs a one-time{' '}
          {model.needLabel} download.
          {model.freeLabel && ` You have ${model.freeLabel} free.`}
          <div className="mt-2">
            {model.hasRoom ? (
              <Button onClick={download}>Download {model.needLabel}</Button>
            ) : (
              <span className="text-red-light">
                Not enough space — free up {model.needLabel} and try again.
              </span>
            )}
          </div>
        </div>
      )}

      {pct !== null && (
        <div className="mt-2">
          <div className="text-sm text-muted">Downloading… {pct}%</div>
          <div className="h-1 bg-surface3 rounded-full mt-1 overflow-hidden">
            <div
              className="h-1 bg-cyan rounded-full transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {error && <div className="mt-2 text-sm text-red-light">{error}</div>}

      {auto && model.installed && pct === null && !error && (
        <div className="mt-1 text-sm text-muted">
          Picking your language instead is a little faster.
        </div>
      )}

      {needsMultilingualModel(value) && model.installed && pct === null && !error && (
        <div className="mt-2 text-sm text-muted">
          {auto
            ? 'Ready — MightyMouse listens in whatever language you speak.'
            : `Ready — dictation now listens in ${current?.native ?? value}.`}
        </div>
      )}
    </div>
  )
}
