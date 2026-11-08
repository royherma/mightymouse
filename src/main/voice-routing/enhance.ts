import { randomUUID } from 'node:crypto'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import type { VoiceRouteEnhancePayload } from '../../shared/types'
import { EXIT_TIMEOUT, runBackend } from '../backend/runner'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { buildEnhancePrompt, parseEnhanceVariants, type EnhanceInput } from './enhance-prompt'

const ORIGINAL = -1

let slot: VoiceRouteEnhancePayload | null = null

function snapshot(s: VoiceRouteEnhancePayload): VoiceRouteEnhancePayload {
  return { ...s, variants: [...s.variants] }
}

function failureReason(exitCode: number, raw: string | null): string {
  if (exitCode === EXIT_TIMEOUT) return 'Took too long. Try again.'
  if (raw) return "Couldn't read the rewrite. Try again."
  return "Couldn't reach the model. Try again."
}

function start(runId: string, input: EnhanceInput, onChange: (p: VoiceRouteEnhancePayload) => void): void {
  const startedAt = Date.now()
  slot = { runId, status: 'running', kind: '', variants: [], selected: ORIGINAL, startedAt, tookMs: 0, reason: '' }
  onChange(snapshot(slot))
  const finish = (patch: Partial<VoiceRouteEnhancePayload>): void => {
    if (slot?.runId !== runId || slot.startedAt !== startedAt) return
    slot = { ...slot, ...patch, tookMs: Date.now() - startedAt }
    devLog.log(`[enhance] ${slot.status} kind=${slot.kind} ${slot.tookMs}ms`)
    onChange(snapshot(slot))
  }
  void runBackend({
    backend: PREFS.getBackend(),
    runId: `voice-enhance:${randomUUID()}`,
    systemPrompt: '',
    userPrompt: buildEnhancePrompt(input),
    runDir: PATHS.TMP,
    workDir: PATHS.TMP,
    timeoutMs: CONFIG.VOICE_ENHANCE.TIMEOUT_MS,
    mode: 'ask',
    fast: true,
    lean: true,
    disableTools: true,
    onPhase: () => {},
    onDone: (raw, exitCode) => {
      const parsed = raw ? parseEnhanceVariants(raw) : null
      if (parsed) finish({ status: 'done', kind: parsed.kind, variants: parsed.variants })
      else finish({ status: 'failed', reason: failureReason(exitCode, raw) })
    }
  }).catch(() => finish({ status: 'failed', reason: failureReason(0, null) }))
}

// select: undefined = ⌘E (start, retry, or three fresh ones once done); a number = a click on that row.
export function enhanceRoute(
  runId: string,
  input: () => EnhanceInput,
  onChange: (p: VoiceRouteEnhancePayload) => void,
  select?: number
): void {
  const current = slot?.runId === runId ? slot : null
  if (select === undefined) {
    if (current?.status === 'running') return
    start(runId, { ...input(), retake: current?.status === 'done' }, onChange)
    return
  }
  if (current?.status !== 'done') return
  if (select < ORIGINAL || select >= current.variants.length || select === current.selected) return
  slot = { ...current, selected: select }
  onChange(snapshot(slot))
}

export function variantText(runId: string, index: number, fallback: string): string {
  if (slot?.runId !== runId || slot.status !== 'done' || index === ORIGINAL) return fallback
  return slot.variants[index]?.text ?? fallback
}

export function chosenText(runId: string, fallback: string): string {
  if (slot?.runId !== runId || slot.status !== 'done' || slot.selected === ORIGINAL) return fallback
  return slot.variants[slot.selected]?.text ?? fallback
}

export function chosenVariantLabel(runId: string): string {
  if (slot?.runId !== runId || slot.status !== 'done' || slot.selected === ORIGINAL) return ''
  return slot.variants[slot.selected]?.label ?? ''
}
