import { useEffect, useRef, useState, type JSX } from 'react'
import { Flag, Pencil, Share2, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { Button } from './Button'
import { Maker, ReportPanel, SharePanel, SharedModBar, SharedModRow } from './side-browser-shared-mods'
import type { SharedMod, SiteModAction, SiteModState } from '../../../shared/types'

export interface ModEdit {
  modId: string
  name: string
  text: string
  auto: boolean
  key: number
}

const DECLINED_OFFERS_KEY = 'mm.sideBrowserModOffersDeclined'

const offerEdit = (text: string): Omit<ModEdit, 'key'> => ({ modId: '', name: '', text, auto: true })

function declinedOffers(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DECLINED_OFFERS_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function declineOffer(offer: string): void {
  try {
    localStorage.setItem(DECLINED_OFFERS_KEY, JSON.stringify([...declinedOffers(), offer]))
  } catch {
    return
  }
}

function ModRow({
  viewId,
  mod,
  here,
  act,
  onEdit,
  onChanged
}: {
  viewId: string | undefined
  mod: SiteModState
  here: boolean
  act: (action: SiteModAction, id?: string, name?: string) => void
  onEdit: (edit: Omit<ModEdit, 'key'>) => void
  onChanged: () => void
}): JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [panel, setPanel] = useState<'share' | 'report' | null>(null)
  const fromOthers = mod.shared && !mod.shared.mine
  const [draft, setDraft] = useState(mod.name)
  const save = (): void => {
    setRenaming(false)
    if (draft.trim() && draft.trim() !== mod.name) act('rename', mod.id, draft.trim())
    else setDraft(mod.name)
  }
  return (
    <>
    <div className="side-browser-mod-row">
      {renaming ? (
        <div className="side-browser-menu-row" data-on={mod.on ? '' : undefined}>
          <Wand2 size={13} />
          <input
            className="side-browser-mod-rename"
            value={draft}
            autoFocus
            aria-label="New name"
            spellCheck={false}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') {
                setDraft(mod.name)
                setRenaming(false)
              }
            }}
          />
        </div>
      ) : (
        <Button
          variant="bare"
          role="menuitemcheckbox"
          aria-checked={mod.on}
          className="side-browser-menu-row"
          data-on={mod.on ? '' : undefined}
          title={mod.pulled ?? (mod.on ? 'On - click to turn off' : 'Off - click to turn on')}
          disabled={Boolean(mod.pulled)}
          onClick={() => act('toggle', mod.id)}
        >
          <Wand2 size={13} />
          <span className="side-browser-suggest-title">{mod.name}</span>
          <span className="side-browser-suggest-url" data-tone={mod.broken || mod.pulled ? 'bad' : undefined}>
            {mod.pulled ? (
              'Turned off by MightyMouse'
            ) : mod.broken ? (
              'Stopped working'
            ) : !mod.on ? (
              'Off'
            ) : mod.shared && fromOthers ? (
              <Maker name={mod.shared.maker} verified={mod.shared.verified} />
            ) : (
              mod.host
            )}
          </span>
        </Button>
      )}
      <div className="side-browser-mod-actions">
        {here && (
          <Button
            variant="bare"
            className="side-browser-nav"
            aria-label={mod.broken ? `Fix ${mod.name}` : `Change ${mod.name}`}
            title={mod.broken ? 'Fix it' : 'Change it with AI'}
            onClick={() =>
              onEdit(
                mod.broken
                  ? { modId: mod.id, name: mod.name, text: `It stopped working: ${mod.broken}. Fix it.`, auto: true }
                  : { modId: mod.id, name: mod.name, text: '', auto: false }
              )
            }
          >
            <Sparkles size={12} />
          </Button>
        )}
        {!mod.builtIn && !fromOthers && (
          <Button
            variant="bare"
            className="side-browser-nav"
            aria-label={`Share ${mod.name}`}
            title={mod.shared ? 'Shared - copy the link' : 'Share it with a link'}
            data-on={mod.shared || panel === 'share' ? '' : undefined}
            onClick={() => setPanel((p) => (p === 'share' ? null : 'share'))}
          >
            <Share2 size={12} />
          </Button>
        )}
        {fromOthers && (
          <Button
            variant="bare"
            className="side-browser-nav"
            aria-label={`Report ${mod.name}`}
            title="Report a problem with this mod"
            onClick={() => setPanel((p) => (p === 'report' ? null : 'report'))}
          >
            <Flag size={12} />
          </Button>
        )}
        <Button variant="bare" className="side-browser-nav" aria-label={`Rename ${mod.name}`} title="Rename" onClick={() => setRenaming(true)}>
          <Pencil size={12} />
        </Button>
        <Button variant="bare" className="side-browser-nav" aria-label={`Remove ${mod.name}`} title="Remove" onClick={() => act('remove', mod.id)}>
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
    {mod.pulled && <div className="side-browser-mod-panel" data-tone="bad"><span>{mod.pulled}</span></div>}
    {panel === 'share' && <SharePanel viewId={viewId} mod={mod} onChanged={onChanged} />}
    {panel === 'report' && mod.shared && <ReportPanel viewId={viewId} sharedId={mod.shared.id} onDone={() => setPanel(null)} />}
    </>
  )
}

