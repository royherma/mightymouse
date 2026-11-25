import { BrowserWindow } from 'electron'
import { existsSync, realpathSync } from 'fs'
import { isAbsolute, resolve, sep } from 'path'
import { z } from 'zod'
import { CHANNELS } from '../../../shared/ipc'
import type { MightyProject } from '../../../shared/types'
import { MIGHTY } from '../../store/mighty'
import { copyProjectImage, discoverProjectImage, resolveProjectRepoFolder } from '../../store/project-image'
import type { VerbHandler } from './verbs'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function reply(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) }
}

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

function broadcastProjectsChanged(): void {
  for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.mightyProjectsChanged)
  }
}

function findProject(
  projects: MightyProject[],
  target: { project?: string; folder?: string; cwd?: string }
): MightyProject | null {
  if (target.project) {
    const wanted = target.project.trim().toLowerCase()
    return projects.find((p) => p.name.trim().toLowerCase() === wanted) ?? null
  }
  const dir = target.folder ?? target.cwd
  if (!dir) return null
  const norm = real(dir)
  let best: { project: MightyProject; len: number } | null = null
  for (const p of projects) {
    const repo = resolveProjectRepoFolder(p)
    if (!repo) continue
    const normRepo = real(repo)
    if (norm === normRepo) return p
    if (norm.startsWith(normRepo + sep) && (!best || normRepo.length > best.len)) {
      best = { project: p, len: normRepo.length }
    }
  }
  return best?.project ?? null
}

function applyProjectImage(project: MightyProject, sourcePath: string): MightyProject | null {
  const imagePath = copyProjectImage(project.id, sourcePath)
  if (!imagePath) return null
  const saved = MIGHTY.upsertProject({
    ...project,
    imagePath,
    imageRemoved: undefined,
    updated: new Date().toISOString()
  })
  if (saved) broadcastProjectsChanged()
  return saved
}

const setProjectIconSchema = {
  path: z
    .string()
    .optional()
    .describe(
      'Absolute path to an image file (.png, .jpg, .jpeg, .webp, .ico, .svg). Omit to auto-discover from the project folder or refresh missing project icons.'
    ),
  folder: z.string().optional().describe('Absolute path of the project folder. Defaults to your working directory.'),
  project: z.string().optional().describe('Project name in MightyMouse, if not targeting by folder.')
}

const setProjectIconHandler: VerbHandler<typeof setProjectIconSchema> = {
  description:
    'Set or refresh a project icon in the MightyMouse sidebar immediately. ' +
    'Pass `path` to apply a specific image file, or omit `path` to discover favicon/icon files in the project folder and refresh the sidebar.',
  inputSchema: setProjectIconSchema,
  run: async (args) => {
    const { path: imageFile, folder, project, cwd } = args as {
      path?: string
      folder?: string
      project?: string
      cwd?: string
    }
    const projects = MIGHTY.listProjects()
    const target = findProject(projects, { project, folder, cwd })

    if (imageFile) {
      if (!isAbsolute(imageFile) || !existsSync(imageFile)) {
        return reply(`No image file at ${imageFile}.`, true)
      }
      if (!target) {
        return reply(`No MightyMouse project matched ${project ?? folder ?? cwd ?? 'this folder'}.`, true)
      }
      const saved = applyProjectImage(target, imageFile)
      if (!saved) {
        return reply(`Unsupported image format for ${imageFile}. Use .png, .jpg, .jpeg, .webp, .ico, or .svg.`, true)
      }
      return reply(`Updated icon for ${saved.name} using ${imageFile}.`)
    }

    if (target) {
      const repo = resolveProjectRepoFolder(target)
      const discovered = repo ? discoverProjectImage(repo, target.name) : null
      if (discovered) {
        const saved = applyProjectImage(target, discovered)
        if (saved) return reply(`Updated icon for ${saved.name} from ${discovered}.`)
      }
      if (project || folder) {
        return reply(
          `No icon file found in ${repo ?? target.name}. Add favicon.png or favicon.svg there, or pass path.`,
          true
        )
      }
    } else if (project || folder) {
      return reply(`No MightyMouse project matched ${project ?? folder}.`, true)
    }

    const refreshed = MIGHTY.backfillProjectImages()
    if (refreshed > 0) broadcastProjectsChanged()
    return reply(`Refreshed ${refreshed} project ${refreshed === 1 ? 'icon' : 'icons'}.`)
  }
}

export const PROJECT_ICON_HANDLERS: Record<string, VerbHandler<z.ZodRawShape>> = {
  set_project_icon: setProjectIconHandler as unknown as VerbHandler<z.ZodRawShape>
}
