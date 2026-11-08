import type { CompanionState } from './companion-state'

/**
 * Live Voice Companion — barge-in decision.
 *
 * Speech-start while the mouse is mid-reply should cut it off, the way a person
 * stops talking when you start. Which cleanup that needs depends on what the
 * companion was doing, and the two cases are easy to conflate:
 *
 * - `talking` — a TTS clip is playing (or a no-audio read timer is running).
 *   Stop the audio AND clear the timer.
 * - `thinking` — no audio yet, but a turn is in flight whose reply will arrive
 *   after the interruption. Nothing to stop; the reply must be DROPPED instead,
 *   or the mouse answers a question the user already talked over.
 *
 * Kept out of CompanionApp.tsx so the rules are testable without a DOM, an
 * audio element, or a live mic.
 */
/**
 * Utterances that mean "stop what you're doing" and nothing else. Matched on the
 * WHOLE transcript, lowercased and stripped of punctuation — "stop" halts the run,
 * "stop, use the other tab" does not, because that one carries a new instruction
 * the agent should hear.
 *
 * Kept short on purpose. Every word added here is a word the user can no longer
 * start a real request with, and a false positive means a request silently
 * evaporates instead of running.
 */
const STOP_WORDS = new Set(['stop', 'wait', 'no', 'nope', 'cancel', 'halt', 'never mind', 'nevermind'])

/**
 * Does this transcript mean "stop" and nothing more?
 *
 * The distinction matters once a turn can DRIVE the Mac: "stop" must kill the run
 * and leave the screen where it is, while "no, the other tab" must kill the run AND
 * run as the next instruction. Treating both the same either strands a correction
 * or turns a panic-stop into another action.
 */
export function isStopUtterance(transcript: string): boolean {
  const cleaned = transcript.toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, ' ')
  return cleaned !== '' && STOP_WORDS.has(cleaned)
}

const WAKE_GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo'])
// Filler a transcriber puts in front of the name; only counts when a command follows.
const WAKE_FILLERS = new Set(['a', 'ah', 'uh', 'oh', 'hay', 'eh'])
const WAKE_NAMES = new Set(['mighty', 'mitey', 'mightie', 'mighti', 'm', 'em', 'emm'])
// How Parakeet mishears "Mighty" (accent, clipped); never accepted on their own.
const WAKE_MISHEARD = new Set(['marty', 'mit', 'mitty', 'mity', 'maddie', 'matey'])
// "Hey M open…" comes back as "Hey I'm open…"; only counts with a greeting AND a command.
const WAKE_M_SLURRED = new Set(['im', 'am'])
const COMMAND_WORDS = new Set([
  'open', 'close', 'quit', 'launch', 'start', 'stop', 'play', 'pause', 'resume', 'go', 'show', 'find',
  'search', 'switch', 'turn', 'set', 'type', 'send', 'read', 'write', 'make', 'take', 'put', 'move',
  'mute', 'unmute', 'skip', 'next', 'reply', 'call', 'text', 'email', 'check', 'look', 'bring', 'scroll', 'click', 'copy', 'paste', 'save', 'new'
])
const WAKE_SEARCH_WORDS = 3

export interface WakeMatch {
  addressed: boolean
  request: string
}

const normalizeWord = (w: string): string => w.toLowerCase().replace(/[^a-z]/g, '')

export function matchWakePhrase(transcript: string): WakeMatch {
  const words = transcript.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < Math.min(words.length, WAKE_SEARCH_WORDS); i++) {
    const name = normalizeWord(words[i])
    const exact = WAKE_NAMES.has(name)
    const slurred = WAKE_M_SLURRED.has(name)
    if (!exact && !slurred && !WAKE_MISHEARD.has(name)) continue
    const before = i > 0 ? normalizeWord(words[i - 1]) : ''
    let rest = i + 1
    if (normalizeWord(words[rest] ?? '') === 'mouse') rest++
    const commandNext = COMMAND_WORDS.has(normalizeWord(words[rest] ?? ''))
    const pausedAfter = /[,.!?]$/.test(words[rest - 1])
    const leads = i === 0 || WAKE_FILLERS.has(before)
    const addressed = slurred
      ? WAKE_GREETINGS.has(before) && commandNext
      : WAKE_GREETINGS.has(before) ||
      (leads && commandNext) ||
      (exact && i === 0 && (words.length === 1 || pausedAfter))
    if (!addressed) continue
    const request = words.slice(rest).join(' ').replace(/^[\s,.!?-]+/, '').trim()
    return { addressed: true, request }
  }
  return { addressed: false, request: '' }
}

