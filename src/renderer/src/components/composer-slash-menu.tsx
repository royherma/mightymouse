import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, RefObject } from 'react'
import { X } from 'lucide-react'
import type { SkillInfo } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'
import { Modal } from './Modal'
import { McpConnectionsList } from './mcp-connections'
import './KeysPanel.css'
import './composer-slash-menu.css'

const L = CONFIG.UI_LABELS
const MAX_ITEMS = 40

type Popup = 'mcp' | 'skills'
type Command = { name: string; description: string; popup?: Popup; midSession?: boolean }

const APP_COMMANDS: Command[] = [
  { name: 'mcp', description: L.SLASH_MCP, popup: 'mcp' },
  { name: 'skills', description: L.SLASH_SKILLS, popup: 'skills' }
]

const CLAUDE_COMMANDS: Command[] = [
  { name: 'compact', description: L.SLASH_COMPACT, midSession: true },
  { name: 'clear', description: L.SLASH_CLEAR, midSession: true },
  { name: 'init', description: L.SLASH_INIT },
  { name: 'review', description: L.SLASH_REVIEW }
]

function rank(list: Command[], query: string): Command[] {
  const q = query.toLowerCase()
  const hits = list.filter((c) => c.name.toLowerCase().includes(q))
  const starts = (c: Command): number => (c.name.toLowerCase().startsWith(q) ? 0 : 1)
  return hits.sort((a, b) => starts(a) - starts(b)).slice(0, MAX_ITEMS)
}

function useSkills(enabled: boolean): SkillInfo[] {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  useEffect(() => {
    if (enabled) void window.api.skillsList().then(setSkills).catch(() => setSkills([]))
  }, [enabled])
  return skills
}

function SlashDialog(props: { title: string; onClose: () => void; children: React.ReactNode }): JSX.Element {
  const { onClose } = props
  return (
    <Modal label={props.title} onClose={onClose} backdropClassName="keys-sheet-backdrop" className="keys-sheet slash-dialog">
      <div className="slash-dialog-head">
        <div className="keys-sheet-title">{props.title}</div>
        <Button variant="icon" className="slash-dialog-close" aria-label={L.SLASH_CLOSE} title={L.SLASH_CLOSE} onClick={onClose}>
          <X size={14} />
        </Button>
      </div>
      <div className="slash-dialog-body">{props.children}</div>
    </Modal>
  )
}

function SkillsBrowser(props: { skills: SkillInfo[]; onPick: (name: string) => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const shown = rank(props.skills, query)
  return (
    <>
      <input
        className="slash-search"
        autoFocus
        placeholder={L.SLASH_SKILLS_SEARCH}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && shown[0] && props.onPick(shown[0].name)}
      />
      {props.skills.length === 0 && <p className="slash-empty">{L.SLASH_SKILLS_NONE}</p>}
      <ul className="slash-list">
        {shown.map((s) => (
          <li key={s.name}>
            <Button variant="bare" className="slash-item" onClick={() => props.onPick(s.name)}>
              <span className="slash-name">/{s.name}</span>
              {s.description && <span className="slash-desc">{s.description}</span>}
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

export function useSlashMenu(props: {
  draft: string
  setDraft: (text: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  cwd?: string
  claude: boolean
  newSession?: boolean
}): { onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean; menu: JSX.Element | null; popup: JSX.Element | null; openMcp: () => void } {
  const { draft, setDraft, inputRef, cwd, claude, newSession } = props
  const [popup, setPopup] = useState<Popup | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const query = /^\/([^\s/]*)$/.exec(draft)?.[1]
  const open = claude && query !== undefined && dismissed !== draft
  const skills = useSkills(claude)

  const matches = useMemo(() => {
    if (query === undefined) return []
    const skillCommands = skills.map((s) => ({ name: s.name, description: s.description }))
    return rank([...APP_COMMANDS.filter((c) => c.popup !== 'mcp' || cwd), ...CLAUDE_COMMANDS.filter((c) => !(newSession && c.midSession)), ...skillCommands], query)
  }, [query, skills, cwd, newSession])

  useEffect(() => setSel(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const focusEnd = (text: string): void => {
    setDraft(text)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(text.length, text.length)
    })
  }

  const pick = (c: Command): void => {
    if (c.popup) {
      setDraft('')
      setPopup(c.popup)
      return
    }
    focusEnd(`/${c.name} `)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || matches.length === 0) return false
    const current = matches[sel]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1
      setSel((i) => (i + step + matches.length) % matches.length)
    } else if (e.key === 'Escape') {
      setDismissed(draft)
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      if (e.key === 'Enter' && !current.popup && current.name === query) return false
      pick(current)
    } else {
      return false
    }
    e.preventDefault()
    return true
  }

  const menu = open ? (
    <div className="slash-menu" role="listbox">
      {matches.length === 0 ? (
        <p className="slash-empty">{L.SLASH_EMPTY}</p>
      ) : (
        <ul className="slash-list" ref={listRef}>
          {matches.map((c, i) => (
            <li key={c.name}>
              <Button
                variant="bare"
                className="slash-item"
                data-active={i === sel || undefined}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(c)
                }}
                onMouseEnter={() => setSel(i)}
              >
                <span className="slash-name">/{c.name}</span>
                {c.description && <span className="slash-desc">{c.description}</span>}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null

  const close = (): void => {
    setPopup(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const dialog =
    popup === 'mcp' && cwd ? (
      <SlashDialog title={L.MCP_TITLE} onClose={close}>
        <McpConnectionsList cwd={cwd} />
      </SlashDialog>
    ) : popup === 'skills' ? (
      <SlashDialog title={L.SLASH_SKILLS_TITLE} onClose={close}>
        <SkillsBrowser
          skills={skills}
          onPick={(name) => {
            setPopup(null)
            focusEnd(`/${name} `)
          }}
        />
      </SlashDialog>
    ) : null

  return { onKeyDown, menu, popup: dialog, openMcp: () => setPopup('mcp') }
}
