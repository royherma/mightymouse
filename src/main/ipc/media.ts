/**
 * Media Library IPC — list/delete/reveal/enrich captures, app icon lookup,
 * waveform extraction, "chat with my media" (ranking + vision + LLM), and the
 * opt-in OS-screenshots toggle. Extracted verbatim from the old monolithic `ipc.ts`.
 */
import { ipcMain, shell } from 'electron'
import { dirname } from 'path'
import { CHANNELS } from '../../shared/ipc'
import { CONFIG } from '../../shared/config'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { listMedia, deleteMedia, enrichMedia, isMediaFolder, retranscribeMedia, warmMediaScanCache } from '../capture/media-library'
import { isOsScreenshot } from '../capture/os-screenshots'
import { resolveAppIcon } from '../capture/app-icon'
import { resolveFavicon } from '../capture/favicon'
import { resolveLinkPreview } from '../capture/link-preview'
import { cachedWaveform } from '../capture/waveform'
import { dismissRecoveredRecordings, getRecoveredRecordings } from '../capture/recording-recovery'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { runBackend } from '../backend/runner'
import { classifyRecallIntent } from '../backend/recall-classifier'
import { rankMediaForQuery, assembleMediaRecall, collectImagePaths } from '../backend/media-recall'
import { rankActivityForQuery, assembleActivityRecall } from '../backend/activity-recall'
import { readContextEventsInRange } from '../backend/context-memory'
import type { MediaChatResult, MediaChatPayload, MediaAttachment } from '../../shared/types'
import { parseDateRange } from '../backend/history-date-parser'
import { getSupabase } from '../supabase'

/**
 * Handle one turn of "chat with my media library". Flow:
 *
 *   1. Scan the media index (cheap, no LLM).
 *   2. Phase 2 — Query expansion: on the mightymouse backend, classifyRecallIntent
 *      returns expandedTerms (synonyms/related terms). Free backends skip this.
 *   3. Phase 3 — Field-weighted ranking: rankMediaForQuery scores items by tags×3,
 *      title/app×2, transcript/ocr×1 and returns the top N.
 *   3b. Phase 3b — Ambient activity: when the context-log is enabled, also rank the
 *      user's app/site activity (focus/text events) for the question and append it as
 *      a second evidence source. Lets "did I visit X" be answered from real browsing,
 *      not just captures. Date phrase in the question narrows the scan window.
 *   4. Phase 4 — Vision: collect screenshot imagePaths from the top items, encode as
 *      data URLs (http path) or raw paths (shell path) for the adapter to send.
 *      Recordings/dictation have no still image, so only screenshots contribute.
 *   5. Run the LLM with the assembled recall blob + images.
 *   6. Phase 5 — Map exit codes to typed errors; always return a MediaChatResult.
 *
 * Any classify failure or empty media set degrades gracefully — the question is still
 * answered, just without expansion / without citations when no captures match.
 */
async function chatWithMedia(payload: MediaChatPayload): Promise<MediaChatResult> {
  const { question } = payload
  const backend = PREFS.getBackend()
  const items = listMedia()

  // Phase 2 — query expansion (paid backend only; mirrors resolveRecall's fork)
  let expandedTerms: string[] = []
  if (backend === 'mightymouse') {
    try {
      const getJwt = async (): Promise<string> => {
        const { data } = await getSupabase().auth.getSession()
        return data.session?.access_token ?? ''
      }
      const c = await classifyRecallIntent(question, getJwt)
      // expandedTerms are synonyms/related terms for the query; empty on failure
      expandedTerms = c.expandedTerms
    } catch {
      // Any failure: degrade to raw question tokens (no expansion)
    }
  }

  // Phase 3 — field-weighted ranking
  const ranked = rankMediaForQuery(question, items, CONFIG.MEDIA_RECALL.TOP_N, expandedTerms)
  const citedFolders = ranked.map((it) => it.folder)
  const captureBlob = assembleMediaRecall(ranked, question, CONFIG.MEDIA_RECALL.RECALL_CHAR_BUDGET)

  // Phase 3b — ambient activity (apps/sites the user actually used). Only when the
  // context-log is enabled (opt-in). Captures alone can't answer "did I visit X" —
  // that lives in the focus/url log. The date phrase in the question ("yesterday")
  // narrows the scan; absent one, we look back ACTIVITY_LOOKBACK_DAYS.
  let activityBlob = ''
  if (PREFS.getContextLog()) {
    const range = parseDateRange(question)
    const startMs = range ? range.from.getTime() : Date.now() - CONFIG.MEDIA_RECALL.ACTIVITY_LOOKBACK_DAYS * 86400000
    const endMs = range ? range.to.getTime() : Date.now()
    const events = readContextEventsInRange(startMs, endMs)
    // dateScoped = the user named a window ("this morning"); a zero-match then means
    // "show me that window's activity", not "nothing found".
    const segments = rankActivityForQuery(events, question, expandedTerms, CONFIG.MEDIA_RECALL.ACTIVITY_TOP_N, range !== null)
    activityBlob = assembleActivityRecall(segments, CONFIG.MEDIA_RECALL.ACTIVITY_CHAR_BUDGET)
  }

  // Merge the two sources. Captures first (primary), activity second (supporting).
  const blob = activityBlob ? `${captureBlob}\n\n${activityBlob}` : captureBlob

  // Phase 4 — vision: recalled screenshots as image attachments. The adapter
  // translates per-backend (http data-URLs, codex -i, claude --add-dir).
  const imagePaths = collectImagePaths(ranked, CONFIG.MEDIA_RECALL.VISION_IMAGE_LIMIT)
  const imageAttachments: MediaAttachment[] = imagePaths.map((p) => ({ path: p, kind: 'image' }))

  return new Promise<MediaChatResult>((resolve) => {
    const runId = `media-chat:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`
    runBackend({
      backend: backend as import('../../shared/types').BackendId,
      runId,
      systemPrompt: CONFIG.SYSTEM_PROMPT_MEDIA_RECALL,
      userPrompt: `${blob}\n\nQuestion: ${question}`,
      runDir: PATHS.TMP,
      mode: 'ask',
      timeoutMs: CONFIG.MEDIA_RECALL.TIMEOUT_MS,
      lean: true,
      attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      onPhase: () => {},
      onDone: (result, exitCode) => {
        // Phase 5 — map exit codes to typed error states
        if (exitCode === 0 && result) {
          resolve({ answer: result.trim(), citedFolders })
          return
        }
        // Exit-code sentinels from runner.ts and adapters.ts:
        //   -3  EXIT_TIMEOUT  — wall-clock ceiling exceeded
        //   -2  out-of-credits (HTTP 402, set by the http adapter)
        //   -1 / other — generic failure
        const error: MediaChatResult['error'] =
          exitCode === -3 ? 'timeout' :
          exitCode === -2 ? 'oom_credits' :
          'failed'
        resolve({ answer: '', citedFolders: [], error })
      }
    })
  })
}

