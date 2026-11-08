import { existsSync, readFileSync, appendFileSync } from 'fs'
import { PATHS } from './paths'
import { PREFS } from './prefs'
import { SpeechEntry } from '../../shared/types'

// Dictation log — one row per listen/transcribe run. Kept separate from the
// run HISTORY so pure speech-to-text doesn't inflate the LLM run KPIs. See
// SpeechEntry + buildAnalyticsData's speech section.
export const SPEECH = {
  append(entry: SpeechEntry): void {
    if (PREFS.getIncognito()) return
    try {
      appendFileSync(PATHS.SPEECH, JSON.stringify(entry) + '\n', 'utf-8')
    } catch (err) {
      console.error('Failed to append to speech log:', err)
    }
  },

  readAll(): SpeechEntry[] {
    if (!existsSync(PATHS.SPEECH)) return []
    try {
      const out: SpeechEntry[] = []
      for (const line of readFileSync(PATHS.SPEECH, 'utf-8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          out.push(JSON.parse(t) as SpeechEntry)
        } catch {
          /* skip malformed */
        }
      }
      return out
    } catch (err) {
      console.error('Failed to read speech log:', err)
      return []
    }
  }
}
