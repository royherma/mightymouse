import { JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, GitBranch, GitFork } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { MOVE_MENU_GAP, MOVE_MENU_MARGIN } from '../mighty/mighty-shared'
import { Button } from './Button'

const MENU_W = 300
const SHA_SHOWN = 7

type Repo = { cwd: string; branch: string; dirty: number }

function fill(text: string, branch: string, dirty = 0): string {
  return text
    .replace('{branch}', branch)
    .replace('{n}', String(dirty))
    .replace('{s}', dirty === 1 ? '' : 's')
}

export function BranchPicker({ cwd }: { cwd: string }): JSX.Element | null {
  const L = CONFIG.UI_LABELS
  const [repo, setRepo] = useState<Repo | null>(null)
  const [ownCopy, setOwnCopy] = useState(false)
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    void window.api.settingsGet().then((s) => setOwnCopy(s.codeOwnCopy))
  }, [])

  useEffect(() => {
    void window.api
      .repoGitState(cwd)
      .then((g) =>
        setRepo(
          g
            ? {
                cwd,
                branch: g.branch === 'HEAD' ? g.head.sha.slice(0, SHA_SHOWN) : g.branch,
                dirty: g.dirty
              }
            : null
        )
      )
  }, [cwd])

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const h = menuRef.current?.offsetHeight ?? 0
    const left = Math.min(
      Math.max(MOVE_MENU_MARGIN, r.left),
      window.innerWidth - MENU_W - MOVE_MENU_MARGIN
    )
    const below = r.bottom + MOVE_MENU_GAP
    setPos({
      top: below + h > window.innerHeight - MOVE_MENU_MARGIN ? r.top - MOVE_MENU_GAP - h : below,
      left
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!repo || repo.cwd !== cwd) return null

  const pick = async (next: boolean): Promise<void> => {
    setOpen(false)
    if (next === ownCopy) return
    const s = await window.api.settingsSave({ codeOwnCopy: next })
    setOwnCopy(s.codeOwnCopy)
  }

  const options = [
    {
      on: false,
      icon: GitBranch,
      title: fill(L.CODE_BRANCH_SAME, repo.branch),
      detail: L.CODE_BRANCH_SAME_DETAIL
    },
    {
      on: true,
      icon: GitFork,
      title: fill(L.CODE_BRANCH_NEW, repo.branch),
      detail:
        repo.dirty > 0
          ? fill(L.CODE_BRANCH_NEW_DIRTY, repo.branch, repo.dirty)
          : L.CODE_BRANCH_NEW_DETAIL
    }
  ]
  const Icon = ownCopy ? GitFork : GitBranch

  return (
    <>
      <Button
        variant="bare"
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={L.CODE_BRANCH_TITLE}
        className={`inline-flex w-fit max-w-[min(100%,14rem)] shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-xs font-medium transition-colors active:scale-[0.98] ${
          ownCopy
            ? 'border-accent bg-accent-wash text-accent-text hover:bg-accent/15'
            : 'border-surface3 bg-surface2 text-on-surface hover:bg-surface1'
        }`}
      >
        <Icon size={13} strokeWidth={2} className="shrink-0" />
        <span className="min-w-0 truncate">
          {ownCopy ? (
            <>
              {L.CODE_BRANCH_NEW_SHORT}{' '}
              <span className="opacity-70">{fill(L.CODE_BRANCH_FROM, repo.branch)}</span>
            </>
          ) : (
            repo.branch
          )}
        </span>
        <ChevronDown size={12} className="shrink-0 opacity-60" strokeWidth={2.5} />
      </Button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[200] rounded-lg border border-surface3 bg-surface1 p-1 shadow-lg"
            style={{ top: pos.top, left: pos.left, width: MENU_W }}
          >
            {options.map((o) => (
              <Button
                variant="bare"
                key={String(o.on)}
                role="menuitemradio"
                aria-checked={ownCopy === o.on}
                onClick={() => void pick(o.on)}
                className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-surface2"
              >
                <o.icon size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-on-surface">{o.title}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{o.detail}</span>
                </span>
                {ownCopy === o.on && (
                  <Check size={14} className="mt-0.5 shrink-0 text-accent-text" />
                )}
              </Button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