export function ModsMenu({
  viewId,
  here,
  suggestion,
  shared,
  onEdit
}: {
  viewId: string | undefined
  here: SiteModState[] | undefined
  suggestion: string | undefined
  shared: SharedMod[] | undefined
  onEdit: (edit: Omit<ModEdit, 'key'>) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [mods, setMods] = useState<SiteModState[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const act = (action: SiteModAction, id?: string, name?: string): void =>
    void window.api.sideBrowser.mod(viewId ?? '', action, id, name).then(setMods)
  const refresh = (): void => void window.api.sideBrowser.mod(viewId ?? '', 'list').then(setMods)

  useEffect(() => {
    if (open) void window.api.sideBrowser.mod(viewId ?? '', 'list').then(setMods)
  }, [open, viewId, here])

  useEffect(() => {
    if (!open) return
    void window.api.sideBrowser
      .sharedMod(viewId ?? '', { do: 'sync' })
      .then(() => window.api.sideBrowser.mod(viewId ?? '', 'list'))
      .then(setMods)
      .catch(() => undefined)
  }, [open, viewId])

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div ref={ref} className="side-browser-pop">
      <Button
        variant="bare"
        className="side-browser-nav"
        aria-label="Mods"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Mods"
        data-on={open || here?.some((m) => m.on) ? '' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Wand2 size={13} />
      </Button>
      {open && (
        <div className="side-browser-menu side-browser-mods-menu" role="menu">
          <p className="side-browser-top-label side-browser-mods-head">{shared?.length ? 'From other people, for this site' : 'Mods'}</p>
          {suggestion && (
            <Button
              variant="bare"
              role="menuitem"
              className="side-browser-menu-row"
              title="Try this mod on this site"
              onClick={() => {
                setOpen(false)
                onEdit(offerEdit(suggestion))
              }}
            >
              <Sparkles size={13} />
              <span className="side-browser-suggest-title">{suggestion}</span>
              <span className="side-browser-suggest-url">Try it</span>
            </Button>
          )}
          {shared?.map((m) => <SharedModRow key={m.id} viewId={viewId} mod={m} onChanged={refresh} />)}
          {Boolean(shared?.length) && <p className="side-browser-top-label side-browser-mods-head">Yours</p>}
          {mods && !mods.length && (
            <p className="side-browser-mods-empty">None yet. Open the AI box on any site and say how it should work.</p>
          )}
          {mods?.map((m) => (
            <ModRow
              key={m.id}
              viewId={viewId}
              onChanged={refresh}
              mod={m}
              here={Boolean(here?.some((h) => h.id === m.id))}
              act={act}
              onEdit={(edit) => {
                setOpen(false)
                onEdit(edit)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ModOffers({
  viewId,
  link,
  shared,
  suggestion,
  onTry
}: {
  viewId: string
  link: SharedMod | undefined
  shared: SharedMod[] | undefined
  suggestion: string | undefined
  onTry: (edit: Omit<ModEdit, 'key'>) => void
}): JSX.Element | null {
  const [declined, setDeclined] = useState(declinedOffers)
  const decline = (offer: string): void => {
    declineOffer(offer)
    setDeclined([...declined, offer])
  }
  if (link) return <SharedModBar key={link.id} viewId={viewId} mod={link} />
  const offered = shared?.find((m) => !declined.includes(m.id))
  if (offered) return <SharedModBar key={offered.id} viewId={viewId} mod={offered} onDecline={() => decline(offered.id)} />
  if (!suggestion || declined.includes(suggestion)) return null
  return (
    <div className="side-browser-permission">
      <span>
        <b>Mod for this site:</b> {suggestion}
      </span>
      <Button variant="ghost" onClick={() => decline(suggestion)}>
        No thanks
      </Button>
      <Button variant="primary" onClick={() => onTry(offerEdit(suggestion))}>
        Try it
      </Button>
    </div>
  )
}

export function BrokenModBar({
  viewId,
  mod,
  onFix
}: {
  viewId: string
  mod: SiteModState
  onFix: (edit: Omit<ModEdit, 'key'>) => void
}): JSX.Element {
  return (
    <div className="side-browser-permission">
      <span>
        <b>{mod.name}</b> stopped working: {mod.broken}
      </span>
      <Button variant="ghost" onClick={() => void window.api.sideBrowser.mod(viewId, 'toggle', mod.id)}>
        Turn off
      </Button>
      <Button
        variant="primary"
        onClick={() =>
          onFix({ modId: mod.id, name: mod.name, text: `It stopped working: ${mod.broken}. Fix it.`, auto: true })
        }
      >
        Fix it
      </Button>
    </div>
  )
}
