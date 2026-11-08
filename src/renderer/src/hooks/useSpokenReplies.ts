import { useCallback, useEffect, useRef, useState } from 'react'
import { alignWords, tokenIndexAt, type HighlightToken } from '../mighty/speech-highlight'

/**
 * "Read answers aloud" for a typing surface — voice as a MODE on chat rather than
 * a capability that only exists inside the companion overlay.
 *
 * Wraps the SAME `speakText` IPC the panel's per-bubble speak button already uses
 * (PanelApp.tsx's speakMessage), so this adds a trigger, not a second TTS path.
 * The toggle persists via PREFS so it survives a window close.
 *
 * Two rules the shape here enforces:
 * - Only ONE answer is ever speaking. A new turn cancels the previous one mid-
 *   sentence rather than overlapping two voices, which is unintelligible.
 * - A synthesis that's superseded while in flight is dropped on arrival (the token
 *   check), so a fast second turn can't be talked over by the first one's audio
 *   landing late.
 */
export interface SpokenReplies {
  /** Whether new answers are read aloud. */
  enabled: boolean
  /** Persist + apply a new setting. Turning it off stops anything mid-sentence. */
  setEnabled: (on: boolean) => void
  /** True while an answer is being synthesized or played. */
  speaking: boolean
  /** Speak `text` if enabled — a no-op otherwise, so callers need no branch. */
  speakIfEnabled: (text: string) => void
  /** Stop immediately (used by the toggle, and on unmount). */
  stop: () => void
  /** The text currently being read, or '' — lets a caller highlight the RIGHT
   *  message when several are on screen. */
  activeText: string
  /** Source tokens with their timings, empty when the voice supplied none
   *  (every rung but Kokoro) — then there is simply no highlight. */
  tokens: HighlightToken[]
  /** Index into `tokens` of the word being heard right now, or -1. */
  wordIndex: number
}

export function useSpokenReplies(): SpokenReplies {
  const [enabled, setEnabledState] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [activeText, setActiveText] = useState('')
  const [tokens, setTokens] = useState<HighlightToken[]>([])
  const [wordIndex, setWordIndex] = useState(-1)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef(0)
  // Bumped on every stop/new request; a synthesis whose token is stale on arrival
  // is discarded instead of played over whatever is current.
  const tokenRef = useRef(0)
  // Read in speakIfEnabled without making that callback depend on `enabled` — the
  // caller passes it to an effect, and a changing identity would re-fire the effect.
  const enabledRef = useRef(false)
  enabledRef.current = enabled

  useEffect(() => {
    void window.api.mighty.getSpeakReplies().then(setEnabledState)
  }, [])

  const stop = useCallback(() => {
    tokenRef.current++
    audioRef.current?.pause()
    audioRef.current = null
    cancelAnimationFrame(rafRef.current)
    setSpeaking(false)
    // Clear the highlight too, or the bubble stays frozen mid-sentence with one
    // word lit after the voice has stopped.
    setActiveText('')
    setTokens([])
    setWordIndex(-1)
  }, [])

  const setEnabled = useCallback(
    (on: boolean) => {
      setEnabledState(on)
      // Switching it off mid-answer means "be quiet now", not "finish this one".
      if (!on) stop()
      void window.api.mighty.setSpeakReplies(on)
    },
    [stop]
  )

  const speakIfEnabled = useCallback(
    (text: string) => {
      if (!enabledRef.current || text.trim() === '') return
      // Supersede whatever is currently speaking — one voice at a time.
      audioRef.current?.pause()
      audioRef.current = null
      const token = ++tokenRef.current
      cancelAnimationFrame(rafRef.current)
      setSpeaking(true)
      setWordIndex(-1)
      void window.api.speakText(text).then(({ dataUrl, words }) => {
        // Superseded while synthesizing, or no TTS voice available (no key) —
        // stay silent. A missing voice is a graceful no-op, never an error here.
        if (token !== tokenRef.current) return
        if (!dataUrl) {
          setSpeaking(false)
          return
        }
        // No timings (any rung but Kokoro) leaves this empty, and the bubble
        // renders normally — the answer is still read aloud, just not highlighted.
        const aligned = words?.length ? alignWords(text, words) : []
        setActiveText(aligned.length > 0 ? text : '')
        setTokens(aligned)

        const audio = new Audio(dataUrl)
        audioRef.current = audio
        const done = (): void => {
          if (token !== tokenRef.current) return
          cancelAnimationFrame(rafRef.current)
          setSpeaking(false)
          setActiveText('')
          setTokens([])
          setWordIndex(-1)
        }
        audio.onended = done
        audio.onerror = done

        // Driven by the element's OWN currentTime rather than a timer started at
        // play(): the two drift apart on any decode hiccup, and currentTime is
        // the only clock that matches what is actually being heard.
        if (aligned.length > 0) {
          const tick = (): void => {
            if (token !== tokenRef.current) return
            setWordIndex(tokenIndexAt(aligned, audio.currentTime))
            rafRef.current = requestAnimationFrame(tick)
          }
          rafRef.current = requestAnimationFrame(tick)
        }
        void audio.play().catch(done)
      })
    },
    []
  )

  // A window closed mid-answer must not keep talking.
  useEffect(() => stop, [stop])

  return { enabled, setEnabled, speaking, speakIfEnabled, stop, activeText, tokens, wordIndex }
}
