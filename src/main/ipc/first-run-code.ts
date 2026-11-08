import { ipcMain } from 'electron'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { CHANNELS } from '../../shared/ipc'
import type { StartedAgent } from '../../shared/types'
import { MIGHTY } from '../store/mighty'
import { getCoordinationService } from '../agent-relay/mcp/http-listener'
import { BACKENDS } from '../backend/adapters'
import { showAgentInCodeTab } from '../mighty/mighty-window'

export interface FirstRunCodeProject {
  folder: string
  name: string
  updatedAt: string
  projectId?: string
}

function npmInstallOf(install: { npm: string } | { brew: string } | undefined): string {
  return install && 'npm' in install ? install.npm : ''
}

const SCAN_ROOTS = ['code', 'Developer', 'Desktop/Development', 'src', 'Projects']
const SCAN_BUDGET_MS = 300
const MAX_CANDIDATES = 5

function scanForRepos(deadline: number, taken: Set<string>): FirstRunCodeProject[] {
  const found: { folder: string; mtimeMs: number }[] = []
  for (const rel of SCAN_ROOTS) {
    if (Date.now() > deadline) break
    const root = join(homedir(), rel)
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (Date.now() > deadline) break
      const dir = join(root, entry)
      if (taken.has(dir)) continue
      let st
      try {
        st = statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      if (!existsSync(join(dir, '.git'))) continue
      found.push({ folder: dir, mtimeMs: st.mtimeMs })
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.map((f) => ({
    folder: f.folder,
    name: basename(f.folder),
    updatedAt: new Date(f.mtimeMs).toISOString()
  }))
}

function recentProjects(): FirstRunCodeProject[] {
  const out: FirstRunCodeProject[] = []
  const taken = new Set<string>()

  for (const p of MIGHTY.listProjects()) {
    if (!p.repoFolder || p.archived) continue
    if (taken.has(p.repoFolder)) continue
    taken.add(p.repoFolder)
    out.push({ folder: p.repoFolder, name: p.name, updatedAt: p.updated, projectId: p.id })
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))

  if (out.length < MAX_CANDIDATES) {
    const sessions = getCoordinationService()
      .snapshot()
      .sessions.filter((s) => s.cwd && !taken.has(s.cwd))
      .sort((a, b) => b.lastSeen - a.lastSeen)
    for (const s of sessions) {
      if (out.length >= MAX_CANDIDATES || !s.cwd) break
      taken.add(s.cwd)
      out.push({
        folder: s.cwd,
        name: s.projectName || basename(s.cwd),
        updatedAt: new Date(s.lastSeen).toISOString()
      })
    }
  }

  if (out.length < MAX_CANDIDATES) {
    const deadline = Date.now() + SCAN_BUDGET_MS
    for (const scanned of scanForRepos(deadline, taken)) {
      if (out.length >= MAX_CANDIDATES) break
      out.push(scanned)
    }
  }

  return out.slice(0, MAX_CANDIDATES)
}

export function registerFirstRunCodeHandlers(): void {
  ipcMain.handle(CHANNELS.firstRunCodeRecentProjects, () => recentProjects())

  ipcMain.handle(CHANNELS.firstRunCodeInstallCommands, () => ({
    claude: npmInstallOf(BACKENDS.claude.install),
    codex: npmInstallOf(BACKENDS.codex.install)
  }))

  ipcMain.handle(
    CHANNELS.firstRunCodeHandoff,
    (_e, input: { cwd: string; project: string; pane: string; message: string }) => {
      const started: StartedAgent = {
        cwd: input.cwd,
        project: input.project,
        pane: input.pane,
        message: input.message,
        files: [],
        since: Date.now()
      }
      showAgentInCodeTab(started)
      return true
    }
  )
}