const MEDIA_WARM_DELAY_MS = 15_000

export function registerMediaHandlers(): void {
  setTimeout(warmMediaScanCache, MEDIA_WARM_DELAY_MS).unref?.()
  ipcMain.handle(CHANNELS.recoveredRecordingsGet, () => getRecoveredRecordings())
  ipcMain.handle(CHANNELS.recoveredRecordingsDismiss, () => dismissRecoveredRecordings())
  // Media Library: scan the captures dir into a sorted index. Read-only.
  ipcMain.handle(CHANNELS.mediaList, () => {
    track(ANALYTICS_EVENT.media_library_action, { kind: 'open' })
    return listMedia()
  })

  // Delete one capture folder (guarded to the captures dir in deleteMedia).
  ipcMain.handle(CHANNELS.mediaDelete, (_, folder: string) => {
    track(ANALYTICS_EVENT.media_library_action, { kind: 'delete' })
    return deleteMedia(folder)
  })

  // Reveal a capture folder in Finder. Guarded the same way deleteMedia() is —
  // folder must be a real media folder or an OS screenshot/recording, never an
  // arbitrary renderer-supplied path.
  ipcMain.handle(CHANNELS.mediaReveal, async (_, folder: string) => {
    if (!isMediaFolder(folder) && !isOsScreenshot(folder)) {
      console.error('mediaReveal rejected: not a recognized media path:', folder)
      return
    }
    try {
      await shell.openPath(folder)
    } catch (err) {
      console.error('mediaReveal failed:', err)
    }
  })

  // Compute (or read cached) free local enrichment for one capture: OCR + tags.
  ipcMain.handle(CHANNELS.mediaEnrich, (_, folder: string, force = false) =>
    enrichMedia(folder, force)
  )

  // Re-run whisper on a capture's audio, overwriting transcript.txt.
  ipcMain.handle(CHANNELS.mediaRetranscribe, (_, folder: string) => {
    track(ANALYTICS_EVENT.media_library_action, { kind: 'retranscribe' })
    return retranscribeMedia(folder)
  })

  // Resolve a macOS app's real icon to a cached PNG path (Media Library app filter).
  ipcMain.handle(CHANNELS.appIcon, (_, appName: string) => resolveAppIcon(appName))

  // Resolve a URL's site favicon to a cached PNG path (panel context row badge).
  ipcMain.handle(CHANNELS.favicon, (_, url: string) => resolveFavicon(url))
  ipcMain.handle(CHANNELS.linkPreview, (_, url: string) => resolveLinkPreview(url))

  // Waveform peaks for the Media Library. Decoded in main via ffmpeg — the renderer
  // can't fetch() media:// bytes (cross-origin to the custom scheme). Sidecar-cached
  // so each capture decodes at most once ever; list rows request these per row.
  // Guarded like mediaReveal above: a compromised renderer must not point ffmpeg
  // or the waveform.json write at an arbitrary path.
  ipcMain.handle(CHANNELS.mediaWaveform, (_, mediaPath: string) => {
    const folder = dirname(mediaPath)
    if (!isMediaFolder(folder) && !isOsScreenshot(folder)) {
      console.error('mediaWaveform rejected: not a recognized media path:', mediaPath)
      return [] // matches the Promise<number[]> contract; caller sees a flat/empty waveform
    }
    return cachedWaveform(folder, mediaPath)
  })

  // Chat with the media library: rank captures for the question, optionally expand
  // the query (paid backend), run the LLM with vision on top screenshots, and
  // return a typed result with the answer + cited folder paths.
  ipcMain.handle(CHANNELS.mediaChatWith, (_, payload: MediaChatPayload): Promise<MediaChatResult> => {
    track(ANALYTICS_EVENT.media_library_action, { kind: 'chat' })
    return chatWithMedia(payload)
  })

  // Opt-in: include the user's own macOS screenshots/recordings in the library.
  ipcMain.handle(CHANNELS.mediaGetOsScreenshots, () => PREFS.getOsScreenshots())
  ipcMain.handle(CHANNELS.mediaSetOsScreenshots, (_, on: boolean) => {
    PREFS.setOsScreenshots(on)
    track(ANALYTICS_EVENT.media_library_action, { kind: on ? 'os_on' : 'os_off' })
  })
}
