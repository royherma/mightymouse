export interface ConductorWorkspace {
  id: string
  title: string
  repo: string
  branch: string
  cwd: string
  archived: boolean
  updatedAt: string
  messages: number
}

export type ConductorContinueResult = { ok: true; pane: string } | { ok: false; reason: string }
