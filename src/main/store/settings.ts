import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PATHS } from './paths'
import { CONFIG } from '../../shared/config'
import { IS_DEVTEST } from '../../shared/env'
import { StoredSettings } from '../../shared/types'
import { resolveBinary } from '../platform'
import { PREFS } from './prefs'

export type { StoredSettings }

function defaults(): StoredSettings {
  return {
    ffmpegPath: CONFIG.FFMPEG_PATH,
    whisperPath: CONFIG.WHISPER_PATH,
    whisperModelPath: CONFIG.WHISPER_MODEL_PATH || PATHS.WHISPER_MODEL_DEFAULT,
    videoDevice: CONFIG.VIDEO_DEVICE,
    audioDevice: CONFIG.AUDIO_DEVICE,
    whisperLang: CONFIG.WHISPER_LANG,
    transcribeEngine: 'parakeet'
  }
}

/**
 * Fill in ffmpeg/whisper paths that are empty or point at a file that no longer
 * exists (fresh install, binary moved/uninstalled) by resolving them at runtime
 * (override → common install dirs → login-shell `which`; see resolve-binary.ts).
 * A stock Mac has neither binary at the old hardcoded Homebrew path, so trusting
 * a stale/empty stored value here is how capture used to silently no-op.
 */
function withResolvedBinaries(s: StoredSettings): StoredSettings {
  const ffmpegPath = existsSync(s.ffmpegPath)
    ? s.ffmpegPath
    : (resolveBinary('ffmpeg') ?? s.ffmpegPath)
  const whisperPath = existsSync(s.whisperPath)
    ? s.whisperPath
    : (resolveBinary('whisper-cli') ?? s.whisperPath)
  return ffmpegPath === s.ffmpegPath && whisperPath === s.whisperPath
    ? s
    : { ...s, ffmpegPath, whisperPath }
}

let cache: StoredSettings | null = null

export const SETTINGS = {
  get(): StoredSettings {
    if (cache) return cache
    const base = defaults()
    if (existsSync(PATHS.SETTINGS_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(PATHS.SETTINGS_FILE, 'utf-8'))
        const merged: StoredSettings = withResolvedBinaries({ ...base, ...raw })
        cache = merged
        return merged
      } catch (err) {
        console.error('Failed to read settings, using defaults:', err)
      }
    }
    cache = withResolvedBinaries(base)
    return cache
  },

  advancedMode(): boolean {
    if (IS_DEVTEST) return false
    const stored = this.get().advancedMode
    if (typeof stored === 'boolean') return stored
    const existingUser = Boolean(PREFS.getOnboardingComplete()) || existsSync(PATHS.HISTORY)
    this.set({ advancedMode: existingUser })
    return existingUser
  },

  set(patch: Partial<StoredSettings>): StoredSettings {
    const next = withResolvedBinaries({ ...this.get(), ...patch })
    cache = next
    try {
      writeFileSync(PATHS.SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to write settings:', err)
    }
    return next
  }
}
