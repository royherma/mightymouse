import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  CANVAS_SANDBOX,
  canvasFailText,
  chatRan,
  isQuestion,
  localTags,
  type CanvasBubble,
  type CanvasFail,
  type CanvasLink,
  type CanvasState
} from '@shared/canvas'
import { RUN_EVENT, type MightySession } from '@shared/types'
import type { Point } from './layout'

const ANSWER_CHARS = 20000
const MEDIA_RE = /\.(png|jpe?g|gif|webp|mp4|mov|webm)$/i
const MD_IMAGE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g
const MEDIA_IN_TEXT = /(?:^|[\s(<"'`])(\/[^\s)>"'`]+\.(?:png|jpe?g|gif|webp|mp4|mov|webm))/gi
const CARD_CHARS = 900

export type CardPhase = 'reading' | 'filed' | 'pick' | 'working' | 'answered' | 'failed'

export interface LiveRun {
  phase?: string
  text: string
}

export interface DidCard {
  bubbleId: string
  phase: CardPhase
  picks?: string[]
  sent?: 'new' | 'continue'
  sentTo?: string
  answer?: string
  ran?: string
  sessionId?: string
  fail?: string
}

const plain = (md: string, max: number): string => {
  const t = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max).trimEnd()}...` : t
}

const shortMd = (md: string, max: number): string => {
  const t = md.trim()
  if (t.length <= max) return t
  const cut = t.lastIndexOf('\n', max)
  return `${t.slice(0, cut > max / 2 ? cut : max).trimEnd()}...`
}

const decodePath = (p: string): string => {
  try {
    return decodeURI(p.replace(/^file:\/\//, ''))
  } catch {
    return p
  }
}

/** Answer text without inline images; they show in the media strip instead. */
export const answerText = (md: string): string => md.replace(MD_IMAGE, '').trim()

export const mediaOf = (reply: string, artifacts: string[] = []): string[] =>
  [
    ...new Set(
      [
        ...artifacts,
        ...[...reply.matchAll(MD_IMAGE)].map((m) => m[1]),
        ...[...reply.matchAll(MEDIA_IN_TEXT)].map((m) => m[1])
      ]
        .map(decodePath)
        .filter((a) => a.startsWith('/') && MEDIA_RE.test(a))
    )
  ].slice(0, 4)

/** Older answers were saved cut at 900 chars; the chat itself still has the whole reply. */
export const fullAnswer = (text: string, s?: MightySession): string => {
  if (!s || !text.endsWith('...')) return text
  const head = text.slice(0, 60)
  const strip = (a: string): string => a.replace(/```[\s\S]*?```/g, '').trim()
  return s.turns.find((t) => strip(t.a).startsWith(head))?.a ?? text
}

export const chatTitle = (s?: MightySession): string =>
  s?.title && s.title !== 'Chat' ? s.title : 'Untitled chat'

const now = (): string => new Date().toISOString()
const uid = (): string => crypto.randomUUID()

interface Deps {
  canvasRef: MutableRefObject<CanvasState>
  update: (fn: (c: CanvasState) => CanvasState) => void
  quiet: (fn: (c: CanvasState) => CanvasState) => void
  sessionsRef: MutableRefObject<MightySession[]>
  setSessions: (s: MightySession[]) => void
  setPending: (fn: (p: Record<string, Point>) => Record<string, Point>) => void
  pos: MutableRefObject<Map<string, Point>>
  planetName: (id: string) => string
  onFiled: (planet: string) => void
}

/** Files a new bubble, runs its chat, and keeps the 'what I did' card in step with both. */
export function useDispatcher(d: Deps) {
  const [card, setCard] = useState<DidCard | null>(null)
  const [working, setWorking] = useState<Record<string, string>>({})
  const [live, setLive] = useState<Record<string, LiveRun>>({})
  const workingRef = useRef(working)
  workingRef.current = working
  useEffect(() => {
    const mine = (id?: string): id is string => !!id && id in workingRef.current
    const patch = (id: string, fn: (r: LiveRun) => LiveRun): void =>
      setLive((l) => ({ ...l, [id]: fn(l[id] ?? { text: '' }) }))
    const offPhase = window.api.mighty.onPhase((p) => {
      if (mine(p.clientRunId)) patch(p.clientRunId, (r) => ({ ...r, phase: p.phase }))
    })
    const offEvent = window.api.mighty.onEvent(({ clientRunId, event }) => {
      if (!mine(clientRunId) || event.kind !== RUN_EVENT.text) return
      patch(clientRunId, (r) => ({ ...r, text: `${r.text}${r.text ? '\n\n' : ''}${event.text}` }))
    })
    return () => {
      offPhase()
      offEvent()
    }
  }, [])
  const depsRef = useRef(d)
  depsRef.current = d
  const forced = useRef(new Map<string, string>())

  const patchCard = useCallback(
    (bubbleId: string, patch: Partial<DidCard>) =>
      setCard((c) => (c && c.bubbleId === bubbleId ? { ...c, ...patch } : c)),
    []
  )
  const setBubble = (id: string, patch: Partial<CanvasBubble>): void =>
    depsRef.current.quiet((c) => ({
      ...c,
      bubbles: c.bubbles.map((b) => (b.id === id ? { ...b, ...patch } : b))
    }))
  const stop = (id: string): void => {
    setWorking((w) => {
      const next = { ...w }
      delete next[id]
      return next
    })
    setLive((l) => {
      const next = { ...l }
      delete next[id]
      return next
    })
  }

  const runChat = useCallback(
    async (id: string, continueId?: string, asNew = false, message?: string) => {
      const { canvasRef, quiet: update, sessionsRef, setSessions, planetName } = depsRef.current
      const b = canvasRef.current.bubbles.find((x) => x.id === id)
      if (!b) return
      setBubble(id, continueId ? { stuck: undefined, sessionId: continueId } : { stuck: undefined })
      const sentTo = asNew ? undefined : continueId
      const where = sentTo
        ? chatTitle(sessionsRef.current.find((s) => s.id === sentTo))
        : planetName(b.planet)
      setWorking((w) => ({
        ...w,
        [id]: sentTo ? `Sent to ${where}` : `Working on it in ${where}`
      }))
      patchCard(id, {
        phase: 'working',
        sent: sentTo ? 'continue' : 'new',
        sentTo: sentTo ? where : undefined,
        fail: undefined
      })
      const projectId = b.planet === CANVAS_SANDBOX ? undefined : b.planet
      const target = continueId ? sessionsRef.current.find((s) => s.id === continueId) : undefined
      if (projectId && target && !target.projectId)
        await window.api.mighty.assignSessionProject(target.id, projectId)
      const run = await window.api.mighty.chat(
        message ?? b.text,
        continueId,
        b.attachments,
        projectId,
        undefined,
        id
      )
      stop(id)
      const planetNow = depsRef.current.canvasRef.current.bubbles.find((x) => x.id === id)?.planet
      if (run.sessionId && planetNow && planetNow !== CANVAS_SANDBOX) {
        const after = await window.api.mighty.getSession(run.sessionId)
        if (after && !after.projectId)
          await window.api.mighty.assignSessionProject(run.sessionId, planetNow)
      }
      const fresh = await window.api.mighty.listSessions()
      sessionsRef.current = fresh
      setSessions(fresh)
      const session = fresh.find((s) => s.id === run.sessionId)
      const ran = chatRan(session)
      const reply = run.error ? '' : (run.answer ?? '').trim()
      const fail: CanvasFail | undefined = run.error ?? (reply ? undefined : 'empty')
      update((c) => {
        const bubbles = [...c.bubbles]
        const links = [...c.links]
        if (reply) {
          const ans: CanvasBubble = {
            id: uid(),
            kind: 'answer',
            text: shortMd(reply, ANSWER_CHARS),
            media: mediaOf(reply, run.artifacts ?? []),
            planet: b.planet,
            tags: [],
            by: 'ai',
            created: now(),
            sessionId: run.sessionId,
            ran
          }
          bubbles.push(ans)
          links.push({ id: uid(), from: id, to: ans.id, why: 'answer', by: 'ai' })
        }
        return {
          ...c,
          links,
          bubbles: bubbles.map((x) =>
            x.id === id
              ? {
                  ...x,
                  sessionId: continueId ?? run.sessionId ?? x.sessionId,
                  stuck: fail ? { stage: 'chat', reason: fail } : undefined
                }
              : x
          )
        }
      })
      patchCard(id, {
        phase: fail ? 'failed' : 'answered',
        answer: reply ? plain(reply, CARD_CHARS) : undefined,
        ran,
        sessionId: run.sessionId,
        fail: fail ? canvasFailText('chat', fail) : undefined
      })
    },
    [patchCard]
  )

  const dispatch = useCallback(
    async (id: string) => {
      const { canvasRef, quiet: update, sessionsRef, setPending } = depsRef.current
      const b = canvasRef.current.bubbles.find((x) => x.id === id)
      if (!b) return
      setBubble(id, { stuck: undefined })
      setCard({ bubbleId: id, phase: 'reading' })
      const r = await window.api.canvas.think(b.text)
      setPending((p) => {
        const next = { ...p }
        delete next[id]
        return next
      })
      if (!r.ok) {
        const fail = canvasFailText('file', r.reason)
        setBubble(id, { stuck: { stage: 'file', reason: r.reason } })
        patchCard(id, { phase: 'failed', fail })
        return
      }
      const t = { ...r.thought, planet: forced.current.get(id) ?? r.thought.planet }
      forced.current.delete(id)
      depsRef.current.onFiled(t.planet)
      update((c) => {
        const bubbles = c.bubbles.map((x) =>
          x.id === id ? { ...x, planet: t.planet, tags: t.tags, directions: t.directions } : x
        )
        const links: CanvasLink[] = [
          ...c.links,
          ...t.related.map((rel) => ({
            id: uid(),
            from: id,
            to: rel.id,
            why: rel.why,
            by: 'ai' as const
          }))
        ]
        if (t.session) {
          const sessionId = t.session.id
          let thread = bubbles.find(
            (x) => x.id !== id && x.kind !== 'answer' && x.sessionId === sessionId
          )
          if (!thread) {
            thread = {
              id: uid(),
              kind: 'thread',
              text: chatTitle(sessionsRef.current.find((s) => s.id === sessionId)),
              planet: t.planet,
              tags: [],
              by: 'ai',
              created: now(),
              sessionId
            }
            bubbles.push(thread)
          }
          links.push({ id: uid(), from: thread.id, to: id, why: t.session.why, by: 'ai' })
        }
        return { ...c, bubbles, links }
      })
      const unsure = t.action === 'chat' && t.planet === CANVAS_SANDBOX && t.guesses.length > 0
      if (t.action === 'note' || unsure) {
        if (t.own) setBubble(id, { sessionId: t.own })
        patchCard(id, unsure ? { phase: 'pick', picks: t.guesses } : { phase: 'filed' })
        return
      }
      if (t.action === 'continue') await runChat(id, t.session?.id)
      else await runChat(id, t.own, true)
    },
    [patchCard, runChat]
  )

  const file = useCallback(
    (text: string, at: Point, extra: Partial<CanvasBubble> = {}, planet?: string) => {
      const { update, setPending, pos } = depsRef.current
      const b: CanvasBubble = {
        id: uid(),
        kind: isQuestion(text) ? 'question' : 'idea',
        text,
        planet: planet ?? CANVAS_SANDBOX,
        tags: localTags(text),
        by: 'you',
        created: now(),
        ...extra
      }
      if (planet) forced.current.set(b.id, planet)
      pos.current.set(b.id, { ...at })
      setPending((p) => ({ ...p, [b.id]: { ...at } }))
      update((c) => ({ ...c, bubbles: [...c.bubbles, b] }))
      void dispatch(b.id)
    },
    [dispatch]
  )

  const branch = useCallback(
    (sourceId: string, text: string, kind: 'ask' | 'note' | 'task', drop?: Point) => {
      const src = depsRef.current.canvasRef.current.bubbles.find((x) => x.id === sourceId)
      if (!src) return
      const b: CanvasBubble = {
        id: uid(),
        kind: kind === 'ask' ? 'question' : 'idea',
        text,
        planet: src.planet,
        tags: localTags(text),
        by: 'you',
        created: now(),
        ...(kind === 'ask' && src.sessionId ? { sessionId: src.sessionId } : {}),
        ...(kind === 'task' ? { task: true } : {}),
        ...(drop ? { at: { x: Math.round(drop.x), y: Math.round(drop.y) } } : {})
      }
      const at = drop ?? depsRef.current.pos.current.get(sourceId)
      if (at)
        depsRef.current.pos.current.set(b.id, drop ? { ...drop } : { x: at.x + 40, y: at.y + 60 })
      const why = kind === 'ask' ? 'follow-up' : kind === 'task' ? 'task' : ''
      depsRef.current.update((c) => ({
        ...c,
        bubbles: [...c.bubbles, b],
        links: [...c.links, { id: uid(), from: sourceId, to: b.id, why, by: 'you' }]
      }))
      if (kind === 'ask') {
        setCard({ bubbleId: b.id, phase: 'reading' })
        void runChat(b.id, src.sessionId)
      }
    },
    [runChat]
  )

  const startIn = useCallback(
    (planet: string, text: string, kind: 'ask' | 'note' | 'task', at: Point) => {
      const b: CanvasBubble = {
        id: uid(),
        kind: kind === 'ask' ? 'question' : 'idea',
        text,
        planet,
        tags: localTags(text),
        by: 'you',
        created: now(),
        ...(kind === 'task' ? { task: true } : {})
      }
      depsRef.current.pos.current.set(b.id, { ...at })
      depsRef.current.update((c) => ({ ...c, bubbles: [...c.bubbles, b] }))
      depsRef.current.onFiled(planet)
      if (kind !== 'ask') return
      setCard({ bubbleId: b.id, phase: 'reading' })
      void runChat(b.id, undefined, true)
    },
    [runChat]
  )

  const retry = useCallback(
    (id: string) => {
      const b = depsRef.current.canvasRef.current.bubbles.find((x) => x.id === id)
      if (!b?.stuck) return
      setCard({ bubbleId: id, phase: 'reading' })
      void (b.stuck.stage === 'file' ? dispatch(id) : runChat(id, b.sessionId))
    },
    [dispatch, runChat]
  )

  const askAi = useCallback(
    (id: string) =>
      void runChat(
        id,
        depsRef.current.canvasRef.current.bubbles.find((b) => b.id === id)?.sessionId
      ),
    [runChat]
  )

  const moveTo = useCallback((id: string, planet: string) => {
    const moved = depsRef.current.canvasRef.current.bubbles.filter(
      (x) => x.id === id || x.parent === id
    )
    for (const sid of new Set(moved.map((x) => x.sessionId).filter((x): x is string => !!x)))
      void window.api.mighty.assignSessionProject(
        sid,
        planet === CANVAS_SANDBOX ? undefined : planet
      )
    depsRef.current.update((c) => ({
      ...c,
      bubbles: c.bubbles.map((x) => (x.id === id || x.parent === id ? { ...x, planet } : x))
    }))
  }, [])

  const runIn = useCallback(
    (id: string, planet?: string) => {
      if (planet) moveTo(id, planet)
      void runChat(
        id,
        depsRef.current.canvasRef.current.bubbles.find((b) => b.id === id)?.sessionId,
        true
      )
    },
    [moveTo, runChat]
  )

  const unlink = useCallback((linkId: string) => {
    depsRef.current.update((c) => ({ ...c, links: c.links.filter((l) => l.id !== linkId) }))
  }, [])

  const askAbout = useCallback(
    (ids: string[], text: string, drop?: Point) => {
      const all = depsRef.current.canvasRef.current.bubbles
      const srcs = ids.flatMap((id) => all.filter((x) => x.id === id))
      if (!srcs.length) return
      const count = new Map<string, number>()
      for (const x of srcs) count.set(x.planet, (count.get(x.planet) ?? 0) + 1)
      const planet = [...count].sort((a, b) => b[1] - a[1])[0][0]
      const b: CanvasBubble = {
        id: uid(),
        kind: 'question',
        text,
        planet,
        tags: localTags(text),
        by: 'you',
        created: now(),
        ...(drop ? { at: { x: Math.round(drop.x), y: Math.round(drop.y) } } : {})
      }
      if (drop) depsRef.current.pos.current.set(b.id, { ...drop })
      depsRef.current.update((c) => ({
        ...c,
        bubbles: [...c.bubbles, b],
        links: [
          ...c.links,
          ...srcs.map((x) => ({ id: uid(), from: x.id, to: b.id, why: 'asked about', by: 'you' as const }))
        ]
      }))
      setCard({ bubbleId: b.id, phase: 'reading' })
      const notes = srcs.map((x) => `- ${x.text.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')
      void runChat(b.id, undefined, true, `${text}\n\nThis is about these notes:\n${notes}`)
    },
    [runChat]
  )

  return {
    card,
    setCard,
    working,
    live,
    file,
    retry,
    askAi,
    moveTo,
    runIn,
    unlink,
    branch,
    askAbout,
    startIn
  }
}