// Split only when every later part starts with a command, so "salt and pepper" stays whole.
export function splitCommands(said: string): string[] {
  const parts = said.split(/\s*,?\s+(?:and then|and|then)\s+/i).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return [said]
  const allCommands = parts.slice(1).every((p) => COMMAND_WORDS.has(normalizeWord(p.split(/\s+/)[0])))
  return allCommands ? parts : [said]
}

export interface BargeInDecision {
  /** Stop in-flight TTS playback. */
  stopAudio: boolean
  /** Clear the pending settle-to-idle timer. */
  clearSettleTimer: boolean
  /** Invalidate the in-flight turn so its late reply is discarded. */
  supersedeTurn: boolean
  /**
   * Kill the backend run outright, not just its reply.
   *
   * Only `thinking` has one: by `talking` the run has already finished and the
   * only thing left is audio. Dropping the reply was enough when a turn could
   * only answer — a turn that CLICKS keeps clicking until the process dies.
   */
  abortRun: boolean
  /** True when this speech-start actually interrupted the companion — drives
   *  the debug stage event. A speech-start from `idle` is just a normal turn. */
  interrupted: boolean
}

const NO_INTERRUPTION: BargeInDecision = {
  stopAudio: false,
  clearSettleTimer: false,
  supersedeTurn: false,
  abortRun: false,
  interrupted: false
}

/**
 * What to tear down when the user starts speaking while the companion is in
 * `state`. Safe to call on every speech-start; returns a no-op decision for the
 * states where nothing is in flight.
 */
export function decideBargeIn(state: CompanionState): BargeInDecision {
  switch (state) {
    case 'talking':
      // Both, because `talking` covers two shapes: a real clip (stopAudio) and
      // the no-audio caption hold, which is a bare timer (clearSettleTimer).
      return {
        stopAudio: true,
        clearSettleTimer: true,
        supersedeTurn: true,
        // The run is already done — it produced the clip that's playing.
        abortRun: false,
        interrupted: true
      }
    case 'thinking':
      // A run is in flight. Superseding stops its reply from speaking; aborting
      // stops the run itself, which is the half that matters once it can click.
      return {
        stopAudio: false,
        clearSettleTimer: true,
        supersedeTurn: true,
        abortRun: true,
        interrupted: true
      }
    default:
      return NO_INTERRUPTION
  }
}

const echoKey = (w: string): string => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '')

export function wordSpan(text: string, from: number, to = 1): string {
  const words = text.split(/\s+/).filter(Boolean)
  const at = (f: number): number => Math.round(words.length * Math.min(1, Math.max(0, f)))
  return words.slice(at(from), at(to)).join(' ')
}

export function echoTail(text: string, from: number, lag: number, to = 1): string {
  return `${wordSpan(text, from - lag, from)}\n${wordSpan(text, from, to)}`
}

const echoKeys = (text: string): string[] => text.split(/[\s-]+/).map(echoKey).filter(Boolean)

export function stripEcho(heard: string, said: string): string {
  const saidKeys = echoKeys(said)
  if (!saidKeys.length) return heard.trim()
  const pairs = new Set(saidKeys.slice(1).map((k, i) => `${saidKeys[i]} ${k}`))
  const words = heard.split(/[\s-]+/).filter((w) => echoKey(w))
  const keys = words.map(echoKey)
  const pairAt = (i: number): boolean => i > 0 && pairs.has(`${keys[i - 1]} ${keys[i]}`)
  const lone = keys.length === 1 && echoKeys(said.slice(said.lastIndexOf('\n') + 1)).includes(keys[0])
  return words.filter((_, i) => !(lone || pairAt(i) || pairAt(i + 1))).join(' ')
}

export function loudMs(audio: Float32Array, floorRms: number, rate = 16000): number {
  const frame = Math.round(rate * 0.032)
  let loud = 0
  for (let i = 0; i + frame <= audio.length; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += audio[j] * audio[j]
    if (Math.sqrt(sum / frame) >= floorRms) loud++
  }
  return Math.round((loud * frame * 1000) / rate)
}
