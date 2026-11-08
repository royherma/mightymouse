import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { CHANNELS } from '../shared/ipc'
import { CONFIG } from '../shared/config'
import {
  EMPTY_CANVAS,
  firstJson,
  readThought,
  shortList,
  type CanvasBoardSummary,
  type CanvasDirectionsResult,
  type CanvasState,
  type CanvasThinkContext,
  type CanvasThinkResult
} from '../shared/canvas'
import { PATHS } from './store/paths'
import { MIGHTY } from './store/mighty'
import { askProxy } from './fast-rewrite'
import { hideCanvasWindow, showCanvasWindow } from './canvas-window'
import { isCurrentUserAdmin } from './auth'
import { projectIdentityPhrase } from './voice-routing/agent-sinks'

interface Board extends CanvasState {
  id: string
  created: string
  updated: string
}
interface BoardFile {
  version: 2
  current: string
  boards: Board[]
}

const newBoard = (): Board => {
  const at = new Date().toISOString()
  return { ...EMPTY_CANVAS, id: randomUUID(), created: at, updated: at }
}

function readFile(): BoardFile {
  const fresh = (): BoardFile => {
    const b = newBoard()
    return { version: 2, current: b.id, boards: [b] }
  }
  if (!existsSync(PATHS.CANVAS)) return fresh()
  try {
    const parsed = JSON.parse(readFileSync(PATHS.CANVAS, 'utf8'))
    if (parsed.version === 2 && Array.isArray(parsed.boards) && parsed.boards.length) return parsed
    if (Array.isArray(parsed.bubbles) && Array.isArray(parsed.links)) {
      const b = { ...newBoard(), bubbles: parsed.bubbles, links: parsed.links }
      return { version: 2, current: b.id, boards: [b] }
    }
  } catch {
    return fresh()
  }
  return fresh()
}

function writeFile(f: BoardFile): void {
  const tmp = `${PATHS.CANVAS}.tmp`
  writeFileSync(tmp, JSON.stringify(f))
  renameSync(tmp, PATHS.CANVAS)
}

const isBlank = (b: Board): boolean => b.bubbles.length === 0 && !b.strokes?.length
const currentOf = (f: BoardFile): Board => f.boards.find((b) => b.id === f.current) ?? f.boards[0]
const stateOf = (b: Board): CanvasState => ({
  version: 1,
  bubbles: b.bubbles,
  links: b.links,
  places: b.places,
  strokes: b.strokes,
  planets: b.planets
})

function load(): CanvasState {
  return stateOf(currentOf(readFile()))
}

function save(state: CanvasState): void {
  const f = readFile()
  const cur = currentOf(f)
  Object.assign(cur, {
    bubbles: state.bubbles,
    links: state.links,
    places: state.places,
    strokes: state.strokes,
    planets: state.planets,
    updated: new Date().toISOString()
  })
  writeFile(f)
}

/** Starts a fresh canvas; an already-empty current one is reused rather than piling up blanks. */
function startNew(): CanvasState {
  const f = readFile()
  if (isBlank(currentOf(f))) return EMPTY_CANVAS
  const b = newBoard()
  writeFile({ ...f, current: b.id, boards: [...f.boards, b] })
  return EMPTY_CANVAS
}

function listBoards(): CanvasBoardSummary[] {
  const f = readFile()
  return [...f.boards]
    .filter((b) => b.bubbles.length > 0 || b.id === f.current)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .map((b) => ({
      id: b.id,
      title: b.bubbles.find((x) => x.by === 'you')?.text.slice(0, 48) ?? 'New canvas',
      updated: b.updated,
      count: b.bubbles.filter((x) => !x.parent).length,
      current: b.id === f.current
    }))
}

function openBoard(id: string): CanvasState {
  const f = readFile()
  if (!f.boards.some((b) => b.id === id)) return stateOf(currentOf(f))
  const empty = currentOf(f)
  const boards = isBlank(empty) && empty.id !== id ? f.boards.filter((b) => b !== empty) : f.boards
  writeFile({ ...f, current: id, boards })
  return stateOf(boards.find((b) => b.id === id)!)
}

