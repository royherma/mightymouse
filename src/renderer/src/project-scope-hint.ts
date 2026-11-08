import { CONFIG } from '../../shared/config'

export function chatProjectSaveHint(projectName: string | undefined): string {
  if (projectName) {
    return CONFIG.UI_LABELS.CHAT_PROJECT_SAVES_UNDER.replace('{name}', projectName)
  }
  return CONFIG.UI_LABELS.CHAT_PROJECT_SAVES_UNASSIGNED
}
