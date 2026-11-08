import { CSSProperties, JSX, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import {
  OPEN_SPECIALIST_EVENT,
  SUPPORT_LIMITS,
  type SupportClient,
  type SupportSpecialist,
  type SupportState
} from './types'

const AVATAR_SIZE = {
  sm: 'h-6 w-6 text-[11px]',
  md: 'h-9 w-9 text-sm',
  lg: 'h-14 w-14 text-xl'
} as const
const SEEN_KEY = 'mm.specialist.seenUpTo'

export function SpecialistAvatar({
  specialist,
  size,
  unread = 0
}: {
  specialist: Pick<SupportSpecialist, 'name' | 'photoUrl'> & { online?: boolean }
  size: keyof typeof AVATAR_SIZE
  unread?: number
}): JSX.Element {
  return (
    <span className={`relative inline-flex shrink-0 ${AVATAR_SIZE[size]}`}>
      {specialist.photoUrl ? (
        <img
          src={specialist.photoUrl}
          alt=""
          className="h-full w-full rounded-full object-cover ring-2 ring-surface1"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full bg-accent font-bold text-on-accent ring-2 ring-surface1">
          {specialist.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      {specialist.online && (
        <span className="absolute bottom-0 right-0 h-[28%] min-h-[8px] w-[28%] min-w-[8px] rounded-full bg-green ring-2 ring-surface1" />
      )}
      {unread > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red px-1 text-[11px] font-bold text-on-accent ring-2 ring-surface1">
          {unread}
        </span>
      )}
    </span>
  )
}

const STATE_CACHE_KEY = 'mm.specialist.state'
const RISE = { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
const COMPOSER_MAX_PX = 140

function readCachedState(): SupportState | null {
  try {
    const raw = localStorage.getItem(STATE_CACHE_KEY)
    return raw ? (JSON.parse(raw) as SupportState) : null
  } catch {
    return null
  }
}

function writeCachedState(s: SupportState): void {
  try {
    localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(s))
  } catch {
    // Storage blocked: the panel just shows a spinner on the next open.
  }
}

function useSupportState(client: SupportClient): {
  state: SupportState | null
  failed: boolean
  reload: () => Promise<void>
  setState: (s: SupportState) => void
} {
  const [state, setRawState] = useState<SupportState | null>(readCachedState)
  const [failed, setFailed] = useState(false)
  const setState = useCallback((s: SupportState) => {
    setRawState(s)
    writeCachedState(s)
  }, [])
  const reload = useCallback(
    () =>
      client.load().then(
        (s) => {
          setState(s)
          setFailed(false)
        },
        () => setFailed(true)
      ),
    [client, setState]
  )
  useEffect(() => {
    void reload()
    return client.subscribe(() => void reload())
  }, [client, reload])
  return { state, failed, reload, setState }
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function useRiseIn(enabled: boolean): (el: HTMLDivElement | null) => void {
  return useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !enabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      el.animate(
        [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'none' }
        ],
        RISE
      )
    },
    [enabled]
  )
}

function Bubble({
  from,
  body,
  title,
  animate,
  dim = false
}: {
  from: 'me' | 'them'
  body: string
  title?: string
  animate: boolean
  dim?: boolean
}): JSX.Element {
  const rise = useRiseIn(animate)
  const shape =
    from === 'me'
      ? 'ml-auto rounded-br-sm bg-accent text-on-accent'
      : 'rounded-bl-sm bg-surface2 text-on-surface'
  return (
    <div
      ref={rise}
      title={title}
      className={`max-w-[78%] whitespace-pre-wrap break-words rounded-lg px-3.5 py-2 text-[14px] leading-[1.45] transition-opacity ${shape} ${dim ? 'opacity-60' : ''}`}
    >
      {body}
    </div>
  )
}

type Pending = { key: number; body: string; failed: boolean }

export function SpecialistPanel({
  client,
  onClose,
  insetTop = false,
  shared
}: {
  client: SupportClient
  onClose?: () => void
  /** Mac window: leaves room for the traffic lights and lets the header drag the window. */
  insetTop?: boolean
  shared?: ReturnType<typeof useSupportState>
}): JSX.Element {
  const own = useSupportState(client)
  const { state, failed, reload, setState } = shared ?? own
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [justSent, setJustSent] = useState(false)
  const [settledCount] = useState(() => state?.messages.length ?? 0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const nextKey = useRef(1)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const el = listRef.current
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [state?.messages.length, pending.length])

  const deliver = (item: Pending): void => {
    client.send(item.body).then(
      (s) => {
        setState(s)
        setPending((p) => p.filter((x) => x.key !== item.key))
        setJustSent(true)
      },
      () => setPending((p) => p.map((x) => (x.key === item.key ? { ...x, failed: true } : x)))
    )
  }

  const send = (): void => {
    const body = draft.trim()
    if (!body) return
    const item = { key: nextKey.current++, body, failed: false }
    setPending((p) => [...p, item])
    setDraft('')
    setJustSent(false)
    if (inputRef.current) inputRef.current.style.height = ''
    deliver(item)
  }

  const retry = (item: Pending): void => {
    setPending((p) => p.map((x) => (x.key === item.key ? { ...x, failed: false } : x)))
    deliver(item)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const grow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`
  }

  const specialist = state?.specialist ?? { name: 'Your Specialist', photoUrl: null, online: false }
  const messages = state?.messages ?? []
  const lastIsMine = pending.length === 0 && messages.at(-1)?.sender === 'user'
  const sendingNow = pending.some((p) => !p.failed)
  const dragStyle = insetTop ? ({ WebkitAppRegion: 'drag' } as CSSProperties) : undefined
  const noDrag = insetTop ? ({ WebkitAppRegion: 'no-drag' } as CSSProperties) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface1 text-on-surface">
      <div
        style={dragStyle}
        className={`flex items-center gap-3 border-b border-surface3 px-4 pb-3 ${insetTop ? 'pt-9' : 'pt-3'}`}
      >
        <SpecialistAvatar specialist={specialist} size="md" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold leading-tight">{specialist.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            {specialist.online && <span className="h-1.5 w-1.5 rounded-full bg-green" />}
            {specialist.online ? 'Online now' : 'Your Specialist'}
          </div>
        </div>
        {onClose && (
          <Button variant="icon" aria-label="Close" onClick={onClose} style={noDrag}>
            <X size={16} />
          </Button>
        )}
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-4">
        {!state && !failed && (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        )}
        {failed && !state && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted">
            {"Couldn't load your chat."}
            <Button variant="secondary" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        )}
        {state && (
          <div className="mb-1 flex items-end gap-2">
            <SpecialistAvatar specialist={{ ...specialist, online: false }} size="sm" />
            <Bubble
              from="them"
              animate={false}
              body={`Hi, I'm ${specialist.name}. Stuck on something, or want ideas for what to build? Ask me here and I'll reply.`}
            />
          </div>
        )}
        {messages.map((m, i) =>
          m.sender === 'user' ? (
            <Bubble
              key={m.id}
              from="me"
              body={m.body}
              title={timeLabel(m.createdAt)}
              animate={i >= settledCount && !justSent}
            />
          ) : (
            <div key={m.id} className="flex items-end gap-2">
              <SpecialistAvatar
                specialist={{ ...specialist, name: m.staffName ?? specialist.name, online: false }}
                size="sm"
              />
              <Bubble
                from="them"
                body={m.body}
                title={timeLabel(m.createdAt)}
                animate={i >= settledCount}
              />
            </div>
          )
        )}
        {pending.map((p) => (
          <div key={`p${p.key}`} className="flex flex-col items-end gap-1">
            <Bubble from="me" body={p.body} animate dim={!p.failed} />
            {p.failed && (
              <Button variant="text" onClick={() => retry(p)} className="text-[11px] !text-red">
                {"Didn't send · Retry"}
              </Button>
            )}
          </div>
        ))}
        {(sendingNow || (lastIsMine && justSent)) && (
          <div className="pr-1 text-right text-[11px] text-muted">
            {sendingNow ? 'Sending…' : 'Sent'}
          </div>
        )}
      </div>

      <div className="px-3 pb-3 pt-2">
        <div className="flex items-end gap-2 rounded-lg border border-surface3 bg-surface2 py-1.5 pl-3.5 pr-1.5 transition-[border-color,box-shadow] duration-150 focus-within:border-accent/50 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              grow(e.target)
            }}
            onKeyDown={onKey}
            rows={1}
            maxLength={SUPPORT_LIMITS.BODY_MAX}
            placeholder={`Message ${specialist.name}`}
            aria-label="Message your Specialist"
            className="min-h-[22px] flex-1 resize-none self-center bg-transparent py-1 text-[14px] leading-[1.45] text-on-surface placeholder:text-muted focus:outline-none"
          />
          <Button
            variant={draft.trim() ? 'primary' : 'secondary'}
            aria-label="Send"
            disabled={!draft.trim()}
            onClick={send}
            className="!h-8 !w-8 shrink-0 !rounded-full !p-0 transition-transform active:scale-95"
          >
            <ArrowUp size={16} strokeWidth={2.4} />
          </Button>
        </div>
      </div>
    </div>
  )
}

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0
  } catch {
    return 0
  }
}

function writeSeen(id: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(id))
  } catch {
    // Private mode: the badge just recounts next visit.
  }
}

export function SpecialistLauncher({
  client,
  openOnStart = false
}: {
  client: SupportClient
  openOnStart?: boolean
}): JSX.Element {
  const shared = useSupportState(client)
  const [open, setOpen] = useState(openOnStart)
  const [seenUpTo, setSeenUpTo] = useState(readSeen)
  const messages = shared.state?.messages ?? []
  const lastStaffId = messages.filter((m) => m.sender === 'staff').at(-1)?.id ?? 0
  const unread = open ? 0 : messages.filter((m) => m.sender === 'staff' && m.id > seenUpTo).length

  useEffect(() => {
    const openPanel = (): void => setOpen(true)
    window.addEventListener(OPEN_SPECIALIST_EVENT, openPanel)
    return () => window.removeEventListener(OPEN_SPECIALIST_EVENT, openPanel)
  }, [])

  useEffect(() => {
    if (open) void client.markSeen?.()
  }, [open, lastStaffId, client])

  const toggle = (): void => {
    setSeenUpTo(lastStaffId)
    writeSeen(lastStaffId)
    setOpen((o) => !o)
  }

  const specialist = shared.state?.specialist ?? {
    name: 'Your Specialist',
    photoUrl: null,
    online: false
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="h-[min(560px,calc(100dvh-120px))] w-[min(380px,calc(100vw-40px))] overflow-hidden rounded-lg border border-surface3 bg-bg shadow-popover max-[680px]:h-[calc(100dvh-40px)]">
          <SpecialistPanel client={client} onClose={toggle} shared={shared} />
        </div>
      )}
      <Button
        variant="bare"
        aria-label={open ? 'Close chat' : 'Ask a Specialist'}
        title={open ? undefined : `Ask ${specialist.name}, your Specialist`}
        onClick={toggle}
        className="rounded-full shadow-popover transition-transform hover:scale-105 active:scale-95 max-[680px]:hidden"
      >
        <SpecialistAvatar specialist={specialist} size="lg" unread={unread} />
      </Button>
    </div>
  )
}