function foldersIn(repo: string): string[] {
  try {
    return readdirSync(repo, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !/^[._]|^node_modules$/.test(d.name))
      .map((d) => d.name.slice(0, 40))
      .slice(0, CONFIG.CANVAS.MAX_FOLDERS)
  } catch {
    return []
  }
}

async function think(text: string, state: CanvasState): Promise<CanvasThinkResult> {
  const said = text.trim().toLowerCase()
  const self = [...state.bubbles].reverse().find((b) => b.by === 'you' && b.text === text)
  const own = MIGHTY.listSessions().find(
    (s) =>
      !s.runId &&
      s.turns.length === 1 &&
      s.turns[0].a === '' &&
      s.turns[0].q.trim().toLowerCase() === said
  )
  const ctx: CanvasThinkContext = {
    projects: MIGHTY.listProjects()
      .filter((p) => !p.archived)
      .map((p) => ({
        id: p.id,
        name: p.name,
        about: `${projectIdentityPhrase(p.name, p.repoFolder ?? '')} ${(p.systemPrompt ?? '').slice(0, 200)}`.trim(),
        inside: p.repoFolder ? foldersIn(p.repoFolder) : []
      })),
    chats: MIGHTY.listSessions()
      .filter((s) => !s.archived && s.title && s.id !== own?.id)
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, CONFIG.CANVAS.MAX_CHATS)
      .map((c) => ({
        id: c.id,
        title: c.renamed || c.title,
        project: c.projectId ?? null,
        minutesAgo: Math.round((Date.now() - Date.parse(c.updated)) / 60_000)
      })),
    notes: state.bubbles
      .filter((b) => b.kind !== 'step' && b !== self)
      .slice(-CONFIG.CANVAS.MAX_BUBBLES)
      .map((b) => ({ id: b.id, text: b.text.slice(0, 160), planet: b.planet, tags: b.tags }))
  }
  const r = await askProxy({
    system: CONFIG.CANVAS.THINK_PROMPT,
    userPrompt: JSON.stringify({ note: text, ...ctx }),
    feature: 'ask',
    model: CONFIG.CANVAS.MODEL,
    timeoutMs: CONFIG.CANVAS.TIMEOUT_MS
  })
  if (!r.ok) return { ok: false, reason: r.reason }
  const thought = readThought(r.text, text, ctx)
  if (!thought) return { ok: false, reason: 'broken' }
  return { ok: true, thought: own ? { ...thought, own: own.id } : thought }
}

async function directions(idea: string, steps: string[]): Promise<CanvasDirectionsResult> {
  const r = await askProxy({
    system: CONFIG.CANVAS.DIRECTIONS_PROMPT,
    userPrompt: JSON.stringify({ idea, steps }),
    feature: 'ask',
    model: CONFIG.CANVAS.MODEL,
    timeoutMs: CONFIG.CANVAS.TIMEOUT_MS
  })
  if (!r.ok) return { ok: false, reason: r.reason }
  const list = shortList(firstJson(r.text)?.directions, 3)
  return list.length ? { ok: true, directions: list } : { ok: false, reason: 'broken' }
}

export function registerCanvasHandlers(): void {
  ipcMain.handle(CHANNELS.canvasLoad, () => load())
  ipcMain.handle(CHANNELS.canvasSave, (_e, state: CanvasState) => save(state))
  ipcMain.handle(CHANNELS.canvasThink, (_e, text: string) => think(text, load()))
  ipcMain.handle(CHANNELS.canvasDirections, (_e, idea: string, steps: string[]) =>
    directions(idea, steps)
  )
  ipcMain.handle(CHANNELS.canvasNew, () => startNew())
  ipcMain.handle(CHANNELS.canvasBoards, () => listBoards())
  ipcMain.handle(CHANNELS.canvasOpen, (_e, id: string) => openBoard(id))
  ipcMain.handle(CHANNELS.canvasHide, () => hideCanvasWindow())
  ipcMain.handle(CHANNELS.openCanvasWindow, async () => {
    if (await isCurrentUserAdmin()) showCanvasWindow()
  })
}
